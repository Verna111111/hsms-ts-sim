/**
 * server.ts - single entrypoint: only /send-template (templates management kept)
 *
 * Endpoints:
 *  - POST /send-template    (send by template name or inline template)
 *  - GET  /templates
 *  - GET  /templates/:name
 *  - GET  /status
 *
 * Loopback host<->device remains for local testing.
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
app.use(express.static('public'));

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const HSMS_PORT = Number(process.env.HSMS_PORT || 7000);

// pending replies map keyed by context
const pendingReplies: Map<number, { resolve: (v: any) => void; timeout: NodeJS.Timeout }> = new Map();

/* ---------- pretty formatter (keeps console readable) ---------- */
// 替換用：完整且已修正的 formatItem
function formatItem(it: any, indent = '  '): string {
  try {
    if (!it) return `${indent}<null>`;

    // 若物件是 driver DataItem-like (有 name 與 format)
    if (it.name && it.format) {
      const fmt = String(it.format).toLowerCase();

      // LIST-like (或 value 為陣列)
      if (fmt.includes('list') || Array.isArray(it.value)) {
        const children = Array.isArray(it.value)
          ? (it.value as any[]).map((c: any) => formatItem(c, indent + '  ')).join('\n')
          : String(it.value);
        return `${indent}<L[${Array.isArray(it.value) ? it.value.length : 0}]>\n${children}\n${indent}>`;
      }

      // Binary-like
      if (fmt.includes('b')) {
        const bytes = Buffer.isBuffer(it.value)
          ? Array.from(it.value as Buffer).map((b: number) => `0x${b.toString(16).padStart(2, '0')}`).join(' ')
          : String(it.value);
        const len = Buffer.isBuffer(it.value) ? (it.value as Buffer).length : 0;
        return `${indent}<B[${len}] ${bytes}>`;
      }

      // default for primitives
      const val = it.value;
      const count = Array.isArray(val) ? val.length : 1;
      return `${indent}<${it.format}[${count}] ${JSON.stringify(val)}>`;
    }

    // 若物件為我們自己描述的 descriptor (type/name/value)
    if (it.type) {
      const t = String(it.type).toUpperCase();

      if (t === 'LIST') {
        const children = (it.value || []).map((c: any) => formatItem(c, indent + '  ')).join('\n');
        return `${indent}<L[${(it.value || []).length}]>\n${children}\n${indent}>`;
      }

      if (t === 'B' || t === 'BIN') {
        const bytes = Array.isArray(it.value)
          ? (it.value as number[]).map((b: number) => `0x${(b || 0).toString(16).padStart(2, '0')}`).join(' ')
          : String(it.value);
        return `${indent}<B[${Array.isArray(it.value) ? it.value.length : 0}] ${bytes}>`;
      }

      if (t === 'BOOL_ARRAY') {
        const bs = Array.isArray(it.value)
          ? (it.value as any[]).map((b: any) => `0x${(b ? 1 : 0).toString(16).padStart(2, '0')}`).join(' ')
          : String(it.value);
        return `${indent}<Boolean[${Array.isArray(it.value) ? it.value.length : 0}] ${bs}>`;
      }

      if (t === 'A') {
        const s = String(it.value ?? '');
        return `${indent}<A[${s.length}] "${s}">`;
      }

      // fallback for other primitive types
      const fallbackVal = Array.isArray(it.value) ? JSON.stringify(it.value) : it.value;
      const fallbackCount = Array.isArray(it.value) ? it.value.length : 1;
      return `${indent}<${t}[${fallbackCount}] ${fallbackVal}>`;
    }

    // ultimate fallback
    return `${indent}${JSON.stringify(it)}`;
  } catch (e) {
    return `${indent}<err formatting item>`;
  }
}

function formatDataMessage(m: any): string {
  try {
    const header = m && m.toString ? m.toString() : 'DataMessage';
    let out = header + '\n';
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

/* ---------- HSMS wiring ---------- */
function wireConnection(conn: any, name: string) {
  conn.on('established', () => console.log(`${name} established`));
  conn.on('dropped', () => console.log(`${name} dropped`));

  conn.on('recv', (m: any) => {
    try {
      console.log(`${name} recv: ${m.toLongString ? m.toLongString() : (m.toString ? m.toString() : '')}`);
      console.log(formatDataMessage(m));
    } catch {
      console.log(`${name} recv (toString): ${m.toString ? m.toString() : JSON.stringify(m)}`);
    }

    // auto-reply example for S1F1 -> S1F2(OK)
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
        try { console.log('Sending (wait):', msg.toLongString ? msg.toLongString() : msg.toString ? msg.toString() : JSON.stringify(msg)); } catch {}
        conn.send(msg);
      } catch (e) {
        clearTimeout(to);
        pendingReplies.delete(ctx);
        reject(e);
      }
    });
  } else {
    try { console.log('Sending:', msg.toLongString ? msg.toLongString() : msg.toString ? msg.toString() : JSON.stringify(msg)); } catch {}
    conn.send(msg);
    return { status: 'sent' };
  }
}

/* ---------- placeholder finder ---------- */
function findPlaceholders(obj: any, found = new Set<string>()): Set<string> {
  if (obj === null || obj === undefined) return found;
  if (typeof obj === 'string') {
    const m = obj.match(/^{{\s*([^}]+)\s*}}$/);
    if (m) found.add(m[1]);
    return found;
  }
  if (Array.isArray(obj)) {
    obj.forEach(i => findPlaceholders(i, found));
    return found;
  }
  if (typeof obj === 'object') {
    Object.values(obj).forEach(v => findPlaceholders(v, found));
  }
  return found;
}

/* ---------- Templates endpoints ---------- */
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

/* ---------- send-template: single entrypoint ---------- */
app.post('/send-template', async (req, res) => {
  console.log('/send-template called, body=', JSON.stringify(req.body));
  const { name, templateInline, values, from } = req.body || {};
  if (!name && !templateInline) return res.status(400).json({ ok: false, error: 'require name or templateInline' });
  if (!from) return res.status(400).json({ ok: false, error: 'require from (host|device)' });

  const tpl = templateInline || loadTemplate(name);
  if (!tpl) return res.status(404).json({ ok: false, error: 'template not found' });

  // detect placeholders and validate provided values
  const placeholders = Array.from(findPlaceholders(tpl));
  const missing = placeholders.filter(k => (values || {})[k] === undefined);
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'Missing template values: ' + missing.join(', ') });
  }

  try {
    const conn = from === 'host' ? hostConn : deviceConn;
    if (!conn) return res.status(400).json({ ok:false, error: 'connection not started' });

    console.log('Template to send:', name || '<inline>');
    console.log('Values:', JSON.stringify(values || {}));

    const result = await sendTemplate(tpl, values || {}, DataItem, DataMessage, conn, sendAndWaitIfNeeded);

    console.log('sendTemplate result=', result);
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error('send-template failed:', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* ---------- status ---------- */
app.get('/status', (req, res) => {
  res.json({
    http: `http://localhost:${HTTP_PORT}`,
    hsmsPort: HSMS_PORT,
    note: 'Check server console for HSMS events'
  });
});

/* ---------- start server ---------- */
app.listen(HTTP_PORT, () => {
  console.log(`HTTP API listening http://localhost:${HTTP_PORT}`);
});