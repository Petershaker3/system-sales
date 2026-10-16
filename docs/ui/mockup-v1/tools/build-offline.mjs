// يبني نسخة «ملف واحد» من المعاينة تشتغل من غير سيرفر ومن غير نت:
// دبل كليك على الملف يفتحه في Chrome / Edge مباشرة (file://).
//
// Builds a single self-contained copy of the mockup (all CSS, JS and fonts inlined)
// that opens straight from disk — no server, no internet.
//
//   node build-offline.mjs            → ../mockup-offline.html
//
// المصدر الحقيقي يفضل index.html وملفاته؛ الملف الناتج مُولَّد — لا تعدّله بإيدك.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'mockup-offline.html');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

let html = read('index.html');
const swaps = [];
const replaceOnce = (needle, replacement, label) => {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error(`build-offline: لم أجد ${label} في index.html — ${needle}`);
  html = html.slice(0, at) + replacement + html.slice(at + needle.length);
  swaps.push(label);
};

// 1) الخطوط: كل url(fonts/x.woff2) تبقى data URI جوه الملف
let fontCount = 0;
const fontsCss = read('fonts.css').replace(/url\((?:'|")?fonts\/([^'")]+\.woff2)(?:'|")?\)/g, (_, file) => {
  fontCount += 1;
  const b64 = readFileSync(join(ROOT, 'fonts', file)).toString('base64');
  return `url(data:font/woff2;base64,${b64})`;
});
if (fontCount === 0) throw new Error('build-offline: fonts.css من غير أي خط');
if (/url\((?!data:)/.test(fontsCss)) throw new Error('build-offline: فاضل رابط خارجي في fonts.css');
replaceOnce('<link rel="stylesheet" href="fonts.css">', `<style>\n${fontsCss}\n</style>`, 'fonts.css');

// 2) التنسيق
const styles = read('styles.css');
if (/url\((?!data:)/.test(styles)) throw new Error('build-offline: styles.css فيها رابط خارجي — لازم يتضمّن');
replaceOnce('<link rel="stylesheet" href="styles.css">', `<style>\n${styles}\n</style>`, 'styles.css');

// 3) السكريبتات بنفس الترتيب (Classic scripts — مش modules، فبتشتغل من file://)
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
if (scripts.length === 0) throw new Error('build-offline: مفيش سكريبتات في index.html');
for (const src of scripts) {
  // «</script» جوه نص JS بيقفل الوسم بدري — نكسره من غير ما نغيّر معناه
  const js = read(src).replace(/<\/(script)/gi, '<\\/$1');
  replaceOnce(`<script src="${src}"></script>`, `<script>/* ${src} */\n${js}\n</script>`, src);
}

// 4) علامة إن ده ملف مُولَّد
const stamp = `<!--\n  ملف مُولَّد — لا تعدّله بإيدك. المصدر: index.html + fonts.css + styles.css + ${scripts.join(' + ')}.\n  إعادة البناء: cd docs/ui/mockup-v1/tools && node build-offline.mjs\n  Generated single-file build of the UI mockup: opens from disk with no server and no internet.\n-->\n`;
html = html.replace(/^<!doctype html>\n/i, (m) => m + stamp);

// الفحص على وسوم الصفحة نفسها بس — مش على قوالب HTML جوه الـ JS (زي <img src="${...}">)
const markupOnly = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const leftover = markupOnly.match(/(?:src|href)="(?!data:|#|https?:)[^"]+"/);
if (leftover) throw new Error(`build-offline: فاضل ملف خارجي مش متضمّن — ${leftover[0]}`);
writeFileSync(OUT, html);
console.log(`OK ${OUT}\n   ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB · خطوط ${fontCount} · ${swaps.join(', ')}`);
