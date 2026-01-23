// Simple frontend to call /send-custom (and existing endpoints)
// Renders simple items editor and calls server API via fetch

function $(id){ return document.getElementById(id); }

function createItemRow(item = { type: 'A', name: 'payload', value: 'hello', size: 0 }) {
  const row = document.createElement('div');
  row.className = 'itemRow';

  const type = document.createElement('select');
  ['A','U2','U4','I4','F4','F8','BOOL','LIST'].forEach(t => {
    const o = document.createElement('option'); o.value = t; o.textContent = t;
    if (t === item.type) o.selected = true;
    type.appendChild(o);
  });

  const name = document.createElement('input'); name.value = item.name || 'payload';
  const value = document.createElement('input'); value.value = item.value ?? '';
  const size = document.createElement('input'); size.type='number'; size.value = item.size || 0; size.style.width='70px';
  const rm = document.createElement('button'); rm.textContent='Remove';

  rm.onclick = () => row.remove();

  row.appendChild(type);
  row.appendChild(name);
  row.appendChild(value);
  row.appendChild(size);
  row.appendChild(rm);
  return row;
}

function collectItems() {
  const container = $('items');
  const rows = container.querySelectorAll('.itemRow');
  const items = [];
  rows.forEach(r => {
    const [typeEl,nameEl,valueEl,sizeEl] = r.children;
    const t = typeEl.value;
    const name = nameEl.value || 'item';
    const rawVal = valueEl.value;
    const size = Number(sizeEl.value) || undefined;
    let val = rawVal;
    if (t !== 'A') {
      // try to coerce numeric/bool types
      if (t === 'BOOL') val = rawVal === 'true' || rawVal === '1';
      else val = Number(rawVal);
    }
    const it = { type: t, name, value: val };
    if (size) it.size = size;
    items.push(it);
  });
  return items;
}

function showJSON(elId, obj) {
  $(elId).textContent = JSON.stringify(obj, null, 2);
}

async function postJson(path, data) {
  showJSON('reqJson', data);
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    const json = await resp.json();
    showJSON('resJson', json);
    return json;
  } catch (e) {
    showJSON('resJson', { error: e.message });
    throw e;
  }
}

window.addEventListener('load', () => {
  // init items container
  $('items').appendChild(createItemRow());

  $('addItem').addEventListener('click', (e) => {
    e.preventDefault();
    $('items').appendChild(createItemRow({ type:'A', name:'payload', value:'hello', size:0 }));
  });

  $('sendCustom').addEventListener('click', async () => {
    const payload = {
      from: $('from').value,
      stream: Number($('stream').value),
      func: Number($('func').value),
      items: collectItems(),
      waitReply: $('waitReply').checked
    };
    await postJson('/send-custom', payload);
  });

  $('sendS1F1').addEventListener('click', async () => {
    const payload = {
      from: $('from').value,
      text: 'Hello from web UI',
      waitReply: $('waitReply').checked
    };
    await postJson('/send-s1f1', payload);
  });

  $('sendS1F2').addEventListener('click', async () => {
    const payload = {
      from: $('from').value,
      text: 'Event from web UI'
    };
    await postJson('/send-s1f2', payload);
  });
});