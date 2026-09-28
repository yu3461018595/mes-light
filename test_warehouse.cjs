/* 物料仓储阶段1 冒烟测试：物料档案 / 库存台账 / 收发明细 / 单据联动 / 预警
 * 用法：node test_warehouse.cjs   （需要一个干净数据目录，脚本内部用 DATA_DIR 指定临时目录并另起服务） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5299);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-wh-'));

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' → ' + extra : '')); }
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

    // 1. 演示数据：仓库 / 物料 / 台账
    const wh = await H('GET', '/api/warehouses');
    chk('仓库演示数据存在', wh.data && wh.data.length >= 2, JSON.stringify(wh.data));
    const mats = await H('GET', '/api/materials');
    chk('物料档案演示数据存在', mats.data && mats.data.length >= 3, JSON.stringify(mats.data));
    const m1 = mats.data.find((m) => m.code === 'RM-001');
    const inv0 = await H('GET', '/api/inventory');
    const s1 = inv0.data.find((r) => r.material_id === m1.id);
    chk('台账已由来料单生成（RM-001=500）', s1 && Number(s1.qty) === 500, JSON.stringify(s1));
    const m2 = mats.data.find((m) => m.code === 'RM-002');
    const s2 = inv0.data.find((r) => r.material_id === m2.id);
    chk('缺料预警生效（RM-002 库存200 < 下限300）', s2 && Number(s2.qty) === 200 && Number(s2.safe_min) === 300, JSON.stringify(s2));

    // 2. 新增来料单 → 库存增加 + 流水
    const before = Number(s1.qty);
    const add = await H('POST', '/api/incoming_materials', {
      code: 'LM-TEST-001', incoming_date: '2026-09-10', supplier: '测试供应商',
      material_id: m1.id, warehouse_id: m1.warehouse_id, material_code: 'RM-001', material_name: '45#圆钢',
      material_spec: 'Φ45', qty: 100, unit: 'kg', batch: 'B250901', result: 'qualified', inspector: '测试员',
    });
    chk('新增来料单成功', add.ok, JSON.stringify(add));
    let inv1 = await H('GET', '/api/inventory');
    let a1 = inv1.data.find((r) => r.material_id === m1.id);
    chk('来料后库存 = 500 + 100', Number(a1.qty) === before + 100, '实际 ' + a1.qty);
    let tx = await H('GET', '/api/inventory_tx');
    const t1 = tx.data.find((t) => t.ref_code === 'LM-TEST-001');
    chk('生成来料入库流水（+100，前后库存正确）', t1 && Number(t1.qty) === 100 && Number(t1.before_qty) === 500 && Number(t1.after_qty) === 600, JSON.stringify(t1));

    // 3. 修改单据数量 100 → 40（库存重算）
    await H('PUT', '/api/incoming_materials/' + add.data.id, {
      code: 'LM-TEST-001', incoming_date: '2026-09-10', supplier: '测试供应商',
      material_id: m1.id, warehouse_id: m1.warehouse_id, material_code: 'RM-001', material_name: '45#圆钢',
      qty: 40, unit: 'kg', batch: 'B250901', result: 'qualified', inspector: '测试员',
    });
    inv1 = await H('GET', '/api/inventory');
    a1 = inv1.data.find((r) => r.material_id === m1.id);
    chk('修改数量后库存 = 500 + 40', Number(a1.qty) === 540, '实际 ' + a1.qty);

    // 4. 改为不合格 → 不计入库存
    await H('PUT', '/api/incoming_materials/' + add.data.id, {
      code: 'LM-TEST-001', incoming_date: '2026-09-10', supplier: '测试供应商',
      material_id: m1.id, material_code: 'RM-001', material_name: '45#圆钢',
      qty: 40, unit: 'kg', batch: 'B250901', result: 'rejected', inspector: '测试员',
    });
    inv1 = await H('GET', '/api/inventory');
    a1 = inv1.data.find((r) => r.material_id === m1.id);
    chk('不合格单据不计入库存（回到 500）', Number(a1.qty) === 500, '实际 ' + a1.qty);

    // 5. 删除单据 → 冲销（先改回合格再删）
    await H('PUT', '/api/incoming_materials/' + add.data.id, {
      code: 'LM-TEST-001', incoming_date: '2026-09-10', material_id: m1.id,
      material_code: 'RM-001', material_name: '45#圆钢', qty: 40, unit: 'kg', batch: 'B250901', result: 'qualified',
    });
    await H('DELETE', '/api/incoming_materials/' + add.data.id);
    inv1 = await H('GET', '/api/inventory');
    a1 = inv1.data.find((r) => r.material_id === m1.id);
    chk('删除单据后库存冲销回 500', Number(a1.qty) === 500, '实际 ' + a1.qty);
    tx = await H('GET', '/api/inventory_tx');
    chk('该单流水已清除', !tx.data.some((t) => t.ref_code === 'LM-TEST-001' && Number(t.qty) > 0), '');

    // 6. 物料档案 CRUD + 从产品导入
    const mk = await H('POST', '/api/materials', { code: 'RM-T01', name: '测试物料', spec: 'T-1', category: '原料', unit: '个', safe_min: 10, safe_max: 100 });
    chk('新增物料成功', mk.ok, JSON.stringify(mk));
    const dup = await H('POST', '/api/materials', { code: 'RM-T01', name: '重复编码' });
    chk('物料编码重复被拒绝', !dup.ok, JSON.stringify(dup));
    const imp = await H('POST', '/api/materials/import_products', {});
    chk('从产品导入物料', imp.ok && imp.data.imported > 0, JSON.stringify(imp));
    await H('DELETE', '/api/materials/' + mk.data.id);

    // 7. 成品入库联动
    const fin = await H('POST', '/api/finished_goods_in', {
      code: 'RK-TEST-001', in_date: '2026-09-10', material_id: m2.id, product_code: 'RM-002',
      product_name: '深沟球轴承', spec: '6204-2RS', qty: 150, unit: '套', batch: 'B250902', location: 'A-02', result: 'qualified',
    });
    inv1 = await H('GET', '/api/inventory');
    a1 = inv1.data.find((r) => r.material_id === m2.id && r.batch === 'B250902');
    chk('成品入库计入库存（200 + 150 = 350）', a1 && Number(a1.qty) === 350, JSON.stringify(a1));
    chk('库存高于下限后预警解除', a1 && Number(a1.qty) > Number(a1.safe_min), '');
    await H('DELETE', '/api/finished_goods_in/' + fin.data.id);
    inv1 = await H('GET', '/api/inventory');
    a1 = inv1.data.find((r) => r.material_id === m2.id && r.batch === 'B250902');
    chk('删除成品入库单后库存回到 200', a1 && Number(a1.qty) === 200, '实际 ' + (a1 && a1.qty));

    // 8. 收发明细只读校验（无写接口）
    const bad = await H('POST', '/api/inventory_tx', { material_id: m1.id, qty: 1 });
    chk('收发明细不允许手工写入', !bad.ok, JSON.stringify(bad));

    // ============ 9. 领料 / 退料 / 成品出库 / 盘点调整 ============
    const ords = await H('GET', '/api/orders');
    chk('演示工单存在（用于领料关联）', ords.data && ords.data.length >= 1, JSON.stringify(ords.data && ords.data.length));
    const oid = ords.data[0].id;
    const invSum = async (mid) => (await H('GET', '/api/inventory')).data.filter((r) => r.material_id === mid).reduce((s, r) => s + Number(r.qty), 0);

    const pick = await H('POST', '/api/material_issues', { type: 'pick', order_id: oid, material_id: m1.id, qty: 60, unit: 'kg', reason: '测试领料' });
    chk('领料成功（LL 单号自动生成，未指定批次自动扣）', pick.ok && /^LL/.test(pick.data.code), JSON.stringify(pick));
    let invA = await invSum(m1.id);
    chk('领料后库存合计 = 500 − 60', invA === 440, '实际 ' + invA);
    const pickNoOrder = await H('POST', '/api/material_issues', { type: 'pick', material_id: m1.id, qty: 10 });
    chk('领料未关联工单被拒', !pickNoOrder.ok && /工单/.test(pickNoOrder.msg), JSON.stringify(pickNoOrder));

    const ret = await H('POST', '/api/material_issues', { type: 'return', order_id: oid, material_id: m1.id, qty: 10, reason: '余料退回' });
    chk('退料成功（TL 单号）', ret.ok && /^TL/.test(ret.data.code), JSON.stringify(ret));
    invA = await invSum(m1.id);
    chk('退料后库存合计 = 440 + 10', invA === 450, '实际 ' + invA);

    const pickAll = await H('POST', '/api/material_issues', { type: 'pick', order_id: oid, material_id: m1.id, qty: 9999 });
    chk('库存不足禁止领料', !pickAll.ok && /库存不足/.test(pickAll.msg), JSON.stringify(pickAll));

    const pickUpd = await H('PUT', '/api/material_issues/' + pick.data.id, { type: 'pick', order_id: oid, material_id: m1.id, qty: 30 });
    chk('修改领料数量成功', pickUpd.ok, JSON.stringify(pickUpd));
    invA = await invSum(m1.id);
    chk('改量后库存合计 = 450 + 60(冲销) − 30 = 480', invA === 480, '实际 ' + invA);

    // 盘点调整：m2 现有量 → +100，再无批次出库 50（自动扣种子批次）
    const m2Row0 = (await H('GET', '/api/inventory')).data.find((r) => r.material_id === m2.id);
    const m2Batch = (m2Row0 && m2Row0.batch) || null;
    const m2Qty0 = await invSum(m2.id);
    const adj = await H('POST', '/api/inventory/adjust', { material_id: m2.id, warehouse_id: m2.warehouse_id || null, batch: m2Batch, physical_qty: m2Qty0 + 100, remark: '测试盘点' });
    chk('盘点调整成功（+100 差异）', adj.ok && Number(adj.data.diff) === 100, JSON.stringify(adj));
    const adjSame = await H('POST', '/api/inventory/adjust', { material_id: m2.id, batch: m2Batch, physical_qty: m2Qty0 + 100 });
    chk('实盘=账面时提示无需调整', !adjSame.ok && /一致/.test(adjSame.msg), JSON.stringify(adjSame));
    const ship = await H('POST', '/api/stock_shipments', { customer: '测试客户', order_id: oid, material_id: m2.id, qty: 50 });
    chk('成品出库成功（CK 单号，未指定批次自动扣）', ship.ok && /^CK/.test(ship.data.code), JSON.stringify(ship));
    const m2Qty1 = await invSum(m2.id);
    chk('出库后 m2 库存合计 = 盘点后 − 50', m2Qty1 === m2Qty0 + 100 - 50, '实际 ' + m2Qty1);

    // ============ 10. 产出比（新建独立工单，避免种子数据干扰） ============
    const prods = (await H('GET', '/api/products')).data;
    const rts = (await H('GET', '/api/routes')).data;
    const rt = rts.find((r) => r.product_id === prods[0].id) || rts[0];
    const nOrd = await H('POST', '/api/orders', { product_id: rt.product_id, route_id: rt.id, qty_plan: 50 });
    chk('新建测试工单成功', nOrd.ok, JSON.stringify(nOrd));
    const nOid = nOrd.data.id;

    await H('POST', '/api/incoming_materials', { code: 'LM-YIELD-1', incoming_date: '2026-09-20', material_id: m1.id, qty: 100, unit: 'kg', result: 'qualified', order_id: nOid });
    await H('POST', '/api/finished_goods_in', { code: 'RK-YIELD-1', in_date: '2026-09-22', material_id: m2.id, product_name: m2.name, qty: 40, unit: '套', result: 'qualified', order_id: nOid });
    invA = await invSum(m1.id);
    const m2Qty2 = await invSum(m2.id);
    const yd = await H('GET', '/api/stats/yield?period=all');
    chk('产出比接口返回', yd.ok && yd.data && yd.data.summary, JSON.stringify(yd).slice(0, 200));
    const yOrder = yd.data.orders.find((r) => Number(r.order_id) === Number(nOid));
    chk('按工单产出比 = 40 ÷ 100 = 40%', yOrder && Number(yOrder.incoming_qty) === 100 && Number(yOrder.finished_qty) === 40 && Number(yOrder.ratio) === 40, JSON.stringify(yOrder));
    chk('按月趋势返回 6 个月', Array.isArray(yd.data.monthly) && yd.data.monthly.length === 6, JSON.stringify(yd.data.monthly && yd.data.monthly.length));

    await H('POST', '/api/incoming_materials', { code: 'LM-YIELD-2', incoming_date: '2026-09-21', material_id: m1.id, qty: 50, unit: 'kg', result: 'pending', order_id: nOid });
    const yd2 = await H('GET', '/api/stats/yield?period=all&include_pending=1');
    const yOrder2 = yd2.data.orders.find((r) => Number(r.order_id) === Number(nOid));
    chk('含待检口径：来料 150，产出比 26.67%', yOrder2 && Number(yOrder2.incoming_qty) === 150 && Math.abs(Number(yOrder2.ratio) - 26.67) < 0.02, JSON.stringify(yOrder2));
    const yd3 = await H('GET', '/api/stats/yield?period=all');
    const yOrder3 = yd3.data.orders.find((r) => Number(r.order_id) === Number(nOid));
    chk('默认口径不含待检（仍为 100/40）', yOrder3 && Number(yOrder3.incoming_qty) === 100, JSON.stringify(yOrder3));

    // 清理待检单（deleted 后库存冲销），再对账汇总
    const pendDoc = (await H('GET', '/api/incoming_materials')).data.find((r) => r.code === 'LM-YIELD-2');
    await H('DELETE', '/api/incoming_materials/' + pendDoc.id);
    invA = await invSum(m1.id);
    const m2Qty3 = await invSum(m2.id);

    // ============ 11. 收发存汇总 ============
    const sm = await H('GET', '/api/stats/inventory_summary');
    chk('收发存汇总接口返回', sm.ok && Array.isArray(sm.data.rows), JSON.stringify(sm).slice(0, 200));
    const sRow1 = sm.data.rows.find((r) => r.material_id === m1.id);
    chk('汇总 m1 期末 = 期初 + 收入 − 发出', sRow1 && Number(sRow1.closing) === Number(sRow1.opening) + Number(sRow1.in_qty) - Number(sRow1.out_qty), JSON.stringify(sRow1));
    chk('汇总 m1 期末与台账合计一致', sRow1 && Number(sRow1.closing) === invA, JSON.stringify({ closing: sRow1 && sRow1.closing, inv: invA }));
    const sRow2 = sm.data.rows.find((r) => r.material_id === m2.id);
    chk('汇总 m2 期末与台账合计一致', sRow2 && Number(sRow2.closing) === m2Qty3, JSON.stringify({ closing: sRow2 && sRow2.closing, inv: m2Qty3 }));
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
