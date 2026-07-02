/**
 * bacnet-write: command a BACnet object's Present_Value with plain values.
 *
 * Designed so a Dashboard slider/switch/button wires straight in:
 *   msg.payload = 30        -> write 30 (Real for analog objects)
 *   msg.payload = true      -> write 1  (Enumerated for binary objects)
 *   msg.payload = null      -> RELINQUISH (write Null at the priority,
 *                              handing control back to the controller)
 *   msg.relinquish = true   -> same as payload null
 *   msg.priority = 12       -> override the configured priority for this msg
 *
 * Robustness:
 *   - coalescing "latest wins": while a write is in flight, rapid new values
 *     (a moving slider) replace the pending one instead of queueing — the
 *     device sees a smooth stream, never a backlog
 *   - limited retry with delay on failure, abandoned if a newer value arrived
 *   - output 2 carries write errors/lifecycle for alerting, same convention
 *     as the bacnet-cov node
 */

module.exports = function (RED) {
  'use strict';

  const PROP_PRESENT_VALUE = 85;

  // BACnet application tags
  const TAG_NULL = 0;
  const TAG_UNSIGNED = 2;
  const TAG_REAL = 4;
  const TAG_ENUMERATED = 9;

  const ANALOG = [0, 1, 2];
  const BINARY = [3, 4, 5];
  const MULTISTATE = [13, 14, 19];

  function BacnetWriteNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.shared = RED.nodes.getNode(config.client);
    node.deviceAddress = (config.deviceAddress || '').trim();
    node.objectType = parseInt(config.objectType, 10);
    node.objectInstance = parseInt(config.objectInstance, 10);
    node.priority = parseInt(config.priority, 10);
    if (isNaN(node.priority) || node.priority < 1 || node.priority > 16) node.priority = 8;
    node.retries = Math.max(0, parseInt(config.retries, 10) || 2);
    node.retryDelayMs = Math.max(100, parseInt(config.retryDelayMs, 10) || 1000);
    node.relinquishOnClose = !!config.relinquishOnClose;

    const objId = { type: node.objectType, instance: node.objectInstance };
    const objLabel = 'obj ' + node.objectType + ':' + node.objectInstance;

    let inFlight = false;
    let pending = null;     // latest-wins slot: { tagged, prio, msg }
    let closed = false;

    function statusEvent(event, detail, extra) {
      node.send([null, Object.assign({
        topic: 'bacnet-write/status',
        payload: { event: event, detail: detail || null, device: node.deviceAddress, object: objId, ts: Date.now() }
      }, extra || {})]);
    }

    /** Coerce a plain payload into a tagged BACnet value for this object. */
    function toTagged(payload, msg) {
      // relinquish forms
      if (payload === null || payload === undefined ||
          msg.relinquish === true ||
          (typeof payload === 'string' && payload.trim().toLowerCase() === 'relinquish')) {
        return { type: TAG_NULL, value: null, human: 'relinquish' };
      }
      // explicit tag override for special cases
      const forcedTag = parseInt(msg.tag, 10);

      let v = payload;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (typeof v === 'string') {
        const n = parseFloat(v.replace(',', '.'));
        if (isNaN(n)) return null;
        v = n;
      }
      if (typeof v !== 'number' || isNaN(v)) return null;

      let tag;
      if (!isNaN(forcedTag)) tag = forcedTag;
      else if (BINARY.includes(node.objectType)) tag = TAG_ENUMERATED;
      else if (MULTISTATE.includes(node.objectType)) tag = TAG_UNSIGNED;
      else if (ANALOG.includes(node.objectType)) tag = TAG_REAL;
      else tag = Number.isInteger(v) ? TAG_UNSIGNED : TAG_REAL;

      if (tag === TAG_ENUMERATED || tag === TAG_UNSIGNED) v = Math.round(v);
      if (tag === TAG_ENUMERATED) v = v ? 1 : 0;
      return { type: tag, value: v, human: String(v) };
    }

    function doWrite(job, attempt) {
      if (closed) return;
      inFlight = true;
      const client = node.shared.getClient();
      node.status({ fill: 'yellow', shape: 'ring', text: 'writing ' + job.tagged.human + ' @p' + job.prio });

      client.writeProperty(
        node.deviceAddress, objId, PROP_PRESENT_VALUE,
        [{ type: job.tagged.type, value: job.tagged.value }],
        { priority: job.prio },
        (err) => {
          if (closed) return;
          if (err) {
            // A newer value supersedes the failed one — skip retrying stale data.
            if (pending) { const nxt = pending; pending = null; return doWrite(nxt, 0); }
            if (attempt < node.retries) {
              node.status({ fill: 'yellow', shape: 'ring', text: 'retry ' + (attempt + 1) + '/' + node.retries });
              return setTimeout(() => doWrite(job, attempt + 1), node.retryDelayMs);
            }
            inFlight = false;
            node.status({ fill: 'red', shape: 'ring', text: 'write failed: ' + err.message });
            statusEvent('write-error', err.message, { _writeValue: job.tagged.human });
            node.error('BACnet write failed (' + objLabel + '): ' + err.message, job.msg);
            return;
          }
          // success
          const isRel = job.tagged.type === TAG_NULL;
          node.status({ fill: 'green', shape: 'dot', text: objLabel + (isRel ? ' released @p' + job.prio : ' = ' + job.tagged.human + ' @p' + job.prio) });
          const out = RED.util.cloneMessage(job.msg);
          out.payload = isRel ? null : job.tagged.value;
          out.ok = true;
          out.relinquished = isRel;
          out.object = objId;
          out.device = node.deviceAddress;
          out.priority = job.prio;
          node.send([out, null]);

          inFlight = false;
          if (pending) { const nxt = pending; pending = null; doWrite(nxt, 0); }
        }
      );
    }

    node.on('input', function (msg, send, done) {
      const tagged = toTagged(msg.payload, msg);
      if (tagged === null) {
        node.status({ fill: 'red', shape: 'ring', text: 'unusable payload' });
        node.warn('bacnet-write: payload is not a number/boolean/null: ' + JSON.stringify(msg.payload));
        return done && done();
      }
      let prio = parseInt(msg.priority, 10);
      if (isNaN(prio) || prio < 1 || prio > 16) prio = node.priority;

      const job = { tagged: tagged, prio: prio, msg: msg };
      if (inFlight) {
        pending = job;            // latest wins — replaces any older pending value
      } else {
        doWrite(job, 0);
      }
      done && done();
    });

    node.on('close', function (done) {
      closed = true;
      pending = null;
      if (node.relinquishOnClose && node.shared.client) {
        try {
          node.shared.client.writeProperty(
            node.deviceAddress, objId, PROP_PRESENT_VALUE,
            [{ type: TAG_NULL, value: null }], { priority: node.priority },
            () => done()
          );
          return;
        } catch (e) { /* fall through */ }
      }
      done();
    });

    if (!node.deviceAddress || isNaN(node.objectType) || isNaN(node.objectInstance)) {
      node.status({ fill: 'grey', shape: 'ring', text: 'not configured' });
    } else {
      node.status({ fill: 'grey', shape: 'dot', text: objLabel + ' ready @p' + node.priority });
    }
  }

  RED.nodes.registerType('bacnet-write', BacnetWriteNode);
};
