/* 全视图渲染巡检（jsdom）：逐个渲染 PC 端所有视图，捕获运行时错误（ReferenceError/TypeError 等）
 * 背景：orders.loadList 曾因引用未定义 canEdit 导致整页 JS 中断（页面打开即报错、列表空白）
 * 用法：node test_render_views.cjs */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require(process.env.JSDOM_PATH
  || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = __dirname;
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="topDate"></div><div id="toastRoot"></div><div id="modalRoot"></div>
  <div id="login" class="login hidden"><form id="loginForm"><input id="lgUser"><input id="lgPwd" type="password"><button>登录</button></form></div>
  <div id="app"></div><div id="view"></div><div id="notifyBell"></div>
</body></html>`, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;

global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.getComputedStyle = window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.alert = () => {};
global.confirm = () => true;
global.print = () => {};

const mem = {};
const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; }, clear: () => { for (const k of Object.keys(mem)) delete mem[k]; } };
Object.defineProperty(global, 'localStorage', { value: ls, configurable: true, writable: true });
Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true });

const nodeCrypto = require('node:crypto');
Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: { subtle: { digest: async (_a, bytes) => {
    const h = nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest();
    return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
  } } },
});
window.URL.createObjectURL = () => 'blob:mock';
window.URL.revokeObjectURL = () => {};

const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/seed.json'), 'utf8'));
global.fetch = window.fetch = async () => ({ ok: true, json: async () => SEED });

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✔ ' + n); } else { fail++; console.log('  ✘ ' + n + (extra ? ' → ' + extra : '')); } };
const brief = (e) => String((e && e.stack) || e || '').split('\n').slice(0, 2).join(' | ').slice(0, 220);

function loadScript(rel) {
  const s = window.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try { window.document.head.appendChild(s); }
  catch (e) { console.error('  [脚本异常] ' + rel + ': ' + e.message); }
}

(async () => {
  for (const f of ['public/js/store.js', 'public/js/api.js', 'public/js/ui.js', 'public/js/app.js',
    'public/js/views/basic.js', 'public/js/views/orders.js', 'public/js/views/report.js',
    'public/js/views/quality.js', 'public/js/views/warehouse.js', 'public/js/views/equip.js',
    'public/js/views/stats.js', 'public/js/views/scan.js', 'public/js/views/dashboard.js']) {
    if (fs.existsSync(path.join(ROOT, f))) loadScript(f);
  }
  await window.Store.init();
  await window.Store.handle('POST', '/login', { username: 'admin', password: '123456' });
  window.App.user = window.Store.currentUser;
  const V = window.Views;
  ok(!!V, 'Views 注入成功');

  const el = window.document.getElementById('view');
  const arr = (k) => (Array.isArray(SEED[k]) ? SEED[k] : []);
  const oid = (arr('orders')[0] || {}).id;
  const qid = (arr('quality_issues')[0] || {}).id || 1;
  const eid = (arr('equipments')[0] || {}).id || 1;

  /* 巡检表：[显示名, 视图, 参数数组] —— 覆盖每个视图的主入口与关键子页 */
  const CASES = [
    ['看板/首页', () => V.dashboard.render(el), []],
    ['工单列表', () => V.orders.render(el), []],
    ['排产看板', () => V.orders.schedule(el), []],
    ['工单详情', () => V.orders.detail(el, oid), []],
    ['报工页', () => V.report.render(el, oid), []],
    ['质量-待检', () => V.quality.render(el, 'pending'), []],
    ['质量-判定记录', () => V.quality.render(el, 'done'), []],
    ['质量-异常单', () => V.quality.render(el, 'issues'), []],
    ['质量-统计', () => V.quality.render(el, 'stats'), []],
    ['质量-设置', () => V.quality.render(el, 'settings'), []],
    ['质量-模板', () => V.quality.render(el, 'checklists'), []],
    ['异常单详情', () => V.quality.renderIssue(el, qid), []],
    ['仓储-库存台账', () => V.warehouse.render(el, 'stock'), []],
    ['仓储-来料入库', () => V.warehouse.render(el, 'incoming'), []],
    ['仓储-领料退料', () => V.warehouse.render(el, 'issues'), []],
    ['仓储-成品入库', () => V.warehouse.render(el, 'finished'), []],
    ['仓储-成品出库', () => V.warehouse.render(el, 'ship'), []],
    ['仓储-产出比', () => V.warehouse.render(el, 'yield'), []],
    ['仓储-物料档案', () => V.warehouse.render(el, 'materials'), []],
    ['仓储-产销报表', () => V.warehouse.render(el, 'report'), []],
    ['仓储-仓库', () => V.warehouse.render(el, 'warehouses'), []],
    ['仓储-销售订单', () => V.warehouse.render(el, 'sales'), []],
    ['仓储-收发明细', () => { V.warehouse.tab = 'tx'; V.warehouse.txView = ''; return V.warehouse.render(el); }, []],
    ['仓储-收发存汇总', () => { V.warehouse.tab = 'tx'; V.warehouse.txView = 'summary'; return V.warehouse.render(el); }, []],
    ['设备-台账', () => V.equip.render(el), []],
    ['设备-稼动分析', () => { V.equip.subTab = 'util'; return V.equip.render(el); }, []],
    ['设备-模具管理', () => { V.equip.subTab = 'mold'; return V.equip.render(el); }, []],
    ['基础-产品', () => V.basic.render(el, 'products'), []],
    ['基础-工序', () => V.basic.render(el, 'processes'), []],
    ['基础-工艺路线', () => V.basic.render(el, 'routes'), []],
    ['基础-工位/设备', () => V.basic.render(el, 'workCenters'), []],
    ['基础-人员', () => V.basic.render(el, 'users'), []],
    ['基础-客户', () => V.basic.render(el, 'customers'), []],
    ['统计-总览', () => V.stats.render(el, 'overview'), []],
    ['统计-生产', () => V.stats.render(el, 'production'), []],
    ['统计-质量', () => V.stats.render(el, 'quality'), []],
    ['统计-设备', () => V.stats.render(el, 'equip'), []],
    ['统计-工资', () => V.stats.render(el, 'wage'), []],
    ['扫码工作台', () => V.scan.render(el), []],
  ];

  console.log('— 逐视图渲染 —');
  const emptyViews = [];
  for (const [name, fn] of CASES) {
    el.innerHTML = '';
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    const len = el.innerHTML.length;
    if (err) ok(false, name + ' 渲染', brief(err));
    else if (len < 120) { emptyViews.push(name + '(' + len + ')'); ok(true, name + ' 渲染（内容偏少 ' + len + '）'); }
    else ok(true, name + ' 渲染（' + len + ' 字符）');
  }
  ok(emptyViews.length === 0, '无「空壳页面」（内容 < 120 字符）', emptyViews.join(', '));

  /* 关键页内容断言 */
  el.innerHTML = '';
  await V.orders.render(el);
  ok(el.querySelectorAll('table tbody tr').length > 0, '工单列表有数据行');
  el.innerHTML = '';
  await V.dashboard.render(el);
  ok(el.innerHTML.length > 300, '看板有内容');

  console.log('\n————————————————————————');
  console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('巡检异常：', e && e.stack ? e.stack : e); process.exit(1); });
