// Phone side of Phone Drop. The secret key arrives in the link from the QR code (#k=...) and is
// remembered, so the home-screen icon keeps working without it.
const $ = (id) => document.getElementById(id);

const fromLink = new URLSearchParams(location.hash.slice(1)).get('k');
if (fromLink) localStorage.setItem('phone-drop-key', fromLink);
const key = fromLink || localStorage.getItem('phone-drop-key');

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(time).toLocaleDateString();
}

function setConnection(ok, text) {
  $('conn').className = 'conn ' + (ok ? 'ok' : 'bad');
  $('conn').textContent = text;
  $('offline').hidden = ok;
}

// ---------- phone -> PC ----------

function upload(file) {
  const li = document.createElement('li');
  li.innerHTML = '<div class="grow"><div class="name"></div><div class="meta"></div><div class="bar"><span></span></div></div>';
  li.querySelector('.name').textContent = file.name;
  const meta = li.querySelector('.meta');
  const bar = li.querySelector('.bar span');
  meta.textContent = `${sizeText(file.size)} · waiting`;
  $('uploads').prepend(li);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Key', key);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = pct + '%';
      meta.textContent = `${sizeText(file.size)} · ${pct}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        li.classList.add('done');
        bar.style.width = '100%';
        meta.textContent = `${sizeText(file.size)} · on your PC ✓`;
      } else {
        li.classList.add('failed');
        meta.textContent = `Failed (${xhr.status === 401 ? 'scan the QR code again' : 'error ' + xhr.status})`;
      }
      resolve();
    };
    xhr.onerror = () => {
      li.classList.add('failed');
      meta.textContent = "Failed: can't reach your PC";
      resolve();
    };
    xhr.send(file);
  });
}

async function uploadAll(input) {
  const files = Array.from(input.files);
  input.value = '';
  for (const file of files) await upload(file); // one at a time keeps the wifi steady
}

$('files').addEventListener('change', (e) => uploadAll(e.target));
$('camera').addEventListener('change', (e) => uploadAll(e.target));

$('sendText').addEventListener('click', async () => {
  const text = $('text').value;
  if (!text.trim()) return;
  try {
    const res = await fetch('/api/text', { method: 'POST', headers: { 'X-Key': key }, body: text });
    if (!res.ok) throw new Error(res.status);
    $('text').value = '';
    $('textStatus').textContent = 'On your PC clipboard ✓';
  } catch {
    $('textStatus').textContent = "Couldn't send. Check the connection.";
  }
  setTimeout(() => { $('textStatus').textContent = ''; }, 3000);
});

// ---------- PC -> phone ----------

// the page is plain http, where the modern clipboard API isn't allowed
function copy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function renderInbox(items) {
  $('empty').hidden = items.length > 0;
  $('inbox').replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const body = document.createElement('div');
    body.className = 'grow';
    const action = document.createElement(item.kind === 'file' ? 'a' : 'button');
    action.className = 'action';
    if (item.kind === 'file') {
      body.innerHTML = '<div class="name"></div><div class="meta"></div>';
      body.querySelector('.name').textContent = item.name;
      body.querySelector('.meta').textContent = `${sizeText(item.size)} · ${ago(item.at)}`;
      action.href = `/api/file/${item.id}?k=${encodeURIComponent(key)}`;
      action.setAttribute('download', item.name);
      action.textContent = 'Save';
    } else {
      body.innerHTML = '<div class="textitem"></div><div class="meta"></div>';
      body.querySelector('.textitem').textContent = item.text;
      body.querySelector('.meta').textContent = ago(item.at);
      action.textContent = 'Copy';
      action.addEventListener('click', () => {
        copy(item.text);
        action.textContent = 'Copied ✓';
        setTimeout(() => { action.textContent = 'Copy'; }, 1500);
      });
    }
    li.append(body, action);
    return li;
  }));
}

// ---------- start ----------

if (!key) {
  $('nokey').hidden = false;
  setConnection(false, 'Not set up');
  $('offline').hidden = true;
} else {
  $('app').hidden = false;
  fetch('/api/hello', { headers: { 'X-Key': key } })
    .then((res) => (res.status === 401 ? Promise.reject(new Error('key')) : res.json()))
    .then((hello) => setConnection(true, `Connected to ${hello.pc}`))
    .catch((err) => {
      if (err.message === 'key') {
        $('nokey').hidden = false;
        $('app').hidden = true;
        setConnection(false, 'Key not accepted');
        $('offline').hidden = true;
      } else {
        setConnection(false, 'Offline');
      }
    });

  const events = new EventSource(`/api/events?k=${encodeURIComponent(key)}`);
  let items = [];
  events.addEventListener('items', (e) => {
    items = JSON.parse(e.data);
    renderInbox(items);
  });
  events.onopen = () => {
    if ($('conn').textContent === 'Offline') setConnection(true, 'Connected');
  };
  events.onerror = () => setConnection(false, 'Offline');
  setInterval(() => renderInbox(items), 60000); // keeps "x min ago" fresh
}
