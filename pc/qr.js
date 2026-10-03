const qr = document.getElementById('qr');
const status = document.getElementById('status');
let link = null;

window.drop.onInfo((info) => {
  link = info.direct; // straight to this PC; the QR code holds the launcher link
  document.getElementById('address').textContent = info.address ? `${info.address}:${info.port}` : 'not connected to a network';

  if ('qr' in info) {
    // the SVG comes from the QR library in the main process
    qr.innerHTML = info.qr || '';
    qr.classList.toggle('empty', !info.qr);
    if (!info.qr) qr.textContent = 'Connect this PC to Wi-Fi first';
  }

  if (info.error) {
    status.className = 'status error';
    status.textContent = info.error;
  } else if (info.phoneSeen) {
    status.className = 'status ok';
    status.textContent = '✓ Your phone has connected';
  } else {
    status.className = 'status waiting';
    status.textContent = 'Waiting for your phone…';
  }
});

document.getElementById('copy').addEventListener('click', async () => {
  if (!link) return;
  await navigator.clipboard.writeText(link);
  const button = document.getElementById('copy');
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy link'; }, 1500);
});

window.drop.ready();
