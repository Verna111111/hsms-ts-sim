/**
 * Complete server.ts with HSMS loopback + /send, /send-s1f1, /send-s1f2 and /send-custom.
 * Replace your current src/server.ts with this file, then run `npm run build` and `npm start`.
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

app.use(express.static('public'));

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

    // Structure print of items if DataMessage
    if (m && m.kind === Message.Type.DataMessage && Array.isArray(m.items)) {
      const items = m.items.map((it: any) => ({
        name: it.name,
        format: it.format,
        value: it.value,
        size: it.size
      }));
      console.log(`${name} recv items:`, JSON.stringify(items, null, 2));
    }

    // Simple auto-reply example for S1F1: reply 'OK'
    if (m && m.kind === Message.Type.DataMessage && m.toString && m.toString() === 'S1F1') {
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
// Helper: build DataItems from an "items" description array.
// Returns an array of DataItem objects (type any[] for TS strict)
function buildDataItems(items: any[], DataItemRef: any): any[] {
  if (!items || !Array.isArray(items)) return [];
  return items.map((it: any): any => {
    const t = (it.type || 'A').toString().toUpperCase();
    const name = it.name || 'item';
    const val = it.value;
    switch (t) {
      case 'A':
        return DataItemRef.a(name, String(val ?? ''), it.size || Math.max(1, String(val ?? '').length));
      case 'U2':
        return DataItemRef.u2(name, Number(val ?? 0));
      case 'U4':
        return DataItemRef.u4(name, Number(val ?? 0));
      case 'I4':
        return DataItemRef.i4(name, Number(val ?? 0));
      case 'F4':
        return DataItemRef.f4(name, Number(val ?? 0));
      case 'F8':
        return DataItemRef.f8(name, Number(val ?? 0));
      case 'BOOL':
        return DataItemRef.bool ? DataItemRef.bool(name, Boolean(val)) : DataItemRef.a(name, String(Boolean(val)), 1);
      case 'LIST':
        return DataItemRef.list(name, ...(buildDataItems(val || [], DataItemRef)));
      default:
        return DataItemRef.a(name, String(val ?? ''), it.size || Math.max(1, String(val ?? '').length));
    }
  });
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

app.post('/send-s1f1', async (req, res) => {
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

app.post('/send-s1f2', async (req, res) => {
  const { from, text } = req.body || {};
  if (!from || !text) return res.status(400).json({ error: 'require from and text' });

  const msg = DataMessage.builder
    .device(1)
    .stream(1)
    .func(2)
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

// NEW: /send-custom - arbitrary stream/func and flexible items
app.post('/send-custom', async (req, res) => {
  const { from, stream, func, items, waitReply } = req.body || {};
  if (!from || stream == null || func == null) {
    return res.status(400).json({ error: 'require from, stream, func' });
  }

  try {
    const builtItems = buildDataItems(items || [{ type: 'A', name: 'payload', value: 'payload' }], DataItem);
    const msg = DataMessage.builder
      .device(1)
      .stream(Number(stream))
      .func(Number(func))
      .replyExpected(Boolean(waitReply))
      .items(...builtItems)
      .build();

    const conn = from === 'host' ? hostConn : deviceConn;
    if (!conn) return res.status(400).json({ error: 'connection not started' });

    const result = await sendAndWaitIfNeeded(conn, msg, Boolean(waitReply), 10000);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/status', (req, res) => {
  res.json({
    http: `http://localhost:${HTTP_PORT}`,
    hsmsPort: HSMS_PORT,
    note: 'Check server console for HSMS events'
  });
});

app.listen(HTTP_PORT, () => {
  console.log(`HTTP API listening http://localhost:${HTTP_PORT}`);
});