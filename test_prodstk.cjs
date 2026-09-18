/* 工单 ⇄ 仓储 闭环对账报表 冒烟测试
 * 验证：工单末道工序报工合格数 → 自动成品入库（分产品）→ 库存；
 *       以及 GET /api/stats/production-stock 的产品汇总/工单明细是否与上述一致（diff=0）。
 * 用法：node test_prodstk.cjs   （内部用临时数据目录另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5311);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-prodstk-'));

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
};

async function api(method, url, body, token) {
  const res = await fetch('http://127.0.0.1:' + PORT + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return await res.json();
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(300);
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/meta'); if (r.ok) up = true; } catch (e) { /* retry */ }
  }
  if (!up) { console.log('服务启动失败'); srv.kill(); process.exit(1); }

  try {
    const lg = await api('POST', '/api/login', { username: 'admin', password: '123456' });
    const token = lg.data && lg.data.token;
    chk('管理员登录', !!token, JSON.stringify(lg));
    const H = (m, u, b) => api(m, u, b, token);

    const suffix = 'T' + Date.now().toString().slice(-5);
    // 1. 建产品（唯一编码，隔离种子数据）
    const prod = await H('POST', '/api/products', { code: 'P-' + suffix, name: '测试产品' + suffix, spec: 'SPEC', unit: '件', price: 10 });
    chk('创建产品', prod.ok, JSON.stringify(prod));
    // 2. 建工序
    const proc = await H('POST', '/api/processes', { code: 'PR-' + suffix, name: '测试工序', std_time: 5, std_price: 1, remark: '' });
    chk('创建工序', proc.ok, JSON.stringify(proc));
    // 3. 建工艺路线（含 1 道工序，则该工序即末道）
    const route = await H('POST', '/api/routes', { code: 'RT-' + suffix, name: '测试路线', product_id: prod.data.id, steps: [{ seq: 10, process_id: proc.data.id }] });
    chk('创建工艺路线', route.ok, JSON.stringify(route));
    // 4. 建工单
    const ord = await H('POST', '/api/orders', { product_id: prod.data.id, route_id: route.data.id, qty_plan: 100 });
    chk('创建工单', ord.ok, JSON.stringify(ord));
    const oid = ord.data.id;
    const od = await H('GET', '/api/orders/' + oid);
    const stepId = od.data.steps[0].id;
    chk('工单含 1 道工序', od.data.steps && od.data.steps.length === 1, JSON.stringify(od.data.steps));

    // 5. 第一次末道报工（合格 30）
    const r1 = await H('POST', '/api/reports', { order_id: oid, steps: [{ order_step_id: stepId, qty_good: 30 }] });
    chk('第一次报工成功', r1.ok, JSON.stringify(r1));
    chk('第一次报工触发自动成品入库', r1.data && r1.data.steps && r1.data.steps[0].autoFinishIn && r1.data.steps[0].autoFinishIn.qty === 30, JSON.stringify(r1.data));

    // 6. 第二次末道报工（合格 20）
    const r2 = await H('POST', '/api/reports', { order_id: oid, steps: [{ order_step_id: stepId, qty_good: 20 }] });
    chk('第二次报工成功', r2.ok, JSON.stringify(r2));
    chk('第二次报工触发自动成品入库', r2.data && r2.data.steps && r2.data.steps[0].autoFinishIn && r2.data.steps[0].autoFinishIn.qty === 20, JSON.stringify(r2.data));

    // 7. 校验成品入库单 + 库存台账
    const fins = await H('GET', '/api/finished_goods_in');
    const myFins = (fins.data || []).filter((f) => f.product_code === 'P-' + suffix);
    chk('成品入库单共 2 张且合计 50', myFins.length === 2 && myFins.reduce((s, f) => s + Number(f.qty), 0) === 50, JSON.stringify(myFins));
    const inv = await H('GET', '/api/inventory');
    const mat = (await H('GET', '/api/materials')).data.find((m) => m.code === 'P-' + suffix);
    chk('自动建档成品物料存在', !!mat, JSON.stringify(mat));
    const stockRow = (inv.data || []).filter((r) => r.material_id === (mat && mat.id));
    const stock = stockRow.reduce((s, r) => s + Number(r.qty), 0);
    chk('成品库存合计 = 50', stock === 50, '实际 ' + stock);

    // 8. 产销库存报表：该产品 done=50 / inQty=50 / stock=50 / diff=0
    const ps = await H('GET', '/api/stats/production-stock');
    chk('报表返回 summary + rows', ps.ok && ps.data.summary && Array.isArray(ps.data.rows), JSON.stringify(ps.data && ps.data.summary));
    const row = (ps.data.rows || []).find((r) => r.product_code === 'P-' + suffix);
    chk('报表包含该产品行', !!row, JSON.stringify(ps.data.rows && ps.data.rows.length));
    if (row) {
      chk('报表 末道完工=50', Number(row.done) === 50, row.done);
      chk('报表 工单入库=50', Number(row.inQty) === 50, row.inQty);
      chk('报表 当前库存=50', Number(row.stock) === 50, row.stock);
      chk('报表 待入库差额=0（闭环一致）', Number(row.diff) === 0, row.diff);
      chk('报表 工单明细 1 条且 diff=0', row.orders && row.orders.length === 1 && Number(row.orders[0].diff) === 0, JSON.stringify(row.orders));
    }

    // 9. 报表 summary 结构完整性
    const sm = ps.data.summary;
    chk('summary 含 plan/done/inQty/stock/diff 字段', ['plan', 'done', 'inQty', 'stock', 'diff', 'product_count'].every((k) => k in sm), JSON.stringify(sm));
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
