# hsms-ts-sim

Local HSMS loopback simulator with a single HTTP entrypoint for sending SECS-II messages via JSON templates.

This project provides:
- An HSMS loopback (host active ↔ device passive) for local testing.
- A templates folder (`templates/`) where each SxFy message template is defined as JSON.
- A single HTTP API `/send-template` to send messages by template name or inline template.
- A small web UI (`public/`) to choose templates, edit template JSON, provide placeholder values, and send.

---

## Quick start

Install dependencies and run in development mode:

```bash
npm install
npm run dev
```

Or build and run:

```bash
npm run build
npm start
```

Environment variables:
- `HTTP_PORT` (default: 3000) — HTTP server port.
- `HSMS_PORT` (default: 7000) — HSMS loopback port for the simulated host/device.

Open the UI:
- http://localhost:3000

Server console prints HSMS events (established / recv / trx-complete) and debug logs for sends.

---

## Files of interest

- `src/server.ts` — HTTP server + HSMS loopback wiring (single entrypoint `/send-template`).
- `src/template-manager.ts` — Helper functions: `listTemplateNames`, `loadTemplate`, `substitutePlaceholders`, `sendTemplate`.
- `templates/*.json` — Template definitions (e.g. `S1F1.json`, `S1F2.json`, ...).
- `public/index.html`, `public/app.js` — Web UI for selecting/editing/sending templates.

---

## Templates

Each template is a JSON file under `templates/`. A template defines the SECS-II structure (stream, func, items, optional `replyExpected`, `device`).

Example `templates/S1F4.json`:
```json
{
  "stream": 1,
  "func": 4,
  "description": "Example S1F4 with I2",
  "items": [
    { "type": "I2", "name": "code", "value": "{{code}}" }
  ]
}
```

Notes:
- Placeholders use the exact form `{{key}}`. When sending a named template you must provide `values` mapping for all placeholders, or replace them directly in an inline template.
- Supported item `type` values include (but are not limited to): `A`, `U2`, `U4`, `I2`, `I4`, `F4`, `F8`, `BOOL`, `BOOL_ARRAY`, `B`/`BIN`, `LIST`.
- The server's `template-manager` performs sensible fallbacks if a particular DataItem builder is not present in the HSMS driver.

---

## HTTP API

All API endpoints are relative to `http://localhost:3000` (or the `HTTP_PORT` you set).

### GET /templates
List available template filenames.

Response:
```json
{ "ok": true, "templates": ["S1F1.json","S1F2.json", ...] }
```

### GET /templates/:name
Retrieve a single template JSON.

Example:
```
GET /templates/S1F1.json
```

Response:
```json
{ "ok": true, "template": { ... } }
```

### POST /send-template
Single entrypoint to send a message. You may send a named template or pass an inline template.

Request body examples:

- Inline template (no placeholders):
```json
{
  "from": "host",
  "templateInline": {
    "stream": 1,
    "func": 4,
    "items": [
      { "type": "I2", "name": "code", "value": 1 }
    ]
  },
  "values": {}
}
```

- Named template with placeholders:
```json
{
  "from": "host",
  "name": "S1F1.json",
  "values": {
    "f4": 0.5567,
    "f8": 0.9,
    "flags": [1,0],
    "bin": [0,5,6,9,255]
  }
}
```

Validation & behavior:
- `from` must be `"host"` or `"device"` and selects which connection (active host or passive device) sends the message.
- If a template contains placeholders (strings of the exact form `{{key}}`), you must provide the corresponding `values` keys; otherwise the server returns HTTP 400 with a `Missing template values` message.
- If `replyExpected` is set in the template (or specified in `values`), the server will wait for a reply (controlled by `sendTemplate` and `sendAndWaitIfNeeded`). The default timeout is 10s (override via `values.timeoutMs`).

Success response:
```json
{ "ok": true, "result": { /* may include reply when waitReply */ } }
```

Error responses include `{ "ok": false, "error": "message" }`.

---

## curl examples

- List templates:
```bash
curl -s http://localhost:3000/templates | jq
```

- Send inline template:
```bash
curl -s -X POST http://localhost:3000/send-template \
  -H "Content-Type: application/json" \
  -d '{
    "from":"host",
    "templateInline": { "stream":1, "func":4, "items":[{ "type":"I2","name":"code","value":1 }] },
    "values": {}
  }' | jq
```

- Send using a named template (with placeholders):
```bash
curl -s -X POST http://localhost:3000/send-template \
  -H "Content-Type: application/json" \
  -d '{
    "from":"host",
    "name":"S1F1.json",
    "values": { "f4": 0.5567, "f8": 0.9, "flags": [1,0], "bin":[0,5,6,9,255] }
  }' | jq
```

---

## Web UI (public/)
Open http://localhost:3000

UI features:
- Template selector (loads template JSON into editor).
- Template editor (edit inline JSON).
- Values textarea (provide JSON for placeholders).
- "Send Template" button (POSTs to `/send-template` and shows request/response).
- Choose `from` = host or device before sending.

If you prefer, edit placeholders directly in the Template editor instead of using the Values box.

---

## Troubleshooting

- 400 Missing template values
  - Provide missing keys in `values` or replace placeholders directly in the template JSON.

- 500 Invalid item value or format
  - Check the generated DataItem types and values. Ensure numeric fields are numbers (not placeholder strings). Use the UI to inspect the Request JSON the server receives.

- No HSMS logs / host/device not established
  - Check the server terminal for `host(active) established` and `device(passive) established`. If not present, verify `HSMS_PORT` and that no other process is using it.

- Want to see send logs in UI
  - Server prints debug logs to its console. If you want live logs in the browser, consider enabling SSE or WebSocket support (not included by default).

---

## Development notes

- Templates live in the `templates/` directory at the repo root.
- `src/template-manager.ts` exposes:
  - `listTemplateNames()`
  - `loadTemplate(name)`
  - `substitutePlaceholders(templateObj, values)`
  - `sendTemplate(templateObj, values, DataItem, DataMessage, conn, sendAndWaitIfNeeded)`
- `sendTemplate` builds DataItems using the template description, constructs a DataMessage, and calls `sendAndWaitIfNeeded`.

---

If you want, I can:
- Add JSON Schema (AJV) validation for templates and values to return clearer validation errors.
- Convert the UI to render placeholder keys as a dynamic form instead of raw JSON editing.
- Add server-sent events (SSE) or WebSocket so the UI can display HSMS send/recv logs in real time.
