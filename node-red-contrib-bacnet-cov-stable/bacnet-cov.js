/**
 * node-red-contrib-bacnet-cov-stable
 *
 * A BACnet COV subscription node built around one idea: the subscription
 * lifecycle is the thing that fails in practice, so it is managed
 * relentlessly here:
 *
 *   - subscribe on deploy (and on demand via input msg)
 *   - renew the subscription well before its lifetime expires
 *   - exponential-backoff retry on any subscribe failure (never gives up)
 *   - confirmed-COV notifications are ACKed (so the device keeps sending)
 *   - clean cancel + socket close on redeploy/shutdown
 *   - second output reports lifecycle events (subscribed / renewed / error)
 *     so you can alarm on a dead subscription instead of going silent
 *
 * Tested against node-bacnet 0.2.4.
 */

module.exports = function (RED) {
  'use strict';

  const Bacnet = require('node-bacnet');

  const PROP_PRESENT_VALUE = 85;
  const PROP_STATUS_FLAGS = 111;
  const CONFIRMED_COV_NOTIFICATION = 1; // ConfirmedServiceChoice

  /* ------------------------------------------------------------------ *
   *  Config node: one shared UDP client per (interface, port)
   * ------------------------------------------------------------------ */
  function BacnetCovClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.port = parseInt(config.port, 10) || 47808;
    node.iface = (config.iface || '').trim() || undefined;
    node.broadcast = (config.broadcast || '').trim() || undefined;
    node.apduTimeout = parseInt(config.apduTimeout, 10) || 6000;

    node.client = null;
    node.users = new Map(); // subscriberProcessId -> subscriber node

    node.getClient = function () {
      if (node.client) return node.client;
      node.client = new Bacnet({
        port: node.port,
        interface: node.iface,
        broadcastAddress: node.broadcast,
        apduTimeout: node.apduTimeout,
        reuseAddr: true
      });

      // A UDP-level error must never crash Node-RED. Tell the
      // subscribers so they can flag it and re-establish.
      node.client.on('error', (err) => {
        node.error('BACnet client error: ' + (err && err.message));
        node.users.forEach((sub) => sub.onClientError(err));
      });

      const dispatch = (content, confirmed) => {
        const p = content && content.payload;
        if (!p) return;
        const sub = node.users.get(p.subscriberProcessId);

        // Confirmed notifications MUST be acked or the device will
        // retry, then may drop the subscription. Ack even if no local
        // subscriber matched (stale subscription on the device side).
        if (confirmed) {
          try {
            node.client.simpleAckResponse(
              content.header.sender,
              CONFIRMED_COV_NOTIFICATION,
              content.invokeId
            );
          } catch (e) {
            node.error('COV ack failed: ' + e.message);
          }
        }
        if (sub) sub.onNotification(p, confirmed);
      };

      node.client.on('covNotify', (content) => dispatch(content, true));
      node.client.on('covNotifyUnconfirmed', (content) => dispatch(content, false));
      return node.client;
    };

    node.register = function (procId, subNode) { node.users.set(procId, subNode); };
    node.deregister = function (procId) { node.users.delete(procId); };

    node.on('close', function (done) {
      node.users.clear();
      if (node.client) {
        try { node.client.close(); } catch (e) { /* already closed */ }
        node.client = null;
      }
      done();
    });
  }
  RED.nodes.registerType('bacnet-cov-client', BacnetCovClientNode);

  /* ------------------------------------------------------------------ *
   *  Subscriber node
   * ------------------------------------------------------------------ */
  function BacnetCovNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.shared = RED.nodes.getNode(config.client);
    node.deviceAddress = (config.deviceAddress || '').trim();
    node.objectType = parseInt(config.objectType, 10);
    node.objectInstance = parseInt(config.objectInstance, 10);
    node.lifetime = parseInt(config.lifetime, 10);
    if (isNaN(node.lifetime) || node.lifetime < 0) node.lifetime = 300;
    node.confirmed = !!config.confirmed;
    node.renewPercent = Math.min(90, Math.max(25, parseInt(config.renewPercent, 10) || 70));
    node.retryBaseSec = Math.max(2, parseInt(config.retryBaseSec, 10) || 5);
    node.retryMaxSec = Math.max(node.retryBaseSec, parseInt(config.retryMaxSec, 10) || 300);
    node.emitStatusEvents = config.emitStatusEvents !== false;

    // Stable, unique-per-node subscriber process id (BACnet Unsigned32).
    // Derived from the immutable node id so it survives redeploys —
    // a re-subscribe after restart *replaces* the old subscription on
    // the device instead of stacking a new one next to it.
    node.procId = (parseInt(String(node.id).replace(/[^0-9a-f]/gi, '').slice(-6), 16) % 0x3FFFF0) + 1;

    let renewTimer = null;
    let retryTimer = null;
    let retryCount = 0;
    let closed = false;
    let subscribed = false;
    let lastValue = null;

    const objId = { type: node.objectType, instance: node.objectInstance };
    const objLabel = 'obj ' + node.objectType + ':' + node.objectInstance;

    function statusEvent(event, detail) {
      if (!node.emitStatusEvents) return;
      node.send([null, {
        topic: 'bacnet-cov/status',
        payload: {
          event: event,                    // subscribed|renewed|error|notification-error|client-error|cancelled
          detail: detail || null,
          device: node.deviceAddress,
          object: objId,
          processId: node.procId,
          subscribed: subscribed,
          ts: Date.now()
        }
      }]);
    }

    function clearTimers() {
      if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }

    function scheduleRenew() {
      if (closed || node.lifetime === 0) return; // 0 = indefinite: no renewal needed
      const ms = Math.max(5, Math.floor(node.lifetime * node.renewPercent / 100)) * 1000;
      renewTimer = setTimeout(() => subscribe(true), ms);
    }

    function scheduleRetry(err) {
      if (closed) return;
      const delay = Math.min(node.retryMaxSec, node.retryBaseSec * Math.pow(2, retryCount)) * 1000;
      retryCount++;
      node.status({ fill: 'red', shape: 'ring', text: 'retry ' + retryCount + ' in ' + Math.round(delay / 1000) + 's' });
      statusEvent('error', (err && err.message) || String(err));
      retryTimer = setTimeout(() => subscribe(false), delay);
    }

    function subscribe(isRenewal) {
      if (closed) return;
      clearTimers();
      const client = node.shared.getClient();
      node.status({ fill: 'yellow', shape: 'ring', text: (isRenewal ? 'renewing' : 'subscribing') + '…' });

      // The actual (re)subscribe.
      const doSubscribe = () => {
        if (closed) return;
        client.subscribeCov(
          node.deviceAddress, objId, node.procId,
          false,                     // cancel = false -> (re)subscribe
          node.confirmed, node.lifetime,
          (err) => {
            if (closed) return;
            if (err) {
              subscribed = false;
              return scheduleRetry(err);
            }
            subscribed = true;
            retryCount = 0;
            node.status({
              fill: 'green', shape: 'dot',
              text: objLabel + (lastValue === null ? ' subscribed' : ' = ' + lastValue)
            });
            statusEvent(isRenewal ? 'renewed' : 'subscribed');
            scheduleRenew();
          }
        );
      };

      // On a FRESH subscribe (startup, forced re-subscribe, post-error) first
      // send a cancel for this procId+object. This clears any stale/dead
      // subscription the device may still hold from a previous session that
      // wasn't cleanly cancelled (e.g. a Node-RED crash, or a leftover entry
      // from another client). Without this, some devices (incl. the UWP 3.0)
      // ACK the new subscription but never deliver notifications — "subscribed"
      // but silent. Healthy renewals skip the cancel to avoid a delivery gap.
      if (isRenewal) {
        doSubscribe();
      } else {
        client.subscribeCov(
          node.deviceAddress, objId, node.procId,
          true,                      // cancel = true -> clear stale entry
          false, 0,
          () => { if (!closed) doSubscribe(); }   // ignore cancel result, then subscribe
        );
      }
    }

    node.onNotification = function (payload, confirmed) {
      // Filter to our monitored object (procId already matched upstream,
      // this guards against a device echoing with a different object).
      const mo = payload.monitoredObjectId;
      if (!mo || mo.type !== node.objectType || mo.instance !== node.objectInstance) return;

      let presentValue = null;
      let statusFlags = null;
      const all = {};
      (payload.values || []).forEach((entry) => {
        const vals = (entry.value || []).map((v) => v.value);
        const v = vals.length === 1 ? vals[0] : vals;
        all[entry.property.id] = v;
        if (entry.property.id === PROP_PRESENT_VALUE) presentValue = v;
        if (entry.property.id === PROP_STATUS_FLAGS) statusFlags = v;
      });

      // Some notifications carry only Status_Flags churn; still forward
      // them (msg.changed tells you whether Present_Value moved).
      const changed = presentValue !== null && presentValue !== lastValue;
      if (presentValue !== null) lastValue = presentValue;

      node.status({ fill: 'green', shape: 'dot', text: objLabel + ' = ' + lastValue });

      node.send([{
        topic: 'bacnet/' + node.objectType + ':' + node.objectInstance,
        payload: presentValue !== null ? presentValue : all,
        changed: changed,
        object: { type: mo.type, instance: mo.instance },
        device: node.deviceAddress,
        initiatingDeviceId: payload.initiatingDeviceId,
        statusFlags: statusFlags,
        properties: all,
        timeRemaining: payload.timeRemaining,
        confirmed: confirmed,
        processId: node.procId
      }, null]);
    };

    node.onClientError = function (err) {
      subscribed = false;
      statusEvent('client-error', err && err.message);
      scheduleRetry(err || new Error('client error'));
    };

    // An input message forces an immediate (re)subscribe — handy for
    // testing and for "kick it" recovery flows.
    node.on('input', function () {
      retryCount = 0;
      subscribe(false);
    });

    node.on('close', function (done) {
      closed = true;
      clearTimers();
      node.shared.deregister(node.procId);
      // Best-effort cancel so the device doesn't keep a dead subscription.
      if (subscribed && node.shared.client) {
        try {
          node.shared.client.subscribeCov(
            node.deviceAddress, objId, node.procId,
            true, false, 0,          // cancel = true
            () => done()
          );
          statusEvent('cancelled');
          return; // done() called in callback (or times out below)
        } catch (e) { /* fall through */ }
      }
      done();
    });

    // --- start ---
    if (!node.deviceAddress || isNaN(node.objectType) || isNaN(node.objectInstance)) {
      node.status({ fill: 'grey', shape: 'ring', text: 'not configured' });
      return;
    }
    node.shared.register(node.procId, node);
    // Small stagger so many nodes on one client don't burst at deploy.
    setTimeout(() => subscribe(false), 200 + Math.floor(Math.random() * 800));
  }
  RED.nodes.registerType('bacnet-cov', BacnetCovNode);
};
