import fs from 'fs';
import path from 'path';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');

export function listTemplateNames(): string[] {
  try {
    const files = fs.readdirSync(TEMPLATES_DIR);
    return files.filter(f => f.toLowerCase().endsWith('.json')).map(f => f);
  } catch (e) {
    return [];
  }
}

export function loadTemplate(name: string): any | null {
  try {
    const p = path.join(TEMPLATES_DIR, name);
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Substitute placeholders in template (supports {{key}} and placeholder_key)
// values: object mapping keys -> actual values (strings, numbers, arrays)
export function substitutePlaceholders(obj: any, values: Record<string, any>): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // {{key}} style
    const m = obj.match(/^{{\s*([^}]+)\s*}}$/);
    if (m) {
      const k = m[1];
      return values[k] !== undefined ? values[k] : obj;
    }
    // placeholder_key style
    const ph = obj.match(/^placeholder_(.+)$/);
    if (ph) {
      const k = ph[1];
      return values[k] !== undefined ? values[k] : obj;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(i => substitutePlaceholders(i, values));
  }
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = substitutePlaceholders(v, values);
    }
    return out;
  }
  return obj;
}

// Build DataMessage and send it using existing hsms objects.
// Parameters:
// - templateObj: parsed JSON template (with stream/func/items)
// - values: mapping of placeholders to concrete values
// - DataItemRef, DataMessageRef: from hsms-driver
// - conn: Connection instance (hostConn or deviceConn)
// - sendAndWaitIfNeeded: function already present in server.ts to handle waitReply
export async function sendTemplate(
  templateObj: any,
  values: Record<string, any>,
  DataItemRef: any,
  DataMessageRef: any,
  conn: any,
  sendAndWaitIfNeeded: (c: any, m: any, w: boolean, t?: number) => Promise<any>
) {
  const substituted = substitutePlaceholders(templateObj, values || {});
  const itemsDesc = substituted.items || [];
  // buildDataItems logic - we reuse a compact builder here to avoid circular import
  function buildDataItems(items: any[], DataItem: any): any[] {
    if (!items || !Array.isArray(items)) return [];
    return items.map((it: any): any => {
      const t = (it.type || 'A').toString().toUpperCase();
      const name = it.name || 'item';
      const val = it.value;
      switch (t) {
        case 'A':
          return DataItem.a(name, String(val ?? ''), it.size || Math.max(1, String(val ?? '').length));
        case 'U2':
          return DataItem.u2 ? DataItem.u2(name, Number(val ?? 0)) : DataItem.a(name, String(Number(val ?? 0)), 2);
        case 'U4':
          return DataItem.u4 ? DataItem.u4(name, Number(val ?? 0)) : DataItem.a(name, String(Number(val ?? 0)), 4);
        case 'I2':
          return DataItem.i2 ? DataItem.i2(name, Number(val ?? 0)) : DataItem.i4 ? DataItem.i4(name, Number(val ?? 0)) : DataItem.a(name, String(Number(val ?? 0)), 2);
        case 'I4':
          return DataItem.i4 ? DataItem.i4(name, Number(val ?? 0)) : DataItem.a(name, String(Number(val ?? 0)), 4);
        case 'F4':
          return DataItem.f4 ? DataItem.f4(name, Number(val ?? 0)) : DataItem.a(name, String(Number(val ?? 0)), 4);
        case 'F8':
          return DataItem.f8 ? DataItem.f8(name, Number(val ?? 0)) : DataItem.a(name, String(Number(val ?? 0)), 8);
        case 'BOOL':
          return DataItem.bool ? DataItem.bool(name, Boolean(val)) : DataItem.a(name, String(Boolean(val)), 1);
        case 'BOOL_ARRAY':
          if (Array.isArray(val)) {
            return DataItem.list ? DataItem.list(name, ...val.map((b: any, i: number) => (DataItem.bool ? DataItem.bool(`${name}_${i}`, Boolean(b)) : DataItem.a(`${name}_${i}`, String(Boolean(b)), 1)))) : DataItem.a(name, JSON.stringify(val), val.length);
          }
          return DataItem.a(name, String(val ?? ''), 1);
        case 'B':
        case 'BIN':
          if (Array.isArray(val)) {
            return DataItem.b ? DataItem.b(name, Buffer.from(val)) : DataItem.a(name, Buffer.from(val).toString('hex'), val.length);
          } else if (typeof val === 'string') {
            const hex = val.replace(/[^0-9a-fA-F]/g, '');
            const buf = Buffer.from(hex, 'hex');
            return DataItem.b ? DataItem.b(name, buf) : DataItem.a(name, buf.toString('hex'), buf.length);
          } else {
            return DataItem.a(name, String(val ?? ''), 0);
          }
        case 'LIST':
          return DataItem.list(name, ...buildDataItems(val || [], DataItem));
        default:
          return DataItem.a(name, String(val ?? ''), it.size || Math.max(1, String(val ?? '').length));
      }
    });
  }

  const builtItems = buildDataItems(itemsDesc, DataItemRef);
  const msg = DataMessageRef.builder
    .device(1)
    .stream(Number(substituted.stream || templateObj.stream || 1))
    .func(Number(substituted.func || templateObj.func || 1))
    .replyExpected(Boolean(values.waitReply || substituted.replyExpected || false))
    .items(...builtItems)
    .build();

  const wait = Boolean(values.waitReply || substituted.replyExpected);
  return sendAndWaitIfNeeded(conn, msg, wait, Number(values.timeoutMs || 10000));
}