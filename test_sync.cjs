/* 完工入库补齐（工单完工量 → 成品库）冒烟测试
 * 验证：
 *   1) 无缺口时 sync 不重复补齐（幂等）。
 *   2) 历史报工（无入库单）造成的缺口，sync 按 末道完工 − 自动入库量 差额补生成 source='sync' 入库单并增库存。
 *   3) 反复 sync 结果稳定（先移除旧补齐单再重建）。
 *   4) 反向：撤销报工致末道完工归零 → sync 移除补齐单，库存回落。
 *   5) 不干扰人工手工建的入库单（source/report_id 均为空）。
 * 用法：node test_sync.cjs   （内部用临时数据目录另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5315);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-sync-'));

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
    const suffix = 'S' + Date.now().toString().slice(-5);

    // 建产品 + 单工序（即末道）+ 路线 + 工单
    const prod = await api('POST', '/api/products', { code: 'P-' + suffix, name: '补齐测试' + suffix, spec: 'SPEC', unit: '件', price: 10 }, token);
    chk('创建产品', prod.ok, JSON.stringify(prod));
    const proc = await api('POST', '/api/processes', { code: 'PR-' + suffix, name: '单工序', std_time: 5, std_price: 1, remark: '' }, token);
    const route = await api('POST', '/api/routes', { code: 'RT-' + suffix, name: '路线', product_id: prod.data.id, steps: [{ seq: 10, process_id: proc.data.id }] }, token);
    const ord = await api('POST', '/api/orders', { product_id: prod.data.id, route_id: route.data.id, qty_plan: 100 }, token);
    const oid = ord.data.id;
    const stepId = (await H('GET', '/api/orders/' + oid)).data.steps[0].id;

    const stockOf = async () => {
      const mat = (await H('GET', '/api/materials')).data.find((m) => m.code === 'P-' + suffix);
      const inv = (await H('GET', '/api/inventory')).data || [];
      return inv.filter((r) => r.material_id === (mat && mat.id)).reduce((s, r) => s + Number(r.qty), 0);
    };
    const finsOf = async () => (await H('GET', '/api/finished_goods_in')).data.filter((f) => f.product_code === 'P-' + suffix);

    // 1) 末道报工 60 → 自动入库
    const r1 = await H('POST', '/api/reports', { order_id: oid, steps: [{ order_step_id: stepId, qty_good: 60 }] });
    chk('末道报工触发自动入库 60', r1.data.steps[0].autoFinishIn && r1.data.steps[0].autoFinishIn.qty === 60, JSON.stringify(r1.data));
    chk('报工后库存=60', (await stockOf()) === 60, await stockOf());

    // 2) 无缺口时 sync 不重复补（本工单不应产生补齐单；全局 created 会含 seed/演示工单的历史补齐）
    const s1 = await H('POST', '/api/warehouse/sync_finished', {});
    const syn1 = (await finsOf()).filter((f) => f.source === 'sync');
    chk('无缺口时本工单无补齐单', s1.ok && syn1.length === 0, JSON.stringify(syn1));
    chk('sync 同时补齐历史/演示工单（全局 created>0）', s1.data.created > 0, JSON.stringify(s1.data));
    chk('无缺口时库存仍=60', (await stockOf()) === 60, await stockOf());

    // 3) 造历史缺口：删除自动入库单（模拟自动入库上线前的历史报工）
    const autoFins = (await finsOf()).filter((f) => f.report_id);
    chk('存在 1 张自动入库单', autoFins.length === 1, autoFins.length);
    await H('DELETE', '/api/finished_goods_in/' + autoFins[0].id);
    chk('删除自动单后库存=0', (await stockOf()) === 0, await stockOf());

    // 4) sync 补齐本工单缺口
    const s2 = await H('POST', '/api/warehouse/sync_finished', {});
    chk('补齐后库存=60', (await stockOf()) === 60, await stockOf());
    const syncFins = (await finsOf()).filter((f) => f.source === 'sync');
    chk('本工单生成 source=sync 补齐单 1 张 60 件', syncFins.length === 1 && Number(syncFins[0].qty) === 60, JSON.stringify(syncFins));
    chk('补齐返回含本工单（created≥1）', s2.data.created >= 1, JSON.stringify(s2.data));

    // 5) 幂等：再次 sync 结果稳定（本工单补齐单不会翻倍）
    await H('POST', '/api/warehouse/sync_finished', {});
    const syn3 = (await finsOf()).filter((f) => f.source === 'sync');
    chk('幂等：本工单补齐单仍 1 张 60 件', syn3.length === 1 && Number(syn3[0].qty) === 60, JSON.stringify(syn3));
    chk('幂等后库存仍=60', (await stockOf()) === 60, await stockOf());

    // 6) 报表闭环一致
    let ps = await H('GET', '/api/stats/production-stock');
    let row = (ps.data.rows || []).find((r) => r.product_code === 'P-' + suffix);
    chk('报表 done=60 inQty=60 stock=60 diff=0', row && Number(row.done) === 60 && Number(row.inQty) === 60 && Number(row.stock) === 60 && Number(row.diff) === 0,
      row && JSON.stringify({ d: row.done, i: row.inQty, s: row.stock, df: row.diff }));

    // 7) 反向：撤销报工 → 末道完工归零 → sync 移除补齐单
    const reps = (await H('GET', '/api/reports?order_id=' + oid)).data;
    await H('DELETE', '/api/reports/' + reps[0].id);
    const s4 = await H('POST', '/api/warehouse/sync_finished', {});
    const syn4 = (await finsOf()).filter((f) => f.source === 'sync');
    chk('完工归零后本工单补齐单已移除', s4.ok && syn4.length === 0, JSON.stringify(syn4));
    chk('移除后库存=0', (await stockOf()) === 0, await stockOf());
    ps = await H('GET', '/api/stats/production-stock');
    row = (ps.data.rows || []).find((r) => r.product_code === 'P-' + suffix);
    chk('报表归零 done=inQty=stock=0', row && Number(row.done) === 0 && Number(row.inQty) === 0 && Number(row.stock) === 0,
      row && JSON.stringify({ d: row.done, i: row.inQty, s: row.stock }));

    // 8) 不干扰人工手工建的入库单
    const mat = (await H('GET', '/api/materials')).data.find((m) => m.code === 'P-' + suffix);
    const manual = await H('POST', '/api/finished_goods_in', { product_code: 'P-' + suffix, product_name: '手工' + suffix, material_id: mat.id, qty: 5, unit: '件', result: 'qualified', remark: '手工测试单' });
    chk('手工建入库单 5 件', manual.ok, JSON.stringify(manual));
    chk('手工单后库存=5', (await stockOf()) === 5, await stockOf());
    await H('POST', '/api/warehouse/sync_finished', {});
    const after = await finsOf();
    chk('sync 不删手工单', after.some((f) => !f.source && !f.report_id && Number(f.qty) === 5), JSON.stringify(after.map((f) => ({ q: f.qty, s: f.source, r: f.report_id }))));
    chk('sync 后手工库存仍=5', (await stockOf()) === 5, await stockOf());
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
