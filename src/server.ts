/**
 * Complete server.ts - HSMS loopback + endpoints:
 *  - /send, /send-s1f1, /send-s1f2, /send-custom
 *  - /templates, /templates/:name, /send-template
 *
 * Requires:
 *  - src/template-manager.ts present (exports listTemplateNames, loadTemplate, substitutePlaceholders, sendTemplate)
 *  - templates/ JSON files in repo root (e.g. templates/S1F1.json)
 *  - public/ static UI files (index.html, app.js, style.css)
 */

import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';

const hsms: any = require('hsms-driver');

const {
  Config,
  ConnectionMode,
  Connection,
  DataItem,
  DataMessage,
  Message
} = hsms;

import { listTemplateNames, loadTemplate, sendTemplate } from './template-manager';

const app = express();
app.use(bodyParser.json());

// serve UI / static files
app.use(express.static('public'));

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const HSMS_PORT = Number(process.env.HSMS_PORT || 7000);

// pending replies map keyed by context
const pendingReplies: Map<number, { resolve: (v: any) => void; timeout: NodeJS.Timeout }> = new Map();

function formatItem(it: any, indent = '  '): string {
  try {
    if (!it) return `${indent}<null>`;
    // If it's a driver DataItem-like object with format/value/name
    if (it.name && it.format) {
      const fmt = String(it.format);
      // list detection (driver-specific); fallback if value is array
      if (fmt.toLowerCase().includes('list') || Array.isArray(it.value)) {
        const children = Array.isArray(it.value) ? it.value.map((c:any)=>formatItem(c, indent + '  ')).join('\n') : String(it.value);
        return `${indent}<L[${Array.isArray(it.value)?it.value.length:0}]>\n${children}\n${indent}>`;
      }
      if (fmt.toLowerCase().includes('b')) {
        const bytes = Buffer.isBuffer(it.value) ? Array.from(it.value).map(b => `0x${(b as number).toString(16).padStart(2, '0')}`).join(' ') : String(it.value);
        return `${indent}<B[${Buffer.isBuffer(it.value)?it.value.length:0}] ${bytes}>`;
      }
      return `${indent}<${fmt}[${Array.isArray(it.value)?it.value.length:1}] ${JSON.stringify(it.value)}>`;
    }

    // If it's the descriptor object we build (type/name/value)
    if (it.type) {
      const t = String(it.type).toUpperCase();
      if (t === 'LIST') {
        const children = (it.value||[]).map((c:any)=>formatItem(c, indent + '  ')).join('\n');
        return `${indent}<L[${(it.value||[]).length}]>\n${children}\n${indent}>`;
      }
      if (t === 'B' || t === 'BIN') {
        const bytes = Array.isArray(it.value) ? it.value.map((b:number)=>`0x${(b||0).toString(16).padStart(2,'0')}`).join(' ') : String(it.value);
        return `${indent}<B[${Array.isArray(it.value)?it.value.length:0}] ${bytes}>`;
      }
      if (t === 'BOOL_ARRAY') {
        const bs = Array.isArray(it.value) ? it.value.map((b:any)=>`0x${(b?1:0).toString(16).padStart(2,'0')}`).join(' ') : String(it.value);
        return `${indent}<Boolean[${Array.isArray(it.value)?it.value.length:0}] ${bs}>`;
      }
      if (t === 'A') {
        return `${indent}<A[${String(it.value || '').length}] "${String(it.value || '')}">`;
      }
      return `${indent}<${t}[${Array.isArray(it.value)?it.value.length:1}] ${Array.isArray(it.value)?JSON.stringify(it.value):it.value}>`;
    }

    // fallback
    return `${indent}${JSON.stringify(it)}`;
  } catch (e) {
    return `${indent}<err formatting item>`;
  }
}

function formatDataMessage(m: any): string {
  try {
    const header = m && m.toString ? m.toString() : 'DataMessage';
    let out = header + '\n';
    // try to find items array from driver (m.items) or from our descriptor (m.value)
    const items = m.items || m.value || [];
    if (Array.isArray(items) && items.length) {
      out += '<L[' + items.length + ']\n';
      out += items.map((it:any) => formatItem(it, '  ')).join('\n') + '\n';
      out += '>\n';
    } else {
      out += JSON.stringify(m);
    }
    return out;
  } catch (e) {
    return String(m);
  }
}

function wireConnection(conn: any, name: string) {
  conn.on('established', () => console.log(`${name} established`));
  conn.on('dropped', () => console.log(`${name} dropped`));

  conn.on('recv', (m: any) => {
    try {
      // pretty print DataMessage or control messages
      console.log(`${name} recv: ${m.toLongString ? m.toLongString() : (m.toString ? m.toString() : '')}`);
      // pretty structured print
      console.log(formatDataMessage(m));
    } catch {
      console.log(`${name} recv (toString): ${m.toString ? m.toString() : JSON.stringify(m)}`);
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

async function sendAndWaitIfNeeded(conn: any, msg: any, waitForReply = false, timeoutMs = 5000): Promise<any> {
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
// Supports common SECS-II types and LIST/BIN/BOOL_ARRAY
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
        return DataItemRef.u2 ? DataItemRef.u2(name, Number(val ?? 0)) : DataItemRef.a(name, String(Number(val ?? 0)), 2);
      case 'U4':
        return DataItemRef.u4 ? DataItemRef.u4(name, Number(val ?? 0)) : DataItemRef.a(name, String(Number(val ?? 0)), 4);
      case 'I2':
        return DataItemRef.i2 ? DataItemRef.i2(name, Number(val ?? 0)) : DataItemRef.i4 ? DataItemRef.i4(name, Number(val ?? 0)) : DataItemRef.a(name, String(Number(val ?? 0)), 2);
      case 'I4':
        return DataItemRef.i4 ? DataItemRef.i4(name, Number(val ?? 0)) : DataItemRef.a(name, String(Number(val ?? 0)), 4);
      case 'F4':
        return DataItemRef.f4 ? DataItemRef.f4(name, Number(val ?? 0)) : DataItemRef.a(name, String(Number(val ?? 0)), 4);
      case 'F8':
        return DataItemRef.f8 ? DataItemRef.f8(name, Number(val ?? 0)) : DataItemRef.a(name, String(Number(val ?? 0)), 8);
      case 'BOOL':
        return DataItemRef.bool ? DataItemRef.bool(name, Boolean(val)) : DataItemRef.a(name, String(Boolean(val)), 1);
      case 'BOOL_ARRAY':
        if (Array.isArray(val)) {
          // Try to build as a LIST of BOOLs if no direct bool-array support
          if (DataItemRef.boolArray) return DataItemRef.boolArray(name, val);
          return DataItemRef.list(name, ...val.map((b:any,i:number) => (DataItemRef.bool ? DataItemRef.bool(`${name}_${i}`, Boolean(b)) : DataItemRef.a(`${name}_${i}`, String(Boolean(b)), 1))));
        }
        return DataItemRef.a(name, String(val ?? ''), 1);
      case 'B':
      case 'BIN':
        if (Array.isArray(val)) {
          if (DataItemRef.b) return DataItemRef.b(name, Buffer.from(val));
          return DataItemRef.a(name, Buffer.from(val).toString('hex'), val.length);
        } else if (typeof val === 'string') {
          // allow hex string or comma separated decimals
          if (/[^0-9a-fA-F\s,]/.test(val)) {
            // treat as normal string
            return DataItemRef.a(name, val, val.length);
          }
          const nums = val.indexOf(',') >= 0 ? val.split(',').map(s=>Number(s.trim())) : undefined;
          if (nums && nums.every(n=>!Number.isNaN(n))) {
            if (DataItemRef.b) return DataItemRef.b(name, Buffer.from(nums));
            return DataItemRef.a(name, Buffer.from(nums).toString('hex'), nums.length);
          }
          // treat hex string
          const hex = val.replace(/[^0-9a-fA-F]/g,'');
          const buf = Buffer.from(hex, 'hex');
          if (DataItemRef.b) return DataItemRef.b(name, buf);
          return DataItemRef.a(name, buf.toString('hex'), buf.length);
        } else {
          return DataItemRef.a(name, String(val ?? ''), 0);
        }
      case 'LIST':
        return DataItemRef.list(name, ...buildDataItems(val || [], DataItemRef));
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

// Templates endpoints
app.get('/templates', (req, res) => {
  const names = listTemplateNames();
  res.json({ ok: true, templates: names });
});

app.get('/templates/:name', (req, res) => {
  const name = req.params.name;
  const tpl = loadTemplate(name);
  if (!tpl) return res.status(404).json({ ok: false, error: 'template not found' });
  res.json({ ok: true, template: tpl });
});

app.post('/send-template', async (req, res) => {
  const { name, templateInline, values, from } = req.body || {};
  if (!name && !templateInline) return res.status(400).json({ ok: false, error: 'require name or templateInline' });
  if (!from) return res.status(400).json({ ok: false, error: 'require from (host|device)' });

  const tpl = templateInline || loadTemplate(name);
  if (!tpl) return res.status(404).json({ ok: false, error: 'template not found' });

  try {
    const conn = from === 'host' ? hostConn : deviceConn;
    const result = await sendTemplate(tpl, values || {}, DataItem, DataMessage, conn, sendAndWaitIfNeeded);
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