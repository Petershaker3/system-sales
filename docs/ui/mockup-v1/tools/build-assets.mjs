// Builds fonts/, fonts.css and icons.js for the UI mockup from local npm packages (offline, no CDN).
// Fonts: @fontsource (SIL OFL 1.1) — only the arabic + latin subsets. Icons: lucide-static (ISC).
// Usage (from this tools/ folder):  npm install && node build-assets.mjs ..
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NM = path.join(HERE, 'node_modules');
const OUT = path.resolve(process.argv[2] || path.join(HERE, '..'));

const FAMILIES = [
  // خط كل طابع: Changa مع «لافتة الشارع» و Vazirmatn مع «علبة الموبايل» (docs/ui/REDESIGN.md)
  { pkg: 'changa', weights: [400, 500, 600, 700, 800] },
  { pkg: 'vazirmatn', weights: [400, 500, 600, 700] },
  { pkg: 'ibm-plex-sans-arabic', weights: [400, 500, 600, 700] },
  { pkg: 'cairo', weights: [400, 500, 600, 700] },
  { pkg: 'readex-pro', weights: [400, 500, 600, 700] },
  { pkg: 'tajawal', weights: [400, 500, 700] },
];
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
let css = '/* Fonts: @fontsource (SIL Open Font License 1.1) — see fonts/LICENSES.txt. Arabic + Latin subsets only. */\n';
let fontFiles = 0, licenses = '';
for (const fam of FAMILIES) {
  for (const w of fam.weights) {
    const src = fs.readFileSync(path.join(NM, '@fontsource', fam.pkg, `${w}.css`), 'utf8');
    for (const block of src.match(/@font-face\s*{[^}]*}/g) || []) {
      const m = /url\(\.\/files\/([^)]+?-(arabic|latin)-\d+-normal\.woff2)\)/.exec(block);
      if (!m) continue;
      const file = m[1];
      fs.copyFileSync(path.join(NM, '@fontsource', fam.pkg, 'files', file), path.join(OUT, 'fonts', file));
      fontFiles++;
      css += block.replace(/src:[^;]+;/, `src: url(fonts/${file}) format('woff2');`) + '\n';
    }
  }
  const lic = path.join(NM, '@fontsource', fam.pkg, 'LICENSE');
  if (fs.existsSync(lic)) licenses += `===== @fontsource/${fam.pkg} =====\n${fs.readFileSync(lic, 'utf8').trim()}\n\n`;
}
fs.writeFileSync(path.join(OUT, 'fonts.css'), css);
fs.writeFileSync(path.join(OUT, 'fonts', 'LICENSES.txt'), licenses);

const ICON_NAMES = `
shopping-cart wrench boxes chart-column smartphone settings lock lock-keyhole lock-open sun moon monitor
search scan-barcode scan-line x plus minus trash-2 user user-plus users user-round banknote wallet
credit-card landmark calendar-clock notebook-pen hand-coins zap receipt receipt-text printer message-circle
check check-check circle-check circle-alert triangle-alert info flame refresh-ccw shield shield-check
plug-zap cable headphones battery-charging package package-plus pause play percent keyboard calculator
clock calendar phone send arrow-down-to-line arrow-up-from-line arrow-left arrow-right chevron-down
chevron-left chevron-right chevron-up eye eye-off store image upload palette type a-large-small hash
database hard-drive usb qr-code wifi history trending-up trending-down list layout-grid filter tag
sparkles signal file-text download rotate-ccw log-out delete coins pencil save star layers bell
clipboard-list scan camera droplets fingerprint power map-pin building-2 badge-percent
arrow-left-right recycle circle-user-round wallet-cards gauge memory-stick car package-search
circle-dot ellipsis-vertical undo-2 badge-check sliders-horizontal
watch arrow-up arrow-down users-round tags folder-plus radio circle-plus image-plus
`.trim().split(/\s+/);
const icons = {}, missing = [];
for (const n of ICON_NAMES) {
  const f = path.join(NM, 'lucide-static', 'icons', `${n}.svg`);
  if (!fs.existsSync(f)) { missing.push(n); continue; }
  const svg = fs.readFileSync(f, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/\s*\n\s*/g, '').trim();
  icons[n] = inner;
}
const ver = JSON.parse(fs.readFileSync(path.join(NM, 'lucide-static', 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(OUT, 'icons.js'),
  `// Lucide icons v${ver} (ISC License) — https://lucide.dev\n'use strict';\nconst ICONS = ${JSON.stringify(icons, null, 0).replace(/","/g, '",\n"')};\n`);
console.log(`fonts: ${fontFiles} files; icons: ${Object.keys(icons).length}; missing: ${missing.join(', ') || 'none'}`);
