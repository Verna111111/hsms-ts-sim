import fs from 'fs';
import path from 'path';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');

/**
 * List template file names (only .json) in templates/ directory.
 */
export function listTemplateNames(): string[] {
  try {
    const files = fs.readdirSync(TEMPLATES_DIR);
    return files.filter(f => f.toLowerCase().endsWith('.json'));
  } catch (e) {
    return [];
  }
}

/**
 * Load a JSON template by file name.
 * Accepts name with or without .json suffix.
 * Returns parsed object or null on error.
 */
export function loadTemplate(name: string): any | null {
  try {
    if (!name) return null;
    const fileName = name.toLowerCase().endsWith('.json') ? name : `${name}.json`;
    const p = path.join(TEMPLATES_DIR, fileName);
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Substitute placeholders in an object.
 * - If a string equals "{{key}}" it will be replaced with values[key] (keeping arrays/objects if provided)
 * - Works recursively for arrays/objects
 */
export function substitutePlaceholders(obj: any, values: Record<string, any>): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    const m = obj.match(/^{{\s*([^}]+)\s*}}$/);
    if (m) {
      const k = m[1];
      // if values provides an object/array/primitive, return it directly
      if (values && Object.prototype.hasOwnProperty.call(values, k)) return values[k];
      // otherwise return original string unchanged
      return obj;
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

/**
 * Internal helper: build DataItem array from items description.
 * Compatible with hsms-driver DataItem builders. Performs fallbacks when some builders are missing.
 */
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
          if (DataItemRef.boolArray) return DataItemRef.boolArray(name, val);
          // fallback to LIST of BOOLs
          return DataItemRef.list
            ? DataItemRef.list(name, ...val.map((b: any, i: number) => (DataItemRef.bool ? DataItemRef.bool(`${name}_${i}`, Boolean(b)) : DataItemRef.a(`${name}_${i}`, String(Boolean(b)), 1))))
            : DataItemRef.a(name, JSON.stringify(val), val.length);
        }
        return DataItemRef.a(name, String(val ?? ''), 1);
      case 'B':
      case 'BIN':
        if (Array.isArray(val)) {
          if (DataItemRef.b) return DataItemRef.b(name, Buffer.from(val));
          return DataItemRef.a(name, Buffer.from(val).toString('hex'), val.length);
        } else if (typeof val === 'string') {
          // accept comma separated decimals or hex string
          if (val.indexOf(',') >= 0) {
            const nums = val.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
            if (DataItemRef.b) return DataItemRef.b(name, Buffer.from(nums));
            return DataItemRef.a(name, Buffer.from(nums).toString('hex'), nums.length);
          }
          // hex string fallback
          const hex = val.replace(/[^0-9a-fA-F]/g, '');
          if (hex.length % 2 === 0 && hex.length > 0) {
            const buf = Buffer.from(hex, 'hex');
            if (DataItemRef.b) return DataItemRef.b(name, buf);
            return DataItemRef.a(name, buf.toString('hex'), buf.length);
          }
          // plain string fallback
          return DataItemRef.a(name, val, val.length);
        } else {
          return DataItemRef.a(name, String(val ?? ''), 0);
        }
      case 'LIST':
        return DataItemRef.list ? DataItemRef.list(name, ...buildDataItems(val || [], DataItemRef)) : DataItemRef.a(name, JSON.stringify(val || []), 0);
      default:
        return DataItemRef.a(name, String(val ?? ''), it.size || Math.max(1, String(val ?? '').length));
    }
  });
}

/**
 * Send a template (templateObj may be loaded from file or passed inline).
 *
 * Parameters:
 * - templateObj: object containing stream, func, items (and optionally replyExpected)
 * - values: mapping of placeholder keys -> concrete values
 * - DataItemRef, DataMessageRef: hsms-driver exports (from server.ts)
 * - conn: Connection instance (hostConn or deviceConn)
 * - sendAndWaitIfNeeded: function(conn, msg, waitForReply, timeoutMs) -> Promise
 *
 * Returns the Promise returned by sendAndWaitIfNeeded.
 */
export async function sendTemplate(
  templateObj: any,
  values: Record<string, any>,
  DataItemRef: any,
  DataMessageRef: any,
  conn: any,
  sendAndWaitIfNeeded: (c: any, m: any, w: boolean, t?: number) => Promise<any>
): Promise<any> {
  if (!templateObj) throw new Error('templateObj required');

  // substitute placeholders first (returns deep-cloned substituted object)
  const substituted = substitutePlaceholders(templateObj, values || {});

  // items description
  const itemsDesc = substituted.items || [];

  // build DataItems
  const builtItems = buildDataItems(itemsDesc, DataItemRef);

  // Determine stream/func/replyExpected
  const stream = Number(substituted.stream ?? templateObj.stream ?? 1);
  const func = Number(substituted.func ?? templateObj.func ?? 1);
  const replyExpected = Boolean(substituted.replyExpected ?? templateObj.replyExpected ?? false);

  // Build message
  const msg = DataMessageRef.builder
    .device(Number(substituted.device ?? templateObj.device ?? 1))
    .stream(stream)
    .func(func)
    .replyExpected(replyExpected)
    .items(...builtItems)
    .build();

  // If values specify timeoutMs, use it; otherwise default 10000
  const timeoutMs = Number(values && values.timeoutMs ? values.timeoutMs : 10000);

  // send and return the result
  return sendAndWaitIfNeeded(conn, msg, replyExpected, timeoutMs);
}