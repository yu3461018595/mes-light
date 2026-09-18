/* 撤销末道报工 → 自动回滚成品入库 冒烟测试
 * 验证：
 *   1) 非末道工序报工不触发自动成品入库；末道工序报工才入库。
 *   2) 删除末道报工 → 按 report_id 定位成品入库单并 revertStock 冲销，库存回到删除前状态。
 *   3) 删除非末道报工不回滚库存（无关联入库单）。
 *   4) 产销报表删除前后对账一致（diff=0），日志含"联动回滚"。
 * 用法：node test_rollback.cjs   （内部用临时数据目录另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5312);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-rollback-'));

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
    const suffix = 'R' + Date.now().toString().slice(-5);

    // 建产品 + 两道工序（工序2 为末道）
    const prod = await H('POST', '/api/products', { code: 'P-' + suffix, name: '回滚测试' + suffix, spec: 'SPEC', unit: '件', price: 10 });
    chk('创建产品', prod.ok, JSON.stringify(prod));
    const p1 = await H('POST', '/api/processes', { code: 'PR1-' + suffix, name: '工序1', std_time: 5, std_price: 1, remark: '' });
    const p2 = await H('POST', '/api/processes', { code: 'PR2-' + suffix, name: '工序2(末道)', std_time: 5, std_price: 1, remark: '' });
    const route = await H('POST', '/api/routes', { code: 'RT-' + suffix, name: '路线', product_id: prod.data.id, steps: [{ seq: 10, process_id: p1.data.id }, { seq: 20, process_id: p2.data.id }] });
    chk('创建双工序路线', route.ok, JSON.stringify(route));
    const ord = await H('POST', '/api/orders', { product_id: prod.data.id, route_id: route.data.id, qty_plan: 100 });
    const oid = ord.data.id;
    const od = await H('GET', '/api/orders/' + oid);
    const st1 = od.data.steps.find((s) => s.seq === 10).id;
    const st2 = od.data.steps.find((s) => s.seq === 20).id; // 末道
    chk('工单含两道工序', od.data.steps.length === 2, JSON.stringify(od.data.steps));

    const stockOf = async () => {
      const mat = (await H('GET', '/api/materials')).data.find((m) => m.code === 'P-' + suffix);
      const inv = await H('GET', '/api/inventory');
      return (inv.data || []).filter((r) => r.material_id === (mat && mat.id)).reduce((s, r) => s + Number(r.qty), 0);
    };
    const finCount = async () => (await H('GET', '/api/finished_goods_in')).data.filter((f) => f.product_code === 'P-' + suffix).length;

    // 1) 非末道（工序1）报工 10 → 不自动入库
    const r1 = await H('POST', '/api/reports', { order_id: oid, steps: [{ order_step_id: st1, qty_good: 10 }] });
    chk('非末道报工成功', r1.ok, JSON.stringify(r1));
    chk('非末道报工不触发自动入库', !(r1.data.steps[0].autoFinishIn), JSON.stringify(r1.data.steps[0].autoFinishIn));
    chk('非末道报工后库存=0', (await stockOf()) === 0, await stockOf());
    chk('非末道报工后入库单=0', (await finCount()) === 0, await finCount());

    // 2) 末道（工序2）报工 20 → 自动入库 20
    const r2 = await H('POST', '/api/reports', { order_id: oid, steps: [{ order_step_id: st2, qty_good: 20 }] });
    chk('末道报工成功', r2.ok, JSON.stringify(r2));
    chk('末道报工触发自动入库 qty=20', r2.data.steps[0].autoFinishIn && r2.data.steps[0].autoFinishIn.qty === 20, JSON.stringify(r2.data.steps[0].autoFinishIn));
    chk('末道报工后库存=20', (await stockOf()) === 20, await stockOf());
    chk('末道报工后入库单=1', (await finCount()) === 1, await finCount());

    // 3) 删除末道报工 → 联动回滚库存到 0、入库单=0
    const fins = (await H('GET', '/api/finished_goods_in')).data.filter((f) => f.product_code === 'P-' + suffix);
    const lastReportId = fins[0].report_id;
    chk('成品入库单带 report_id', !!lastReportId, fins[0]);
    const del2 = await H('DELETE', '/api/reports/' + lastReportId);
    chk('删除末道报工成功', del2.ok, JSON.stringify(del2));
    chk('删除后库存回滚=0', (await stockOf()) === 0, await stockOf());
    chk('删除后入库单=0', (await finCount()) === 0, await finCount());

    // 4) 删除非末道报工（工序1） → 不应回滚库存（本就没有，且仍无入库单）
    const reps = (await H('GET', '/api/reports', null, token)).data.filter((r) => r.order_id === oid);
    const nonLast = reps.find((r) => r.qty_good === 10);
    const del1 = await H('DELETE', '/api/reports/' + nonLast.id);
    chk('删除非末道报工成功', del1.ok, JSON.stringify(del1));
    chk('删除非末道报工后入库单仍为0', (await finCount()) === 0, await finCount());

    // 5) 日志含"联动回滚"
    const logs = (await H('GET', '/api/logs')).data || [];
    chk('日志含"联动回滚成品入库"', logs.some((l) => String(l.detail).indexOf('联动回滚成品入库') >= 0), JSON.stringify(logs.slice(0, 3)));

    // 6) 单工序工单两次末道报工后，删第一次 → 库存剩第二次，报表对账一致
    const prod2 = await H('POST', '/api/products', { code: 'Q-' + suffix, name: '单工序' + suffix, unit: '件', price: 10 });
    const pr = await H('POST', '/api/processes', { code: 'PRQ-' + suffix, name: '单工序', std_time: 5, std_price: 1, remark: '' });
    const rt2 = await H('POST', '/api/routes', { code: 'RTQ-' + suffix, name: '单', product_id: prod2.data.id, steps: [{ seq: 10, process_id: pr.data.id }] });
    const ord2 = (await H('POST', '/api/orders', { product_id: prod2.data.id, route_id: rt2.data.id, qty_plan: 100 })).data;
    const s2 = (await H('GET', '/api/orders/' + ord2.id)).data.steps[0].id;
    const a = await H('POST', '/api/reports', { order_id: ord2.id, steps: [{ order_step_id: s2, qty_good: 30 }] });
    const b = await H('POST', '/api/reports', { order_id: ord2.id, steps: [{ order_step_id: s2, qty_good: 20 }] });
    chk('单工序两次报工各自动入库', a.data.steps[0].autoFinishIn.qty === 30 && b.data.steps[0].autoFinishIn.qty === 20, JSON.stringify([a.data, b.data]));
    chk('两次报工后库存=50', (await stockOf2('Q-' + suffix)) === 50, await stockOf2('Q-' + suffix));
    const fq = (await H('GET', '/api/finished_goods_in')).data.filter((f) => f.product_code === 'Q-' + suffix);
    chk('单工序入库单=2', fq.length === 2, fq.length);
    const delA = await H('DELETE', '/api/reports/' + fq.find((f) => f.qty === 30).report_id);
    chk('删除第一次报工成功', delA.ok, JSON.stringify(delA));
    chk('删除后库存=20', (await stockOf2('Q-' + suffix)) === 20, await stockOf2('Q-' + suffix));
    chk('删除后入库单=1', (await H('GET', '/api/finished_goods_in')).data.filter((f) => f.product_code === 'Q-' + suffix).length === 1, 'see above');

    // 7) 产销报表对账：Q- 产品 done=20 / inQty=20 / stock=20 / diff=0
    const ps = await H('GET', '/api/stats/production-stock');
    const qrow = (ps.data.rows || []).find((r) => r.product_code === 'Q-' + suffix);
    chk('报表 Q 末道完工=20', qrow && Number(qrow.done) === 20, qrow && qrow.done);
    chk('报表 Q 工单入库=20', qrow && Number(qrow.inQty) === 20, qrow && qrow.inQty);
    chk('报表 Q 当前库存=20', qrow && Number(qrow.stock) === 20, qrow && qrow.stock);
    chk('报表 Q 待入库差额=0', qrow && Number(qrow.diff) === 0, qrow && qrow.diff);

    async function stockOf2(code) {
      const mat = (await H('GET', '/api/materials')).data.find((m) => m.code === code);
      const inv = await H('GET', '/api/inventory');
      return (inv.data || []).filter((r) => r.material_id === (mat && mat.id)).reduce((s, r) => s + Number(r.qty), 0);
    }
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
