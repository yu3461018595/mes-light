/**
 * 组装 Capacitor 的 webDir（app/www）—— 把「静态模式」的移动端工作台打成可离线运行的 H5 包。
 *
 * 用途：脱离服务器跑 APK 时（capacitor.config.json 里不配 server.url），
 *      把这份 www/ 直接打进 APK 内置 WebView。
 *
 * 做法：复用仓库既有的静态模式（public/js/store.js 走 localStorage + seed.json），
 *      APP 外壳 public/m/app/ 当作页面，并注入一个「静态模式」标记文件。
 *
 * 用法： node app/build_www.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(__dirname, 'www');

// 需要原样拷进 www/ 的静态资源（相对 public/）
const COPY = [
  'data/seed.json',
  'js/store.js',
  'js/api.js',
  'lib/qrcode.js',
  'icon-512.png',
  'manifest.json',
];

// APP 外壳页面（public/m/app/）→ www/ 根
const SHELL = ['index.html', 'app.css', 'app.js'];
const SHELL_SRC = path.join(PUB, 'm', 'app');

if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
};

let bytes = 0;
const missing = [];

// 1) APP 外壳
for (const f of SHELL) {
  const src = path.join(SHELL_SRC, f);
  if (!fs.existsSync(src)) { missing.push('m/app/' + f); continue; }
  bytes += copyFile(src, path.join(OUT, f));
}
// shell 页面里的绝对路径（/js/store.js、/lib/qrcode.js）在 file:// 下会失效，
// 改成相对路径；并把 /m/app/ 前缀去掉（外壳文件已平铺到 www/ 根目录）。
const idx = path.join(OUT, 'index.html');
if (fs.existsSync(idx)) {
  let html = fs.readFileSync(idx, 'utf8');
  html = html.replace(/(src|href)="\/m\/app\//g, '$1="./');
  html = html.replace(/(src|href)="\/(?!\/)/g, '$1="./');
  fs.writeFileSync(idx, html);
}

// 2) 其余静态资源
for (const rel of COPY) {
  const src = path.join(PUB, rel);
  if (!fs.existsSync(src)) { missing.push(rel); continue; }
  bytes += copyFile(src, path.join(OUT, rel));
}

// seed.json 里的值都是「相对路径」引用，无需改写

console.log('已生成 app/www  (' + (bytes / 1024).toFixed(1) + ' KB)');
console.log('  页面: index.html + app.css + app.js');
console.log('  数据: data/seed.json（静态模式，localStorage 持久化）');
if (missing.length) {
  console.warn('\n以下资源缺失，APK 可能白屏：');
  for (const m of missing) console.warn('  ✗ public/' + m);
  process.exit(1);
}
console.log('\n下一步： cd app && npx cap sync android');
