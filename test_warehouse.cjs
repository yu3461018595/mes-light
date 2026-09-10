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
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
