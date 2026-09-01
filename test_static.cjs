/* 静态数据层冒烟测试：在 Node 中以浏览器全局环境模拟运行 store.js
 * 注意：演示数据已被清空，这里自举最小基础数据（product/process/wc/route/order 各 id=1），
 * 以覆盖登录、会话恢复、工单聚合、报工与撤销、统计、二维码、免登录 H5、引用保护、工单增删。
 */
const fs = require('fs');
const path = require('path');

const mem = {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
const SEED = path.join(__dirname, 'public/data/seed.json');
globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(SEED, 'utf8')) });

const Store = require('./public/js/store.js');

function assert(cond, msg) { if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; } else { console.log('  ✓', msg); } }

(async () => {
  await Store.init();

  // 登录
  let r = await Store.handle('POST', '/login', { username: 'admin', password: '123456' });
  assert(r.ok && r.data.token === 'static-1', 'admin 登录成功，token=' + (r.data && r.data.token));
  assert(Store.restoreFromToken(r.data.token), 'restoreFromToken 恢复会话');

  // 自举最小基础数据（id 均为 1）
  await Store.handle('POST', '/products', { code: 'P1', name: '测试产品', unit: '个' });
  await Store.handle('POST', '/processes', { code: 'PR1', name: '车削' });
  await Store.handle('POST', '/work_centers', { code: 'WC1', name: '车床' });
  await Store.handle('POST', '/routes', { code: 'RT1', name: '路线', product_id: 1, steps: [{ seq: 10, process_id: 1, work_center_id: 1 }] });
  r = await Store.handle('POST', '/orders', { product_id: 1, route_id: 1, qty_plan: 10, priority: 1, plan_end: '2099-01-01' });
  assert(r.ok && r.data.id === 1, '自举工单成功 id=1');
  const rtSteps = await Store.handle('GET', '/routes/1/steps');
  assert(rtSteps.data.length === 1, '路线带 1 道工序（修复：路线须落工序）');
  const od1 = await Store.handle('GET', '/orders/1');
  assert(od1.data.steps.length === 1, '工单按路线展开 1 道工序（修复核心）');

  // /me
  r = await Store.handle('GET', '/me');
  assert(r.ok && r.data.role === 'admin', '/me 返回当前用户');

  // /logout
  r = await Store.handle('POST', '/logout');
  assert(r.ok && Store.currentUser === null, '/logout 清除会话');
  Store.restoreFromToken('static-1');

  // 列表 + 聚合
  r = await Store.handle('GET', '/orders', null, {});
  assert(r.ok && r.data.length > 0, '工单列表返回 ' + r.data.length + ' 条');
  const o0 = r.data[0];
  assert('qty_done' in o0 && 'qty_max' in o0, '聚合字段存在 (qty_done/qty_max)');

  // 详情
  r = await Store.handle('GET', '/orders/1');
  assert(r.ok && r.data.steps && r.data.reports, '工单详情含 steps/reports');

  // 统计
  r = await Store.handle('GET', '/stats/overview');
  assert(r.ok && r.data.today, 'overview.today 存在, 今日良品=' + r.data.today.good);
  r = await Store.handle('GET', '/stats/trend?days=14');
  assert(r.ok && Array.isArray(r.data), 'trend 返回数组 len=' + r.data.length);
  r = await Store.handle('GET', '/stats/ranking?days=7');
  assert(r.ok && Array.isArray(r.data), 'ranking 返回数组 len=' + r.data.length);
  r = await Store.handle('GET', '/stats/bad?days=14');
  assert(r.ok && Array.isArray(r.data), 'bad 返回数组 len=' + r.data.length);

  // 报工（带登录态）
  const before = (await Store.handle('GET', '/orders/1')).data;
  const step = before.steps.find((s) => s.status !== 'done');
  const repCountBefore = before.reports.length;
  r = await Store.handle('POST', '/reports', {
    order_id: 1, order_step_id: step.id, qty_good: 5, qty_bad: 0, worker_id: 3, work_min: 10, report_date: new Date().toISOString().slice(0, 10),
  });
  assert(r.ok, '报工提交成功');
  const after = (await Store.handle('GET', '/orders/1')).data;
  const stepAfter = after.steps.find((s) => s.id === step.id);
  assert(stepAfter.qty_good >= 5, '工序合格数累加 = ' + stepAfter.qty_good);
  assert(after.reports.length === repCountBefore + 1, '报工记录 +1');
  const newRepId = after.reports[0].id;
  // 撤销
  r = await Store.handle('DELETE', '/reports/' + newRepId);
  assert(r.ok, '撤销报工成功');
  const after2 = (await Store.handle('GET', '/orders/1')).data;
  assert(after2.reports.length === repCountBefore, '撤销后报工记录恢复');

  // 二维码（静态令牌）
  r = await Store.handle('GET', '/qr/order/1');
  assert(r.ok && r.data.url.indexOf('/m/index.html?o=1') >= 0 && r.data.token === 'static', 'qr/order 返回可访问链接');
  r = await Store.handle('GET', '/qr/worker/1');
  assert(r.ok && r.data.url.indexOf('/m/index.html?w=1') >= 0, 'qr/worker 返回可访问链接');

  // 免登录 H5 接口
  r = await Store.handle('GET', '/public/order/1');
  assert(r.ok && r.data.order && r.data.steps, 'public/order 返回工单与工序');
  r = await Store.handle('GET', '/public/worker/1');
  assert(r.ok && r.data.worker, 'public/worker 返回员工');

  // 引用保护：删除被工单使用的产品应失败
  r = await Store.handle('DELETE', '/products/1');
  assert(!r.ok && r.code === 409, '删除被引用产品被拦截 (code=409)');

  // 下发工单（修复核心：有工序即可下发）
  r = await Store.handle('PATCH', '/orders/1/status', { status: 'released' });
  assert(r.ok && (await Store.handle('GET', '/orders/1')).data.status === 'released', '工单可下发 → 已下发');

  // 创建工单再删（无引用干扰）
  const code = 'WO' + Date.now();
  r = await Store.handle('POST', '/orders', { code, product_id: 1, route_id: 1, qty_plan: 10, priority: 1, plan_end: '2099-01-01' });
  assert(r.ok && r.data.id, '创建工单成功 code=' + code);
  const newOrderId = r.data.id;
  r = await Store.handle('DELETE', '/orders/' + newOrderId);
  assert(r.ok, '删除新建工单(无引用)成功');

  console.log('\n所有断言完成。');
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
