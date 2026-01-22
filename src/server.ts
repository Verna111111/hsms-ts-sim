/**
 * hsms-ts-sim - loopback / host / device simulator with HTTP API
 *
 * Endpoints:
 *  - POST /send { from: "host"|"device", text: "...", waitReply?: boolean }
 *  - POST /send-s1f1 { from: "host"|"device", text: "...", waitReply?: boolean }
 *  - POST /send-s1f2 { from: "host"|"device", text: "..." }
 *  - GET  /status
 *
 * By default this starts a loopback pair (Active host <-> Passive device) on HSMS port 7000.
 *
 * Build & run:
 *  - npm install
 *  - npm run build
 *  - npm start
 *  or for dev: npm run dev
 */

import express from 'express';
import bodyParser from 'body-parser';

const hsms: any = require('hsms-driver');

const {
  Config,
  ConnectionMode,
  Connection,
  DataItem,
  DataMessage,
  Message
} = hsms;

const app = express();
app.use(bodyParser.json());

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const HSMS_PORT = Number(process.env.HSMS_PORT || 7000);

// pending replies map keyed by context
const pendingReplies: Map<number, { resolve: (v: any) => void; timeout: NodeJS.Timeout }> = new Map();

function wireConnection(conn: any, name: string) {
  conn.on('established', () => console.log(`${name} established`));
  conn.on('dropped', () => console.log(`${name} dropped`));
  conn.on('recv', (m: any) => {
    try {
      console.log(`${name} recv: ${m.toLongString ? m.toLongString() : m.toString()}`);
    } catch {
      console.log(`${name} recv (toString): ${m.toString ? m.toString() : JSON.stringify(m)}`);
    }

    // Simple auto-reply example:
    // If passive/device receives S1F1, reply with S1F1 response (builder.reply)
    if (m.kind === Message.Type.DataMessage && m.toString && m.toString() === 'S1F1') {
      const rsp = DataMessage.builder
        .reply(m)
        .items(DataItem.a('reply', 'OK', 2))
        .build();
      conn.send(rsp);
    }
  });

  conn.on('trx-complete', (primary: any, reply: any, tc: any) => {
    const ctx = primary && primary.context;
    if (ctx && pendingReplies.has(ctx)) {
      const entry = pendingReplies.get(ctx)!;
      clearTimeout(entry.timeout);
      entry.resolve({ primary, reply, tc });
      pendingReplies.delete(ctx);
    }
  });

  conn.on('error', (e: any) => console.error(`${name} error:`, e));
}

// start a loopback pair (passive + active) for local testing
function startLoopback() {
  const passiveCfg = Config.builder.ip('127.0.0.1').port(HSMS_PORT).mode(ConnectionMode.Passive).build();
  const activeCfg = Config.builder.ip('127.0.0.1').port(HSMS_PORT).mode(ConnectionMode.Active).build();

  const device = new Connection(passiveCfg);
  const host = new Connection(activeCfg);

  wireConnection(device, 'device(passive)');
  wireConnection(host, 'host(active)');

  device.start();
  host.start();

  return { device, host };
}

const { device: deviceConn, host: hostConn } = startLoopback();

async function sendAndWaitIfNeeded(conn: any, msg: any, waitForReply = false, timeoutMs = 5000) {
  const ctx = msg.context;
  if (waitForReply) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        pendingReplies.delete(ctx);
        reject(new Error('T3 timeout or no reply'));
      }, timeoutMs);

      pendingReplies.set(ctx, { resolve, timeout: to });
      try {
        conn.send(msg);
      } catch (e) {
        clearTimeout(to);
        pendingReplies.delete(ctx);
        reject(e);
      }
    });
  } else {
    conn.send(msg);
    return { status: 'sent' };
  }
}

// Generic /send: builds a DataMessage with stream 1 / function 1 by default
app.post('/send', async (req, res) => {
  const { from, text, waitReply } = req.body || {};
  if (!from || !text) return res.status(400).json({ error: 'require from and text' });

  const msg = DataMessage.builder
    .device(1)
    .stream(1)
    .func(1)
    .replyExpected(Boolean(waitReply))
    .items(DataItem.a('payload', text, Math.max(1, Math.min(255, text.length))))
    .build();

  try {
    const conn = from === 'host' ? hostConn : deviceConn;
    const result = await sendAndWaitIfNeeded(conn, msg, Boolean(waitReply), 10000);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// S1F1 example (stream 1 func 1)
// S1F1 is commonly a request that expects a reply (S1F2), but we demonstrate both
app.post('/send-s1f1', async (req, res) => {
  const { from, text, waitReply } = req.body || {};
  if (!from || !text) return res.status(400).json({ error: 'require from and text' });

  const msg = DataMessage.builder
    .device(1)
    .stream(1)
    .func(1) // S1F1
    .replyExpected(Boolean(waitReply))
    .items(DataItem.a('payload', text, Math.max(1, Math.min(255, text.length))))
    .build();

  try {
    const conn = from === 'host' ? hostConn : deviceConn;
    const result = await sendAndWaitIfNeeded(conn, msg, Boolean(waitReply), 10000);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// S1F2 example (stream 1 func 2) - typically a reply/alternate request depending on your use
app.post('/send-s1f2', async (req, res) => {
  const { from, text } = req.body || {};
  if (!from || !text) return res.status(400).json({ error: 'require from and text' });

  const msg = DataMessage.builder
    .device(1)
    .stream(1)
    .func(2) // S1F2
    .replyExpected(false)
    .items(DataItem.a('payload', text, Math.max(1, Math.min(255, text.length))))
    .build();

  try {
    const conn = from === 'host' ? hostConn : deviceConn;
    conn.send(msg);
    res.json({ ok: true, sent: 'S1F2' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/status', (req, res) => {
  res.json({
    http: `http://localhost:${HTTP_PORT}`,
    hsmsPort: HSMS_PORT,
    note: 'Check server console for events (established/recv/trx-complete)'
  });
});

app.listen(HTTP_PORT, () => {
  console.log(`HTTP API listening http://localhost:${HTTP_PORT}`);
});
