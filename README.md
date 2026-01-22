# hsms-ts-sim

A small TypeScript example that demonstrates how to simulate HSMS host/device and expose an HTTP API to trigger HSMS messages.  
Uses megahoneybadger/hsms (published in this repo as `hsms-driver` via Git URL).

Features:
- Loopback pair (Active host <-> Passive device) started automatically for local testing.
- HTTP endpoints to send messages (generic, S1F1, S1F2).
- Option to wait for reply (uses message context + trx-complete event).
- TypeScript example with minimal type shim for `hsms-driver`.

## Prerequisites
- Node.js v16+
- npm

## Install & run
```bash
git clone https://github.com/Verna111111/hsms-ts-sim.git
cd hsms-ts-sim
npm install
npm run build
npm start
```
For development (no build step):
```bash
npm install
npm run dev
```

Server default:
- HTTP API: http://localhost:3000
- HSMS loopback port: 7000 (host(active) -> device(passive))

## Endpoints & examples

1) Generic send (S1F1 by default)
```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{"from":"host","text":"Hello from host","waitReply":false}'
```

2) S1F1 and wait for reply (set waitReply true). This demonstrates how to synchronously wait for a reply using the driver's `trx-complete` event and message context mapping:
```bash
curl -X POST http://localhost:3000/send-s1f1 \
  -H "Content-Type: application/json" \
  -d '{"from":"host","text":"Request S1F1","waitReply":true}'
```

3) S1F2 fire-and-forget:
```bash
curl -X POST http://localhost:3000/send-s1f2 \
  -H "Content-Type: application/json" \
  -d '{"from":"device","text":"Event S1F2"}'
```

4) Status:
```bash
curl http://localhost:3000/status
```

## How it works (high level)
- The project uses `hsms-driver` (the megahoneybadger/hsms repo) for HSMS framing, timers and connection state machine.
- A Passive connection (device) and an Active connection (host) are created and started. They connect to each other on localhost:7000.
- HTTP endpoints build DataMessage objects (using `DataMessage.builder` and `DataItem.*`) and send them through the respective Connection (`host` or `device`).
- If `waitReply` is requested, the server maps the outgoing message's context to a Promise and resolves it when `trx-complete` fires for that context (or times out).

## Extending
- To test with a real equipment, only create one Connection in Active mode and point `ip`/`port` to the real device. Remove the loopback passive instance.
- Add detailed TypeScript types for the `hsms-driver` API if you need stricter typing.
- Implement more advanced device behavior (specific replies for streams/functions) in the `recv` handler.

## Notes
- HSMS is TCP-based. The `hsms-driver` handles HSMS specifics — do not implement raw framing unless necessary.
- The example uses `DataItem.a` (ASCII) items for simplicity. Refer to the driver's README and tests for examples of `DataItem.u2`, `DataItem.list`, etc.
