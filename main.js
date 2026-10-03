// phone-drop: send photos, files and text between your phone and this PC over the local wifi.
// The PC runs a small web server; the phone opens its page. Files and text never leave the
// local network. Two small things do go through ntfy.sh: the PC's local address (so the phone's
// launcher page can find the PC after a network change) and optional "PC sent you…" pings.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, clipboard, Notification, shell, screen,
} = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { render } = require('./png');
const { shade } = require('./scripts/make-icon');
const { localAddresses, isPrivate } = require('./network');

const PORT = 8787;
// The launcher page (docs/ in this repo, on GitHub Pages). Forks: change "launcherUrl" in package.json.
const LAUNCHER_URL = require('./package.json').launcherUrl;
const ANNOUNCE_EVERY_MS = 4 * 60 * 60 * 1000; // ntfy.sh forgets messages after 12 hours
const OUTBOX_MAX = 30; // items kept for the phone to download
const TEXT_MAX = 100000;
const DEBUG = !!process.env.PHONE_DROP_DEBUG;

let tray = null;
let qrWindow = null;
let boxWindow = null;
let serverError = null;
const listeners = new Set(); // open event streams from phones

// ---------- settings ----------

// test runs can use a throwaway profile, e.g. for README screenshots with no real data in them
if (DEBUG && process.env.PHONE_DROP_PROFILE) app.setPath('userData', process.env.PHONE_DROP_PROFILE);

const configPath = path.join(app.getPath('userData'), 'config.json');
const outboxDir = path.join(app.getPath('userData'), 'outbox');
const config = {
  key: null, // the phone needs it for everything; it travels only inside the QR code
  addressTopic: null, // secret ntfy topic where the PC posts its current local address
  pingTopic: null, // secret ntfy topic for "PC sent you…" notifications
  ping: true,
  box: true,
  boxX: null,
  boxY: null,
  phoneSeen: false,
  loginSet: false,
  outbox: [],
};

const randomSecret = (prefix) => prefix + crypto.randomBytes(24).toString('base64url');

function loadConfig() {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    // first launch
  }
  if (typeof config.key !== 'string' || config.key.length < 32) config.key = crypto.randomBytes(24).toString('base64url');
  if (!/^[-_A-Za-z0-9]{32,64}$/.test(config.addressTopic || '')) config.addressTopic = randomSecret('pd-addr-');
  if (!/^[-_A-Za-z0-9]{32,64}$/.test(config.pingTopic || '')) config.pingTopic = randomSecret('pd-ping-');
  if (!Array.isArray(config.outbox)) config.outbox = [];
  saveConfig();
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    // settings just won't be remembered
  }
}

function dropFolder() {
  const dir = path.join(app.getPath('downloads'), 'Phone Drop');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- addresses ----------

function address() {
  const best = localAddresses()[0];
  return best ? best.address : null;
}

// What the QR code holds: the launcher page, with everything it needs after the # (a part of a
// link that browsers never send to any server).
function launcherLink() {
  const ip = address();
  const here = ip ? `&h=${ip}:${PORT}` : '';
  return `${LAUNCHER_URL}#a=${config.addressTopic}&k=${config.key}${here}`;
}

// straight to this PC, for when the launcher can't be used (no internet)
function directLink() {
  const ip = address();
  return ip ? `http://${ip}:${PORT}/#k=${config.key}` : null;
}

// ---------- ntfy.sh ----------

function ntfyPost(payload, onDone = () => {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const req = https.request({
    host: 'ntfy.sh', path: '/', method: 'POST', timeout: 10000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  }, (res) => {
    res.resume();
    onDone(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => onDone(false)); // offline
  req.end(body);
}

// Tells the phone's launcher where this PC is now. Only the local address is posted.
// Retried every 30 seconds until it gets through (e.g. on a network with no internet yet).
let announced = null;
function announceAddress(force) {
  const ip = address();
  if (!ip || (!force && ip === announced)) return;
  ntfyPost({ topic: config.addressTopic, message: `${ip}:${PORT}` }, (ok) => {
    if (ok) announced = ip;
  });
}

// ---------- file names ----------

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

function safeName(name) {
  let clean = path.basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) clean = 'file';
  if (RESERVED.test(clean)) clean = '_' + clean;
  if (clean.length > 150) {
    const ext = path.extname(clean).slice(0, 20);
    clean = clean.slice(0, 150 - ext.length) + ext;
  }
  return clean;
}

// photo.jpg -> photo (1).jpg -> photo (2).jpg ...
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

// ---------- phone -> PC ----------

let arrivals = []; // grouped into one notification
let arrivalTimer = null;

function announceArrival(file) {
  arrivals.push(file);
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => {
    const batch = arrivals;
    arrivals = [];
    const title = batch.length === 1 ? `Got ${path.basename(batch[0])}` : `Got ${batch.length} files`;
    notify(title, 'Click to open the Phone Drop folder.', () => {
      if (batch.length === 1) shell.showItemInFolder(batch[0]);
      else shell.openPath(dropFolder());
    });
  }, 1200);
}

function receiveFile(req, res, query) {
  const name = safeName(query.get('name'));
  const dir = dropFolder();
  const temp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.part`);
  const out = fs.createWriteStream(temp);
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(temp, { force: true }, () => {});
  };
  req.on('aborted', fail);
  req.on('error', fail);
  out.on('error', () => {
    fail();
    if (!res.headersSent) json(res, 500, { error: 'could not save the file' });
  });
  out.on('finish', () => {
    if (failed) return;
    const final = freePath(dir, name);
    fs.rename(temp, final, (err) => {
      if (err) {
        fs.rm(temp, { force: true }, () => {});
        return json(res, 500, { error: 'could not save the file' });
      }
      announceArrival(final);
      json(res, 200, { ok: true, saved: path.basename(final) });
    });
  });
  req.pipe(out);
}

function receiveText(req, res) {
  readBody(req, res, TEXT_MAX, (body) => {
    const text = body.toString('utf8');
    if (!text.trim()) return json(res, 400, { error: 'empty text' });
    Promise.resolve(clipboard.writeText(text)).catch(logError); // asynchronous since Electron 44
    const preview = text.replace(/\s+/g, ' ').trim();
    notify('Text copied to clipboard', preview.length > 90 ? preview.slice(0, 90) + '…' : preview);
    json(res, 200, { ok: true });
  });
}

// ---------- PC -> phone ----------

// keeps the newest items, deletes the files of the rest, and tells open phone pages
function outboxChanged() {
  for (const old of config.outbox.splice(OUTBOX_MAX)) {
    if (old.kind === 'file') fs.rm(path.join(outboxDir, old.id), { recursive: true, force: true }, () => {});
  }
  saveConfig();
  broadcast();
}

function addToOutbox(item) {
  config.outbox.unshift({ id: crypto.randomBytes(8).toString('hex'), at: Date.now(), ...item });
  outboxChanged();
}

function sendFiles(paths) {
  let count = 0;
  for (const source of paths) {
    try {
      const stat = fs.statSync(source);
      if (!stat.isFile()) continue;
      const id = crypto.randomBytes(8).toString('hex');
      const name = safeName(path.basename(source));
      fs.mkdirSync(path.join(outboxDir, id), { recursive: true });
      fs.copyFileSync(source, path.join(outboxDir, id, name));
      config.outbox.unshift({ id, at: Date.now(), kind: 'file', name, size: stat.size });
      count++;
    } catch {
      // unreadable file: skip it
    }
  }
  if (!count) return 0;
  outboxChanged();
  const first = config.outbox[0].name;
  pingPhone(count === 1 ? `PC sent you ${first}` : `PC sent you ${count} files`);
  return count;
}

function sendText(text) {
  text = String(text || '').slice(0, TEXT_MAX);
  if (!text.trim()) return;
  addToOutbox({ kind: 'text', text });
  pingPhone('PC sent you some text');
}

// Text only: Electron 44's clipboard can't hand over pictures reliably. Pictures go by file.
async function sendClipboard() {
  let text = '';
  try {
    text = await clipboard.readText(); // asynchronous since Electron 44
  } catch {
    // unreadable clipboard: treated as empty
  }
  if (text && text.trim()) sendText(text);
  else notify('No text on the clipboard', 'Copy some text first. For pictures and files, drag them onto the drop box.');
}

function publicItems() {
  return config.outbox.map(({ id, at, kind, name, size, text }) => ({ id, at, kind, name, size, text }));
}

function broadcast() {
  const data = `event: items\ndata: ${JSON.stringify(publicItems())}\n\n`;
  for (const res of listeners) res.write(data);
}

// "PC sent you…" notification through ntfy (subscribe to the topic in the ntfy app).
// The link holds no key: the launcher already knows it from the first QR scan.
function pingPhone(title) {
  if (!config.ping) return;
  ntfyPost({ topic: config.pingTopic, title, message: 'Tap to open Phone Drop.', click: LAUNCHER_URL });
}

function testPing() {
  ntfyPost({ topic: config.pingTopic, title: 'Phone Drop test', message: 'Notifications work.', click: LAUNCHER_URL });
}

// ---------- web server ----------

const PHONE_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, res, limit, onBody) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      json(res, 413, { error: 'too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size <= limit) onBody(Buffer.concat(chunks));
  });
}

function keyOk(req, query) {
  const given = String(req.headers['x-key'] || query.get('k') || '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function handle(req, res) {
  if (!isPrivate(req.socket.remoteAddress)) {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url, 'http://phone-drop');
  const route = url.pathname;

  if (req.method === 'GET' && PHONE_FILES[route]) {
    const [file, type] = PHONE_FILES[route];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, 'phone', file)).pipe(res);
  }
  if (req.method === 'GET' && route === '/icon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    return res.end(appIcon(192));
  }

  if (!route.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (!keyOk(req, url.searchParams)) return json(res, 401, { error: 'wrong or missing key' });

  if (!config.phoneSeen && !/^::1$|^(::ffff:)?127\./.test(req.socket.remoteAddress)) {
    config.phoneSeen = true;
    saveConfig();
    if (qrWindow) qrWindow.webContents.send('info', info());
  }

  if (req.method === 'GET' && route === '/api/hello') {
    const pc = (DEBUG && process.env.PHONE_DROP_PC_NAME) || require('os').hostname();
    return json(res, 200, { ok: true, pc });
  }
  if (req.method === 'POST' && route === '/api/upload') return receiveFile(req, res, url.searchParams);
  if (req.method === 'POST' && route === '/api/text') return receiveText(req, res);

  if (req.method === 'GET' && route === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: items\ndata: ${JSON.stringify(publicItems())}\n\n`);
    listeners.add(res);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
    return;
  }

  const fileMatch = /^\/api\/file\/([0-9a-f]{16})$/.exec(route);
  if (req.method === 'GET' && fileMatch) {
    const item = config.outbox.find((i) => i.id === fileMatch[1] && i.kind === 'file');
    const file = item && path.join(outboxDir, item.id, item.name);
    if (!item || !fs.existsSync(file)) return json(res, 404, { error: 'gone' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `attachment; filename="${item.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (DEBUG && req.method === 'POST' && route === '/api/debug-send-text') {
    return readBody(req, res, TEXT_MAX, (body) => {
      sendText(body.toString('utf8'));
      json(res, 200, { ok: true });
    });
  }
  // drops files on the drop box the way Explorer does (Chromium's drag protocol), for testing
  if (DEBUG && req.method === 'POST' && route === '/api/debug-drop') {
    return readBody(req, res, TEXT_MAX, async (body) => {
      const files = JSON.parse(body.toString('utf8'));
      const dbg = boxWindow.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await dbg.sendCommand('Input.dispatchDragEvent', { type, x: 56, y: 70, data });
      }
      setTimeout(() => json(res, 200, { label: null }), 800);
    });
  }
  if (DEBUG && req.method === 'POST' && route === '/api/debug-send-clipboard') {
    return sendClipboard().then(() => json(res, 200, { ok: true }));
  }
  if (DEBUG && req.method === 'GET' && route === '/api/debug-shot') {
    return debugShot(url.searchParams.get('w'), res);
  }

  json(res, 404, { error: 'not found' });
}

// a request that hits an unexpected error gets a 500 instead of taking the app down
function safeHandle(req, res) {
  try {
    const pending = handle(req, res);
    if (pending && typeof pending.catch === 'function') pending.catch((err) => fail(res, err));
  } catch (err) {
    fail(res, err);
  }
}

function fail(res, err) {
  logError(err);
  if (!res.headersSent) json(res, 500, { error: 'something went wrong on the PC' });
}

// errors go to a log file, never to a dialog box in the middle of the screen
function logError(err) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'errors.log'), `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch {
    // nowhere to write
  }
}
process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);

function startServer() {
  const server = http.createServer(safeHandle);
  server.requestTimeout = 0; // big uploads over slow wifi
  server.on('error', (err) => {
    serverError = err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use by another program.` : String(err.code || err);
    refreshTray();
  });
  server.listen(PORT, '0.0.0.0');
}

// ---------- windows ----------

function info() {
  return {
    url: launcherLink(),
    direct: directLink(),
    address: address(),
    port: PORT,
    phoneSeen: config.phoneSeen,
    error: serverError,
    folder: dropFolder(),
  };
}

async function showQr() {
  if (qrWindow) {
    qrWindow.show();
    qrWindow.focus();
    return sendQr();
  }
  qrWindow = new BrowserWindow({
    width: 440,
    height: 600,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Phone Drop',
    icon: nativeImage.createFromBuffer(appIcon(64)),
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  qrWindow.setMenu(null);
  qrWindow.loadFile(path.join(__dirname, 'pc', 'qr.html'));
  qrWindow.once('ready-to-show', () => qrWindow.show());
  qrWindow.on('closed', () => {
    qrWindow = null;
  });
}

async function sendQr() {
  if (!qrWindow) return;
  const details = info();
  details.qr = details.url ? await QRCode.toString(details.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
  qrWindow.webContents.send('info', details);
}

function createBox() {
  if (boxWindow) return;
  const size = 112;
  const area = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(config.boxX) ? config.boxX : area.x + area.width - size - 20;
  let y = Number.isFinite(config.boxY) ? config.boxY : area.y + area.height - size - 220;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    x + size / 2 >= a.x && x + size / 2 <= a.x + a.width && y + size / 2 >= a.y && y + size / 2 <= a.y + a.height);
  if (!onScreen) {
    x = area.x + area.width - size - 20;
    y = area.y + area.height - size - 220;
  }
  boxWindow = new BrowserWindow({
    x, y, width: size, height: size,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, minimizable: false, maximizable: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  boxWindow.setAlwaysOnTop(true, 'screen-saver');
  boxWindow.loadFile(path.join(__dirname, 'pc', 'box.html'));
  boxWindow.once('ready-to-show', () => boxWindow.showInactive());
  boxWindow.on('moved', () => {
    const b = boxWindow.getBounds();
    config.boxX = b.x;
    config.boxY = b.y;
    saveConfig();
  });
  boxWindow.on('closed', () => {
    boxWindow = null;
  });
}

function setBox(on) {
  config.box = on;
  saveConfig();
  if (on) createBox();
  else if (boxWindow) boxWindow.close();
  refreshTray();
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: nativeImage.createFromBuffer(appIcon(64)) });
  if (onClick) n.on('click', onClick);
  n.show();
}

// a screenshot of the phone page or the PC windows, for testing only
async function debugShot(which, res) {
  let target;
  if (which === 'qr') target = qrWindow;
  else if (which === 'box') target = boxWindow;
  else {
    target = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { offscreen: false } });
    await target.loadURL(`http://127.0.0.1:${PORT}/#k=${config.key}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!target) return json(res, 404, { error: 'window not open' });
  const image = await target.webContents.capturePage();
  if (!which || which === 'phone') target.destroy();
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(image.toPNG());
}

// ---------- tray ----------

const iconCache = {};
function appIcon(size) {
  if (!iconCache[size]) iconCache[size] = render(size, shade);
  return iconCache[size];
}

const loginOptions = app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname)] };

function refreshTray() {
  if (!tray) return;
  const ip = address();
  tray.setToolTip(serverError ? `Phone Drop: ${serverError}` : ip ? `Phone Drop on ${ip}:${PORT}` : 'Phone Drop: not connected to a network');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show QR code for your phone', click: showQr },
    { label: ip ? `Address: ${ip}:${PORT}` : 'No network', enabled: false },
    { type: 'separator' },
    { label: 'Send clipboard to phone', click: sendClipboard },
    { label: 'Open Phone Drop folder', click: () => shell.openPath(dropFolder()) },
    { label: 'Drop box on screen', type: 'checkbox', checked: config.box, click: () => setBox(!config.box) },
    { type: 'separator' },
    {
      label: 'Phone notifications',
      type: 'checkbox',
      checked: config.ping,
      click: () => {
        config.ping = !config.ping;
        saveConfig();
        refreshTray();
      },
    },
    { label: 'Copy notification topic (for the ntfy app)', click: () => clipboard.writeText(config.pingTopic) },
    { label: 'Send test notification', click: testPing },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginOptions).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, ...loginOptions });
        refreshTray();
      },
    },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ---------- "Send to" in Explorer's right-click menu ----------

function installSendTo() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'Phone (Phone Drop).lnk');
  shell.writeShortcutLink(link, fs.existsSync(link) ? 'update' : 'create', {
    target: process.execPath,
    description: 'Send to your phone with Phone Drop',
    icon: process.execPath,
    iconIndex: 0,
  });
}

// files passed on the command line (from "Send to") are sent to the phone
function filesFromArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith('-') && fs.existsSync(arg) && fs.statSync(arg).isFile());
}

// ---------- app ----------

ipcMain.on('ready', (event) => {
  if (qrWindow && event.sender === qrWindow.webContents) sendQr();
});
ipcMain.handle('send-files', (_event, paths) => sendFiles(Array.isArray(paths) ? paths : []));
ipcMain.on('send-text', (_event, text) => sendText(text));
ipcMain.on('hide-box', () => setBox(false));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const files = filesFromArgs(argv);
    if (files.length) sendFiles(files);
    else showQr();
  });

  app.whenReady().then(() => {
    loadConfig();
    if (!config.loginSet && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true });
      config.loginSet = true;
      saveConfig();
    }
    fs.mkdirSync(outboxDir, { recursive: true });
    startServer();
    tray = new Tray(nativeImage.createFromBuffer(appIcon(32), { scaleFactor: 2 }));
    tray.on('click', showQr);
    refreshTray();
    // the address changes when you change wifi: tell the launcher, refresh the QR code
    let lastAddress = address();
    announceAddress(true);
    setInterval(() => {
      refreshTray();
      announceAddress(false);
      if (address() !== lastAddress) {
        lastAddress = address();
        sendQr();
      }
    }, 30000);
    setInterval(() => announceAddress(true), ANNOUNCE_EVERY_MS);
    installSendTo();
    if (config.box) createBox();
    if (!config.phoneSeen) showQr();
    const files = filesFromArgs(process.argv);
    if (files.length) sendFiles(files);
  });

  app.on('window-all-closed', () => {}); // lives in the tray
}
