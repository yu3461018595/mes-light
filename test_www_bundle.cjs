/* 离线 H5 包（app/www）冒烟：直接读 build_www.js 产出的 www/，用 file:// 等价方式加载，
 * 断言「不依赖后端也能渲染登录页」以及所有资源路径可解析。
 * 运行： node test_www_bundle.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const JSDOM_PATH = process.env.JSDOM_PATH
  || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/jsdom';
const { JSDOM } = require(JSDOM_PATH);
const ROOT = __dirname;
const WWW = path.join(ROOT, 'app', 'www');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };

(async () => {
  console.log('【1】离线包存在性与资源完整性');
  ok(fs.existsSync(WWW), 'app/www 目录已生成');
  if (!fs.existsSync(WWW)) { console.log(`\n共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`); process.exit(1); }

  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  ok(refs.length >= 6, `index.html 含 ${refs.length} 个相对资源引用`);
  const missing = refs.filter((r) => !fs.existsSync(path.join(WWW, r)));
  ok(missing.length === 0, missing.length ? '缺失资源：' + missing.join(', ') : '所有引用资源齐全');
  ok(!/(?:src|href)="\/[^/]/.test(html), '未残留绝对路径引用（file:// 下会 404）');

  console.log('\n【2】关键文件与语法');
  for (const f of ['app.js', 'app.css', 'js/store.js', 'js/api.js', 'lib/qrcode.js', 'data/seed.json']) {
    ok(fs.existsSync(path.join(WWW, f)), f + ' 存在');
  }
  const seed = JSON.parse(fs.readFileSync(path.join(WWW, 'data', 'seed.json'), 'utf8'));
  ok(Array.isArray(seed.users) && seed.users.length >= 10, `seed.json 含 ${seed.users.length} 个用户`);
  ok(Array.isArray(seed.orders) && seed.orders.length >= 5, `seed.json 含 ${seed.orders.length} 张工单`);

  // 语法检查：把 app.js / store.js 交给 vm 解析，能过即无语法错误
  const vm = require('node:vm');
  let syntaxOk = true, err = '';
  for (const f of ['app.js', 'js/store.js', 'js/api.js']) {
    try { new vm.Script(fs.readFileSync(path.join(WWW, f), 'utf8'), { filename: f }); }
    catch (e) { syntaxOk = false; err += `${f}: ${e.message}; `; }
  }
  ok(syntaxOk, syntaxOk ? 'app.js / store.js / api.js 语法均正确' : '语法错误：' + err);

  console.log('\n【3】离线渲染：不连后端也能出登录页');
  const dom = new JSDOM(html, { url: 'http://localhost/m/app/', pretendToBeVisual: true, runScripts: 'dangerously', resources: undefined });
  const { window } = dom;
  if (process.env.DBG) {
    window.addEventListener('error', (e) => console.log('   [DBG win.error]', e.message));
    window.addEventListener('unhandledrejection', (e) => console.log('   [DBG win.unhandled]', e.reason && e.reason.message));
  }
  global.window = window;
  global.document = window.document;
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
  global.location = window.location;
  global.Event = window.Event;
  global.CustomEvent = window.CustomEvent;
  global.HTMLElement = window.HTMLElement;
  global.Node = window.Node;
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.alert = () => {};
  global.confirm = () => true;
  window.confirm = () => true;
  global.URLSearchParams = window.URLSearchParams;

  const mem = {};
  const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; }, clear: () => { for (const k of Object.keys(mem)) delete mem[k]; } };
  Object.defineProperty(global, 'localStorage', { value: ls, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true });

  const nodeCrypto = require('node:crypto');
  Object.defineProperty(window, 'crypto', {
    configurable: true,
    value: { subtle: { digest: async (_a, bytes) => { const h = nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength); } } },
  });

  // 模拟 Capacitor WebView 的离线环境：没有后端（/api/* 全失败），
  // 但 www/ 内的相对静态资源（./data/seed.json）可以读到——这正是打包后的真实情况。
  const SEED_JSON = JSON.parse(fs.readFileSync(path.join(WWW, 'data', 'seed.json'), 'utf8'));
  global.fetch = window.fetch = async (url) => {
    const u = String(url);
    if (/\/api\//.test(u)) throw new Error('offline: no backend');
    if (/data\/seed\.json/.test(u)) {
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => SEED_JSON };
    }
    throw new Error('offline: ' + u);
  };

  // 手工按 index.html 顺序注入脚本（jsdom 不会自动加载 file:// 子资源）
  for (const rel of refs.filter((r) => r.endsWith('.js'))) {
    const s = window.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(WWW, rel), 'utf8');
    try {
      window.document.head.appendChild(s);
      if (process.env.DBG) console.log('   [DBG] 已注入', rel);
    } catch (e) { console.log('  [脚本异常]', rel, e.message); }
  }
  if (process.env.DBG) {
    console.log('   [DBG] typeof API=', typeof window.API, '| typeof Store=', typeof window.Store);
    console.log('   [DBG] hash=', window.location.hash);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => window.document.querySelector(sel);
  const txt = () => ($('#view') ? $('#view').textContent : '');

  // 注意：index.html 里预置了「加载中…」占位，不能用「有内容」当完成条件，
  // 必须等到真正的登录表单出现。
  let seen = '';
  for (let i = 0; i < 200; i++) {
    if ($('#fLogin')) { seen = txt(); break; }
    await sleep(20);
  }
  if (process.env.DBG) {
    console.log('   [DBG] 1st seen=', JSON.stringify(seen.slice(0, 30)));
    // 直接调一次，看是 detect 卡住还是 route 卡住
    try {
      const m = await window.API.detect();
      console.log('   [DBG] detect() =>', m);
      console.log('   [DBG] Store 用户数 =', window.Store && window.Store.all ? 'has all' : (typeof window.Store));
    } catch (e) { console.log('   [DBG] detect 抛错:', e.message); }
    const v = window.document.getElementById('view');
    console.log('   [DBG] view.innerHTML 前 80 =', JSON.stringify((v ? v.innerHTML : '').slice(0, 80)));
  }
  ok(seen.length > 0, '离线加载后渲染出首屏（等到登录表单出现）');
  ok(!!$('#fUser') && !!$('#fPass') && !!$('#fLogin'), '离线态渲染出登录表单（账号/密码/登录按钮）');
  ok(!/加载中/.test(txt()), '占位「加载中…」已被真实页面替换');
  ok(/智工|移动工作台/.test(window.document.body.textContent), '含 APP 品牌标题');

  console.log('\n————————————————————————');
  console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
