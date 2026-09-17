/* 末道工序自动成品入库 + 完成率口径（仅末道工序）冒烟测试
 * 用法：node test_laststep.cjs   （内部用临时 DATA_DIR 另起服务，不污染生产库） */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5288);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-last-'));
process.env.NODE_PATH = '';

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

    // 选产品 P2001 + 工艺路线 R-P2001（5 道工序：OP10/OP20/OP40/OP70/OP80，末道=OP80）
    const products = await H('GET', '/api/products');
    const p2001 = products.data.find((p) => p.code === 'P2001');
    const routes = await H('GET', '/api/routes');
    const rP2001 = routes.data.find((r) => r.code === 'R-P2001');
    chk('取到产品 P2001 与工艺路线 R-P2001', p2001 && rP2001, JSON.stringify([p2001 && p2001.id, rP2001 && rP2001.id]));

    const created = await H('POST', '/api/orders', { product_id: p2001.id, route_id: rP2001.id, qty_plan: 100, code: 'WO-TEST-LAST' });
    chk('创建测试工单', created.ok, JSON.stringify(created));
    const oid = created.data.id;

    const detail = await H('GET', '/api/orders/' + oid);
    const steps = detail.data.steps.slice().sort((a, b) => a.seq - b.seq);
    const last = steps[steps.length - 1];
    const nonLast = steps[0];
    chk('工单含多道工序', steps.length >= 2, 'steps=' + steps.length);
    chk('正确识别末道工序(seq=' + last.seq + ')', last.seq > nonLast.seq, '');

    // 1) 先报末道工序 合格 30 → qty_done 应=30（末道），而 MIN(各工序)=0，可区分口径
    const r1 = await H('POST', '/api/reports', { order_id: oid, order_step_id: last.id, qty_good: 30, qty_bad: 0 });
    chk('末道工序报工成功', r1.ok, JSON.stringify(r1));
    chk('末道工序报工回传自动入库信息', !!(r1.data && r1.data.steps && r1.data.steps[0] && r1.data.steps[0].autoFinishIn), JSON.stringify(r1.data));

    let orders = await H('GET', '/api/orders');
    let my = orders.data.find((o) => o.id === oid);
    chk('完成率口径=末道工序(30)，而非 MIN(0)', Number(my.qty_done) === 30, 'qty_done=' + my.qty_done);

    let fin = await H('GET', '/api/finished_goods_in');
    let finForOrder = fin.data.filter((f) => f.order_id === oid);
    chk('末道工序报工自动生成 1 张成品入库单(30)', finForOrder.length === 1 && Number(finForOrder[0].qty) === 30, JSON.stringify(finForOrder));

    let inv = await H('GET', '/api/inventory');
    let invP = inv.data.find((r) => r.material_code === 'P2001');
    chk('成品(P2001)库存=30', invP && Number(invP.qty) === 30, invP ? 'qty=' + invP.qty : '无台账(物料未自动建档)');

    // 2) 再报非末道工序 合格 50 → 完成率仍=30（不受其它工序影响），且无新增入库单
    const r2 = await H('POST', '/api/reports', { order_id: oid, order_step_id: nonLast.id, qty_good: 50, qty_bad: 0 });
    chk('非末道工序报工成功', r2.ok, JSON.stringify(r2));
    chk('非末道工序报工不触发自动入库(回传 autoFinishIn 为空)', !(r2.data.steps[0] && r2.data.steps[0].autoFinishIn), JSON.stringify(r2.data));

    orders = await H('GET', '/api/orders');
    my = orders.data.find((o) => o.id === oid);
    chk('非末道工序报工后完成率仍为末道 30(Sum=80/Min=0，均不符)', Number(my.qty_done) === 30, 'qty_done=' + my.qty_done);

    fin = await H('GET', '/api/finished_goods_in');
    finForOrder = fin.data.filter((f) => f.order_id === oid);
    chk('非末道工序不新增入库单(仍为 1 张)', finForOrder.length === 1, 'count=' + finForOrder.length);

    // 3) 末道工序再报 合格 20 → 末道累计 50，完成率=50%，库存=50，入库单共 2 张
    const r3 = await H('POST', '/api/reports', { order_id: oid, order_step_id: last.id, qty_good: 20, qty_bad: 0 });
    chk('末道工序二次报工成功', r3.ok, JSON.stringify(r3));
    chk('末道工序二次报工回传自动入库信息', !!(r3.data.steps[0] && r3.data.steps[0].autoFinishIn), JSON.stringify(r3.data));

    orders = await H('GET', '/api/orders');
    my = orders.data.find((o) => o.id === oid);
    chk('完成率口径=末道工序累计(50)', Number(my.qty_done) === 50, 'qty_done=' + my.qty_done);

    const stats = await H('GET', '/api/stats/orders');
    const so = stats.data.find((o) => o.code === 'WO-TEST-LAST');
    chk('统计页完成率同样按末道工序(50)', so && Number(so.qty_done) === 50, so ? 'qty_done=' + so.qty_done : '未找到');

    fin = await H('GET', '/api/finished_goods_in');
    finForOrder = fin.data.filter((f) => f.order_id === oid);
    const finSum = finForOrder.reduce((a, f) => a + Number(f.qty), 0);
    chk('成品入库单共 2 张、合计 50', finForOrder.length === 2 && finSum === 50, 'count=' + finForOrder.length + ' sum=' + finSum);

    inv = await H('GET', '/api/inventory');
    invP = inv.data.find((r) => r.material_code === 'P2001');
    chk('成品(P2001)库存累计=50', invP && Number(invP.qty) === 50, invP ? 'qty=' + invP.qty : '无台账');

    // 4) 物料按产品编码自动建档（P2001 成品类、默认成品仓 WH02）
    const mats = await H('GET', '/api/materials');
    const mP = mats.data.find((m) => m.code === 'P2001');
    chk('产品 P2001 自动建档为成品物料', mP && mP.category === '成品', mP ? mP.category : '未建档');
  } catch (e) {
    fail++;
    console.log('  EXCEPTION  ' + e.message);
  } finally {
    srv.kill();
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
