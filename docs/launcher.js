// Phone Drop launcher. The QR code on the PC opens this page with everything after the #:
//   a = secret ntfy topic where the PC posts its current local address
//   k = the PC's secret key
//   h = the PC's address at the time of scanning (fallback)
// Browsers never send the part after # to a server, and this page keeps it in localStorage on
// the phone. It only asks ntfy.sh for the newest address, then opens the PC's own page.
const STORE = 'phone-drop-launcher';
const $ = (id) => document.getElementById(id);

function show(id) {
  for (const section of ['setup', 'finding', 'trouble', 'none']) $(section).hidden = section !== id;
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

function save(settings) {
  localStorage.setItem(STORE, JSON.stringify(settings));
}

// Only addresses on a home network are accepted, so a forged message can't send the key elsewhere.
function isLocalAddress(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{2,5})$/.exec(String(text || '').trim());
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (match.slice(1, 5).some((n) => Number(n) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function newestAddress(topic) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=12h`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const lines = (await res.text()).trim().split('\n').filter(Boolean);
    const messages = lines.map((line) => JSON.parse(line)).filter((m) => m.event === 'message' && isLocalAddress(m.message));
    return messages.length ? messages[messages.length - 1].message.trim() : null;
  } catch {
    return null; // offline, or ntfy.sh unreachable
  } finally {
    clearTimeout(timer);
  }
}

async function open(settings) {
  show('finding');
  const fresh = await newestAddress(settings.a);
  if (fresh && fresh !== settings.h) {
    settings.h = fresh;
    save(settings);
  }
  if (!settings.h) {
    $('troubleText').textContent = "Couldn't find your PC. Is Phone Drop running on it, and is it online?";
    return show('trouble');
  }
  // the key goes along after the #, so it never reaches any server
  location.replace(`http://${settings.h}/#k=${encodeURIComponent(settings.k)}`);
}

const fromLink = new URLSearchParams(location.hash.slice(1));
const scanned = fromLink.get('a') && fromLink.get('k')
  ? { a: fromLink.get('a'), k: fromLink.get('k'), h: isLocalAddress(fromLink.get('h')) ? fromLink.get('h') : null }
  : null;
const stored = load();

if (scanned && (!stored || stored.a !== scanned.a || stored.k !== scanned.k)) {
  // a new QR scan: remember it and explain the home-screen step first
  save(scanned);
  show('setup');
} else if (stored || scanned) {
  open(stored || scanned);
} else {
  show('none');
}

$('open').addEventListener('click', () => open(load()));
$('retry').addEventListener('click', () => open(load()));
