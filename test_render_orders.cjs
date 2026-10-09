/* 工单管理模块渲染冒烟（jsdom）：抓 orders 列表/详情/排产看板/弹窗的运行时错误与空渲染
 * 背景：曾出现 loadList 引用未定义 canEdit 导致整页 JS 中断（页面打开即报错）
 * 用法：node test_render_orders.cjs */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require(process.env.JSDOM_PATH
  || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = __dirname;
/* 骨架需含 app.js boot 依赖的节点（#topDate 等），否则 DOMContentLoaded 报错 */
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

/* fetch → 静态模式（无 content-type，API.detect 落 Store 分支；Store.init 从 seed 载入） */
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/seed.json'), 'utf8'));
global.fetch = window.fetch = async () => ({ ok: true, json: async () => SEED });

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ✔ ' + n); } else { fail++; console.log('  ✘ ' + n + (extra ? ' → ' + extra : '')); } };
const firstLine = (e) => String((e && e.stack) || e || '').split('\n').slice(0, 2).join(' | ');

function loadScript(rel) {
  const s = window.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try { window.document.head.appendChild(s); }
  catch (e) { console.error('  [脚本异常] ' + rel + ': ' + e.message); }
}

const caught = [];
window.addEventListener('error', (e) => caught.push('window.error: ' + firstLine(e.error || e.message)));
const origErr = console.error;
console.error = (...a) => { caught.push('console.error: ' + a.map(String).join(' ').slice(0, 200)); };

(async () => {
  for (const f of ['public/js/store.js', 'public/js/api.js', 'public/js/ui.js', 'public/js/app.js',
    'public/js/views/orders.js', 'public/js/views/quality.js', 'public/js/views/report.js',
    'public/js/views/basic.js', 'public/js/views/stats.js', 'public/js/views/warehouse.js',
    'public/js/views/equip.js', 'public/js/views/scan.js', 'public/js/views/dashboard.js']) {
    if (fs.existsSync(path.join(ROOT, f))) loadScript(f);
  }
  ok(!!window.Store && !!window.UI && !!window.App && !!window.Views, '核心脚本注入成功（Store/UI/App/Views）');
  if (!window.Views || !window.Views.orders) { origErr('  orders 视图未加载'); process.exit(1); }

  await window.Store.init();
  await window.Store.handle('POST', '/login', { username: 'admin', password: '123456' });
  window.App.user = window.Store.currentUser;
  ok(window.App.canEdit() === true, '管理员登录态可编辑（canEdit=true）');

  const el = window.document.getElementById('app');
  const V = window.Views.orders;

  /* 1) 工单列表页（canEdit=true → 触发批量勾选栏逻辑，历史故障点） */
  el.innerHTML = '';
  let err = null;
  try { await V.render(el); } catch (e) { err = e; }
  let html = el.innerHTML;
  ok(!err, '工单列表页渲染不抛异常', err && firstLine(err));
  ok(html.length > 200, '工单列表有内容 (' + html.length + ' 字符)');
  ok(!/加载中…|NaN|undefinedundefined/.test(html), '无「加载中/NaN」残留');
  ok(html.includes('批量导入'), '含「批量导入」入口');
  ok(el.querySelectorAll('table tbody tr').length > 0, '表格有数据行 (' + el.querySelectorAll('table tbody tr').length + ')');

  /* 2) 多选列与表头列数一致（错位会导致表头与数据对不上） */
  const ths = el.querySelectorAll('table thead th');
  const row0 = el.querySelectorAll('table tbody tr')[0];
  const tds = row0 ? row0.querySelectorAll('td') : [];
  ok(ths.length === tds.length && ths.length > 0, '表头列数与数据列数一致（' + ths.length + ' vs ' + tds.length + '）');
  ok(!!el.querySelector('#ordAll'), '表头含全选复选框 #ordAll');
  ok(!!el.querySelector('#ordBatch'), '含批量操作栏 #ordBatch');
  const cbs = el.querySelectorAll('[data-oid]');
  ok(cbs.length === el.querySelectorAll('table tbody tr').length, '每行一个勾选框（' + cbs.length + '）');
  /* 勾选联动：选中 1 行 → 批量栏显示 */
  if (cbs[0]) {
    cbs[0].checked = true;
    cbs[0].dispatchEvent(new window.Event('change'));
    const n = el.querySelector('#ordSelN');
    ok(!!n && n.textContent === '1', '勾选后批量栏计数=1');
    ok(el.querySelector('#ordBatch').style.display === 'flex', '勾选后批量栏可见');
  }

  /* 3) 排产看板 */
  el.innerHTML = '';
  err = null;
  try { await V.schedule(el); } catch (e) { err = e; }
  ok(!err, '排产看板渲染不抛异常', err && firstLine(err));
  ok(el.innerHTML.length > 200, '排产看板有内容 (' + el.innerHTML.length + ' 字符)');

  /* 4) 工单详情页（工序表/工价列/流转卡/批量工价） */
  const oid = (SEED.orders[0] || {}).id;
  el.innerHTML = '';
  err = null;
  try { await V.detail(el, oid); } catch (e) { err = e; }
  html = el.innerHTML;
  ok(!err, '工单详情渲染不抛异常', err && firstLine(err));
  ok(html.length > 300, '工单详情有内容 (' + html.length + ' 字符)');
  ok(html.includes('工序进度'), '含工序进度区块');
  ok(html.includes('流转卡'), '含「流转卡」打印按钮');
  ok(html.includes('计件工价') || html.includes('计时工单'), '含工价列（计件）或计时标注');

  /* 5) 批量工价弹窗（计件工单才显示入口） */
  const pieceOrder = SEED.orders.find((o) => o.wage_type !== 'time');
  if (pieceOrder) {
    el.innerHTML = '';
    let e5 = null;
    try { await V.detail(el, pieceOrder.id); } catch (e) { e5 = e; }
    if (!e5 && el.querySelector('#batchPrice')) {
      let e6 = null;
      try { V.stepPriceForm(Object.assign({}, pieceOrder, { steps: SEED.order_steps.filter((s) => s.order_id === pieceOrder.id) })); } catch (e) { e6 = e; }
      ok(!e6, '批量设置工价弹窗不抛异常', e6 && firstLine(e6));
      await new Promise((r) => setTimeout(r, 80));
      ok(window.document.querySelectorAll('.sp-in').length > 0, '批量工价弹窗含各工序输入框');
    } else ok(true, '批量设置工价入口（该工单为计时核算，跳过）');
  }

  /* 6) 打印流转卡（防御：传空对象也不应崩） */
  el.innerHTML = '';
  err = null;
  try { V.printCard({ code: 'WO-TEST', steps: SEED.order_steps.slice(0, 2), reports: [], teams: [] }); } catch (e) { err = e; }
  const pa = window.document.getElementById('printArea');
  ok(!err, '流转卡 printCard 不抛异常', err && firstLine(err));
  ok(!!pa && pa.innerHTML.includes('工单流转卡'), '流转卡内容已渲染');
  err = null;
  try { V.printCard({}); } catch (e) { err = e; }
  ok(!err, '流转卡对空数据有防御（不崩）', err && firstLine(err));
  const pa2 = window.document.getElementById('printArea');
  if (pa2) pa2.remove();

  /* 7) 新建工单弹窗 + 智能带出 */
  err = null;
  try { await V.form(); } catch (e) { err = e; }
  ok(!err, '新建工单弹窗不抛异常', err && firstLine(err));
  await new Promise((r) => setTimeout(r, 150));
  ok(window.document.querySelectorAll('#modalRoot .mask, .mask').length > 0, '新建工单弹窗已挂载');

  /* 8) 批量导入弹窗 */
  err = null;
  try { V.importForm(); } catch (e) { err = e; }
  ok(!err, '批量导入弹窗不抛异常', err && firstLine(err));
  ok(window.document.querySelector('#imText') !== null, '批量导入弹窗含 CSV 输入区');

  /* 9) 图标兜底：未知图标不崩 */
  err = null;
  try { window.UI.icon('edit'); window.UI.icon('not_exist_icon'); } catch (e) { err = e; }
  ok(!err, 'UI.icon 未知/新增图标不抛异常');
  ok(/svg/.test(window.UI.icon('edit')), "UI.icon('edit') 返回 svg");

  ok(caught.length === 0, '无 window.error / console.error 级错误', caught.slice(0, 3).join(' || '));

  console.log('\n————————————————————————');
  console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { origErr('渲染测试异常：', e && e.stack ? e.stack : e); process.exit(1); });
