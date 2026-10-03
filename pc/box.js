// Files (or dragged text) dropped here go to the phone.
const box = document.getElementById('box');
const label = document.getElementById('label');
const defaultLabel = label.innerHTML;
let depth = 0;
let resetTimer = null;

function flash(text) {
  box.classList.add('sent');
  label.textContent = text;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    box.classList.remove('sent');
    label.innerHTML = defaultLabel;
  }, 1800);
}

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  depth++;
  box.classList.add('over');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  depth = Math.max(0, depth - 1);
  if (!depth) box.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  box.classList.remove('over');
  if (e.dataTransfer.files.length) {
    label.textContent = 'Sending…'; // the preload reads the file paths and reports back
    return;
  }
  const text = e.dataTransfer.getData('text/plain');
  if (text) {
    window.drop.sendText(text);
    flash('Text sent ✓');
  }
});

// says "Sent" only for files the app really queued for the phone
window.drop.onDropResult((sent, dropped) => {
  if (!sent) flash(dropped === 1 ? "Can't send that" : "Couldn't send those");
  else if (sent < dropped) flash(`Sent ${sent} of ${dropped}`);
  else flash(sent === 1 ? 'Sent ✓' : `Sent ${sent} ✓`);
});

document.getElementById('close').addEventListener('click', () => window.drop.hideBox());
