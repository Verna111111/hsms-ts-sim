// public/app.js
// Frontend for single-entry /send-template workflow
// - loads templates from /templates
// - allows loading template JSON into editor
// - lets user send templateInline or named template with values

function $(id){ return document.getElementById(id); }

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function showJSON(elId, obj) { $(elId).textContent = JSON.stringify(obj, null, 2); }

window.addEventListener('load', async () => {
  // elements
  const sel = $('templateSelect');
  const loadBtn = $('loadTemplate');
  const sendBtn = $('sendTemplate');
  const editor = $('templateEditor');
  const valuesInput = $('templateValues');
  const fromSelect = $('from');

  // load templates list
  try {
    const tplList = await fetchJson('/templates');
    (tplList.templates || []).forEach(n => {
      const o = document.createElement('option'); o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
  } catch (e) {
    console.warn('Templates load failed', e);
  }

  loadBtn.addEventListener('click', async () => {
    const name = sel.value;
    if (!name) return alert('Choose a template first');
    try {
      const res = await fetchJson(`/templates/${name}`);
      editor.value = JSON.stringify(res.template, null, 2);
    } catch (e) {
      alert('Failed to load template: ' + e.message);
    }
  });

  sendBtn.addEventListener('click', async () => {
    try {
      const tplText = editor.value.trim();
      let templateInline = null;
      if (tplText) templateInline = JSON.parse(tplText);

      const valuesText = valuesInput.value.trim();
      const values = valuesText ? JSON.parse(valuesText) : {};

      const body = {
        from: fromSelect.value,
        templateInline,
        values
      };

      showJSON('reqJson', body);
      const resp = await fetch('/send-template', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const json = await resp.json();
      showJSON('resJson', json);
    } catch (e) {
      showJSON('resJson', { error: e.message });
    }
  });
});