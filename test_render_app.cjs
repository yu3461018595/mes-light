/* APP 工作台渲染冒烟（jsdom）：真实加载 store.js + api.js + m/app/app.js，
 * 驱动「登录 → 工作台 → 消息 → 我的 → 改密码」的完整视图流，断言 DOM 真的产出内容，
 * 避免「语法通过但运行时崩」的假绿。静态数据层（seed.json）驱动，不动 data/mes.db。
 * 运行： node test_render_app.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const JSDOM_PATH = process.env.JSDOM_PATH
  || 'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/jsdom';
const { JSDOM } = require(JSDOM_PATH);
const ROOT = __dirname;

const HTML = `<!doctype html><html><body>
  <header class="topbar" id="topbar">
    <div class="tb-left"><button id="tbBack" hidden></button><span id="tbTitle"></span></div>
    <div class="tb-right"><button id="tbBell"></button><i id="tbBadge" hidden></i></div>
  </header>
  <main id="view"></main>
  <nav id="tabbar" hidden>
    <a class="tab" data-tab="home"></a>
    <a class="tab" data-tab="messages"><i data-badge="messages" hidden></i></a>
    <a class="tab" data-tab="mine"></a>
  </nav>
  <div id="toastBox"></div><div id="sheetBox"></div>
</body></html>`;

const dom = new JSDOM(HTML, { url: 'http://localhost/m/app/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true, writable: true });
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.getComputedStyle = window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.alert = () => {};
// jsdom 未实现 confirm（真实浏览器有）；给 window 补上，与浏览器行为一致
window.confirm = () => true;
global.confirm = () => true;
global.URLSearchParams = window.URLSearchParams;

const mem = {};
const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; }, clear: () => { for (const k of Object.keys(mem)) delete mem[k]; } };
Object.defineProperty(global, 'localStorage', { value: ls, configurable: true, writable: true });
Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true });

const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/seed.json'), 'utf8'));
// 静态模式判定：/api/meta 返回 HTML（非 JSON）→ 走 store.js
global.fetch = window.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf('/api/meta') >= 0) return { ok: true, headers: { get: () => 'text/html' }, json: async () => ({}) };
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => SEED };
};
const nodeCrypto = require('node:crypto');
Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: { subtle: { digest: async (_a, bytes) => { const h = nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest(); return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength); } } },
});

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };
function loadScript(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const s = window.document.createElement('script');
  s.textContent = code;
  try { window.document.head.appendChild(s); } catch (e) { console.error('  [脚本异常] ' + rel + ': ' + e.message); }
}
const $ = (sel) => window.document.querySelector(sel);
const txt = () => ($('#view') ? $('#view').textContent : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) { if (fn()) return true; await sleep(20); }
  return false;
}

(async () => {
  for (const f of ['public/js/store.js', 'public/js/api.js', 'public/m/app/app.js']) loadScript(f);
  const hasApp = await waitFor(() => txt().length > 0, 3000);
  ok(hasApp, 'APP 脚本加载后产出首屏内容');

  console.log('\n【1】未登录 → 登录页');
  ok(/登录/.test(txt()) || /账号/.test(txt()), '首屏渲染登录页');
  ok(!!$('#fUser') && !!$('#fPass') && !!$('#fLogin'), '登录表单含账号/密码/登录按钮');
  ok($('#fRemember') !== null, '含「记住账号」勾选项');
  ok($('#tabbar').hidden === true, '未登录时隐藏底部导航');

  console.log('\n【2】登录成功 → 工作台');
  $('#fUser').value = 'admin';
  $('#fPass').value = '123456';
  $('#fLogin').click();
  const onHome = await waitFor(() => /工作台|你好/.test(txt()) && $('#tabbar').hidden === false, 4000);
  ok(onHome, '登录后进入工作台并显示底部导航');
  ok(/你好/.test(txt()), '工作台显示问候语');
  ok(/待报工单|待办异常|未读消息/.test(txt()), '工作台显示统计磁贴');
  ok(window.document.querySelectorAll('#tabbar .tab').length === 3, '底部导航含 3 个页签');
  ok(window.document.querySelector('#tabbar .tab[data-tab="home"]').classList.contains('on'), '工作台页签高亮');
  ok(/我的在制工单/.test(txt()), '工作台渲染「我的在制工单」卡片');
  ok(!!$('#tbBadge'), '顶栏有消息角标元素');

  console.log('\n【3】消息中心');
  window.location.hash = '#/messages';
  window.dispatchEvent(new window.Event('hashchange'));
  const onMsg = await waitFor(() => /全部标为已读|暂无消息/.test(txt()), 4000);
  ok(onMsg, '消息页渲染成功');
  ok(/全部|质量异常|库存预警|派工待办|系统消息/.test(txt()), '消息页含场景筛选按钮');
  ok(!!$('#msgAllRead'), '含「全部标为已读」按钮');
  ok($('#tbTitle').textContent === '消息', '顶栏标题切到「消息」');
  ok(window.document.querySelector('#tabbar .tab[data-tab="messages"]').classList.contains('on'), '消息页签高亮');
  const segs = window.document.querySelectorAll('#view .seg button');
  ok(segs.length >= 5, '场景筛选按钮数 ≥5（全部+4类）');
  segs[1].click();
  await sleep(400);
  ok(segs[1].className.indexOf('on') >= 0 || window.document.querySelectorAll('#view .seg button')[1].classList.contains('on'), '点击场景筛选后按钮高亮切换');

  console.log('\n【4】我的页');
  window.location.hash = '#/mine';
  window.dispatchEvent(new window.Event('hashchange'));
  const onMine = await waitFor(() => /修改登录密码|退出登录/.test(txt()), 4000);
  ok(onMine, '我的页渲染成功');
  ok(/系统管理员|管理员/.test(txt()), '显示当前用户姓名与角色');
  ok(/修改登录密码/.test(txt()) && /修改姓名/.test(txt()), '含修改密码 / 修改姓名入口');
  ok(/接收消息通知/.test(txt()) && !!$('#mPush'), '含消息通知开关');
  ok(!!$('#mLogout'), '含退出登录按钮');
  ok(/未读消息/.test(txt()), '我的页显示未读消息统计');

  console.log('\n【5】修改密码页');
  window.location.hash = '#/password';
  window.dispatchEvent(new window.Event('hashchange'));
  const onPwd = await waitFor(() => /原密码/.test(txt()), 4000);
  ok(onPwd, '修改密码页渲染成功');
  ok(!!$('#pwOld') && !!$('#pwNew') && !!$('#pwNew2'), '含原密码/新密码/确认新密码三个输入');
  ok(!!$('#pwSave'), '含确认修改按钮');
  $('#pwOld').value = '123456';
  $('#pwNew').value = 'abc';
  $('#pwNew2').value = 'abc';
  document.getElementById('toastBox').innerHTML = '';
  $('#pwSave').click();
  await sleep(300);
  ok(/至少 6 位|6 位/.test(document.body.textContent), '新密码过短时给出提示');
  // 清掉上一条提示，确保下面断言的是「不一致」这一条，而不是旧 toast 残留
  document.getElementById('toastBox').innerHTML = '';
  $('#pwOld').value = '123456';
  $('#pwNew').value = 'abcd1234';
  $('#pwNew2').value = 'abcd9999';
  $('#pwSave').click();
  await sleep(300);
  ok(/不一致/.test(document.body.textContent), '两次输入不一致时给出提示');
  if (process.env.DBG) console.log('   [DBG toastBox]', JSON.stringify((document.getElementById('toastBox') || {}).innerHTML), '| pw route=', window.location.hash);
  console.log('\n【6】修改姓名页');
  window.location.hash = '#/profile';
  window.dispatchEvent(new window.Event('hashchange'));
  const onProf = await waitFor(() => /账号 \/ 工号|工号/.test(txt()), 4000);
  ok(onProf, '资料页渲染成功');
  ok(!!$('#pName') && !!$('#pSave'), '含姓名输入与保存按钮');

  console.log('\n【7】报工页（真实工单）');
  window.location.hash = '#/home';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => /我的在制工单/.test(txt()), 4000);
  const orderEl = window.document.querySelector('#view [data-order]');
  if (orderEl) {
    orderEl.click();
    const onOrder = await waitFor(() => /提交报工|选择工序/.test(txt()), 4000);
    ok(onOrder, '点击工单进入报工页');
    ok($('#tbTitle').textContent === '报工', '顶栏标题切到「报工」');
    ok(window.document.querySelectorAll('#view .step').length > 0, '渲染工序列卡片（' + window.document.querySelectorAll('#view .step').length + ' 道）');
    const firstStep = window.document.querySelector('#view .step');
    firstStep.click();
    await sleep(400);
    const sel = window.document.querySelector('#view .step.sel');
    ok(!!sel, '点击工序卡片后进入选中态');
    ok(window.document.querySelectorAll('#view .stepper').length > 0, '选中后出现合格数量步进器');
    ok(!!window.document.querySelector('#view .badrows .brow'), '出现不良明细行');
    if (process.env.DBG) {
      const br = window.document.querySelector('#view .badrows');
      console.log('   [DBG badrows]', br ? JSON.stringify(br.innerHTML.slice(0, 220)) : 'NO .badrows');
      console.log('   [DBG steps]', JSON.stringify(window.document.querySelectorAll('#view .step').length));
      console.log('   [DBG sel]', JSON.stringify([...window.document.querySelectorAll('#view .step.sel')].map((e) => e.dataset.s)));
    }
    ok(!!$('#submit'), '出现提交报工按钮');
  } else {
    ok(true, '（无在制工单，跳过报工页渲染校验）');
  }

  console.log('\n【8】登出回到登录页');
  window.location.hash = '#/mine';
  window.dispatchEvent(new window.Event('hashchange'));
  const mineReady = await waitFor(() => !!$('#mLogout'), 4000);
  ok(mineReady, '我的页含退出登录按钮');
  if (mineReady) {
    $('#mLogout').click();
    await sleep(600);
    if (process.env.DBG) console.log('   [DBG logout] hash=', window.location.hash, '| fLogin=', !!$('#fLogin'), '| token=', typeof localStorage !== 'undefined' ? JSON.stringify(localStorage.getItem('mes_token')) : 'n/a', '| view=', txt().slice(0, 80).replace(/\n/g, ' '));
    const backLogin = await waitFor(() => !!$('#fLogin'), 4000);
    ok(backLogin, '退出登录后回到登录页');
    ok($('#tabbar').hidden === true, '登出后隐藏底部导航');
  } else {
    ok(false, '退出登录后回到登录页');
    ok(false, '登出后隐藏底部导航');
  }

  console.log('\n————————————————————————');
  console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error('渲染测试异常：', e); process.exitCode = 1; });
