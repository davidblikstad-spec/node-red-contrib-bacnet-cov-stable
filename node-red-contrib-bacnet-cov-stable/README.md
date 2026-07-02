# node-red-contrib-bacnet-cov-stable

A BACnet **COV subscription** node for Node-RED whose whole design goal is
that the subscription never silently dies. Built for (and tested against a
simulation of) the Carlo Gavazzi UWP 3.0, which supports COV on all its
BACnet objects.

## What it does

- Subscribes to Change-of-Value notifications for one BACnet object
- **Renews** the subscription at a configurable % of its lifetime
- **Retries with exponential backoff** on any failure — never gives up
- **ACKs confirmed** COV notifications so the device keeps sending
- **Cancels** the subscription cleanly on redeploy/shutdown
- Stable subscriber process-ID derived from the node ID, so a restart
  *replaces* the old subscription on the device instead of stacking new ones
- Output 2 emits lifecycle events (`subscribed`, `renewed`, `error`,
  `client-error`) — wire it to your alerting so a dead subscription is loud

## Install (on the Node-RED host)

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-bacnet-cov-stable
sudo systemctl restart nodered   # or node-red-restart
```

(Copy this folder to the Pi first, e.g.
`scp -r node-red-contrib-bacnet-cov-stable pi@10.11.4.175:~/`.)

## Configure

1. Add a **bacnet-cov-client** config node.
   - Local port default 47808. **If another BACnet package (e.g. the
     discovery nodes) is installed in the same Node-RED, set 47809** —
     two packages binding 47808 steal each other's packets, which is the
     single biggest cause of "flaky COV" reports. Notifications are
     unicast back to whatever port the subscription came from, so a
     non-standard port is fine.
2. Add a **bacnet cov** node:
   - Device addr: `10.11.100.152` (append `:port` only if non-standard)
   - Object type + instance: from your object scan (e.g. Binary Input 3,
     instance 48)
   - Lifetime `300` s, renew at `70` % (defaults) — the node re-subscribes
     every ~3.5 min; each renewal doubles as a liveness check of the device
   - Confirmed: on = device expects per-notification ACK (this node sends
     it). If the UWP misbehaves with confirmed, switch to unconfirmed —
     the renewal cycle still gives you liveness.

## Output 1 message

```
payload        Present_Value (0/1 for binary, float for analog, int for multi-state)
changed        true if Present_Value differs from the previous notification
statusFlags    decoded Status_Flags if present
properties     all properties in the notification, keyed by property id
timeRemaining  seconds left on the subscription (as reported by device)
```

Notifications that carry only Status_Flags churn are still forwarded with
`changed: false` — filter on `msg.changed` if you only want value edges.

## Output 2 message (lifecycle)

`payload.event`: `subscribed` | `renewed` | `error` | `client-error` |
`cancelled`, plus device/object/timestamps. Repeated `error` events mean
the device is unreachable and **no button presses are arriving** — that is
your cue to alert (SMS via your existing GatewayAPI flow, for instance).

## Testing

Send any message into the node's input → immediate forced re-subscribe.
Watch the node status: green dot `obj 3:48 = 1` on each notification.

---

## bacnet write (v1.1.0)

Commands **Present_Value** from plain input values — built to sit directly
behind a Dashboard slider, switch or button.

- `msg.payload = 30` → writes 30 (Real for analog objects)
- `msg.payload = true/false` → 1/0 (Enumerated for binary objects)
- `msg.payload = null` (or `msg.relinquish = true`) → **relinquish**: releases
  the priority slot so the controller's own logic takes back over
- `msg.priority = 12` → per-message priority override (default from config, 8)

**Latest-wins coalescing:** while a write is in flight, newer slider values
replace the queued one — 25 rapid inputs become ~2 writes, ending on the final
value. Failed writes retry (configurable) but never with stale data.

**Remember the relinquish.** A written value HOLDS at its priority until you
write null. If schedules/wall switches stop responding after a write, send
`payload: null`. Optional "relinquish on redeploy" checkbox in the node config.

Uses the same shared `bacnet-cov-client` config node (port 47809 advice
applies here too).
