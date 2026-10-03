const { contextBridge, ipcRenderer, webUtils } = require('electron');

// A dropped file's location on disk can only be read here, from the original File object.
// Passed through contextBridge to the page, the File arrives as a copy without its path.
let onDropResult = () => {};
window.addEventListener('drop', async (event) => {
  const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
  if (!files.length) return;
  const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  const sent = paths.length ? await ipcRenderer.invoke('send-files', paths) : 0;
  onDropResult(sent, files.length);
});

contextBridge.exposeInMainWorld('drop', {
  onDropResult: (callback) => { onDropResult = callback; },
  sendText: (text) => ipcRenderer.send('send-text', String(text)),
  hideBox: () => ipcRenderer.send('hide-box'),
  onInfo: (callback) => ipcRenderer.on('info', (_event, info) => callback(info)),
  ready: () => ipcRenderer.send('ready'),
});
