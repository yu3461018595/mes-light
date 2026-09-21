/* 前端渲染冒烟：在 jsdom 里真实加载 store.js + app.js + 各视图，渲染「质量」中心 5 个标签页，
 * 校验 DOM 真的产出了预期的表/卡片/按钮，避免"语法通过但运行时崩"的假绿。
 * 运行： NODE_PATH=<jsdom 所在 node_modules> node test_render_quality.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
// jsdom 装在隔离工作区，用绝对路径 require（Windows 下 NODE_PATH 对 CJS 不可靠）
const JSDOM_PATH = process.env.JSDOM_PATH
  || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/jsdom';
const { JSDOM } = require(JSDOM_PATH);

const ROOT = __dirname;
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div class="topbar-right"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'dangerously', // 必须开启，否则注入的 <script> 不会执行
});
const { window } = dom;

// 浏览器全局
global.window = window;
global.document = window.document;
// Node 22 的 global.navigator 是只读 getter，需用 defineProperty 覆盖
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.getComputedStyle = window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.alert = () => {};
global.confirm = () => true;

// 简易 localStorage（jsdom 的 window.localStorage 同为只读，需覆盖）
const mem = {};
const ls = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
};
Object.defineProperty(global, 'localStorage', { value: ls, configurable: true, writable: true });
Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true });

// fetch → 读 seed.json（静态模式）
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/seed.json'), 'utf8'));
global.fetch = window.fetch = async () => ({ ok: true, json: async () => SEED });

// jsdom 未实现 crypto.subtle，用 node:crypto 补上，使静态层的 sha256hex 可用
const nodeCrypto = require('node:crypto');
Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: {
    subtle: {
      digest: async (_alg, bytes) => {
        const h = nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest();
        return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
      },
    },
  },
});

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };

const injected = [];
function loadScript(rel) {
  // 用真实 <script> 注入，作用域与浏览器完全一致（window.eval 的作用域链不含 window 属性）
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const s = window.document.createElement('script');
  s.textContent = code;
  try {
    window.document.head.appendChild(s);
  } catch (e) {
    console.error('  [脚本异常] ' + rel + ': ' + e.message);
  }
  injected.push(rel);
}

(async () => {
  // 依次加载前端脚本（顺序与 index.html 一致的关键部分）
  for (const f of [
    'public/js/store.js', 'public/js/api.js', 'public/js/ui.js', 'public/js/app.js',
    'public/js/views/dashboard.js', 'public/js/views/orders.js', 'public/js/views/quality.js',
  ]) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.log('  (跳过不存在的文件 ' + f + ')'); continue; }
    loadScript(f);
  }
  ok(!!window.Store, 'Store 已加载');
  if (!window.Store) {
    console.error('  已注入：' + injected.join(', '));
    process.exit(1);
  }
  ok(!!window.Views, 'Views 命名空间已加载');
  ok(!!(window.Views && window.Views.quality), 'Views.quality 已注册');

  await window.Store.init();
  const r = await window.Store.handle('POST', '/login', { username: 'admin', password: '123456' });
  ok(r.ok, '静态模式 admin 登录成功');

  const Q = window.Views.quality;
  const el = window.document.getElementById('app');

  // render 为异步：切换 tab 后 await，再读 innerHTML
  const renderTab = async (tab) => {
    el.innerHTML = '';
    Q.tab = tab;
    await Q.render(el, '');
    return el.innerHTML;
  };

  // 1) 待检队列
  let html = await renderTab('pending');
  ok(html.length > 0, '待检队列渲染有内容 (' + html.length + ' 字符)');
  ok(/待检/.test(html), '待检页含「待检」文案');

  // 2) 异常单
  html = await renderTab('issues');
  ok(html.length > 0, '异常单页渲染有内容 (' + html.length + ' 字符)');
  ok(/异常/.test(html), '异常单页含「异常」文案');

  // 3) 检验记录
  html = await renderTab('records');
  ok(html.length > 0, '检验记录页渲染有内容');
  ok(/检验记录/.test(html), '记录页含「检验记录」文案');

  // 4) 质量看板
  html = await renderTab('dash');
  ok(html.length > 0, '质量看板页渲染有内容');

  // 5) 检验设置
  html = await renderTab('setup');
  ok(html.length > 0, '检验设置页渲染有内容');
  ok(/webhook|提醒|超时/i.test(html), '设置页含通知配置项');

  // 6) 辅助方法（被 orders.js / dashboard.js 复用）
  ok(typeof Q.inspectMark === 'function', 'inspectMark 可用（工单表检验列）');
  const markHtml = Q.inspectMark({ inspect_type: 'fqc', inspect_status: 'waiting' });
  ok(typeof markHtml === 'string' && markHtml.length > 0, 'inspectMark 输出非空');
  ok(typeof Q.levelChip === 'function', 'levelChip 可用');
  ok(typeof Q.statusChip === 'function', 'statusChip 可用');
  ok(typeof Q.newIssueForm === 'function', 'newIssueForm 可用（工单页上报异常）');

  // 7) 通知组件已挂载
  ok(!!window.Notify, 'Notify 通知组件已定义');
  try {
    window.Notify.mount();
    ok(!!window.document.querySelector('.bell'), '通知铃铛已插入顶栏');
  } catch (e) { ok(false, '通知铃铛挂载异常：' + e.message); }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
