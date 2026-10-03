// Network helpers: which address the phone should use, and who is allowed to connect.
const os = require('os');

// adapters that are never the home wifi
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier|docker|vpn|tap-|tun/i;

// The laptop's address on the local network, best guess first.
function localAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address });
    }
  }
  const rank = (entry) =>
    (/wi-?fi|wlan|wireless/i.test(entry.name) ? 0 : 2) + (entry.address.startsWith('192.168.') ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}

// Only devices on the same local network may talk to the app.
function isPrivate(ip) {
  if (!ip) return false;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd');
}

module.exports = { localAddresses, isPrivate };
