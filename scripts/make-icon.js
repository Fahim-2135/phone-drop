// Draws build/icon.png (installer and Start menu icon) and returns the same shape for the tray.
const fs = require('fs');
const path = require('path');
const { render, hexToRgb } = require('../png');

const TEAL = [...hexToRgb('#14b8a6'), 1];
const WHITE = [...hexToRgb('#ffffff'), 1];

function roundedSquare(u, v, half, radius) {
  const qx = Math.abs(u - 0.5) - (half - radius);
  const qy = Math.abs(v - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// teal rounded square with a white "drop into tray" arrow
function shade(u, v) {
  if (roundedSquare(u, v, 0.46, 0.2) > 0) return null;
  const stem = Math.abs(u - 0.5) < 0.06 && v > 0.2 && v < 0.52;
  const head = v >= 0.44 && v < 0.64 && Math.abs(u - 0.5) < 0.2 - (v - 0.44);
  const tray = v > 0.7 && v < 0.79 && u > 0.24 && u < 0.76;
  const sides = v > 0.58 && v < 0.79 && ((u > 0.24 && u < 0.33) || (u > 0.67 && u < 0.76));
  return stem || head || tray || sides ? WHITE : TEAL;
}

// the app icon, and the same icon for the launcher page
if (require.main === module) {
  const png = render(512, shade);
  for (const out of [path.join(__dirname, '..', 'build', 'icon.png'), path.join(__dirname, '..', 'docs', 'icon.png')]) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
  }
}

module.exports = { shade };
