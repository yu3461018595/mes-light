/* 工序流转约束集成测试：临时库启动真实服务，验证「下工序投入 ≤ 上工序合格」拦截逻辑 */
'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-flow-'));
process.env.DATA_DIR = tmp;
process.env.PORT = '0';
process.env.MES_FLOW_CHECK = 'on';

const server = require('./server.js');
const D = require('./lib/db');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✔', name); } else { fail++; console.log('  ✘', name); } };
let PORT = 0;

async function post(path, body, token) {
  const r = await fetch('http://localhost:' + PORT + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

/* 新建工单：plan 计划数，upGood 为上游工序累计合格，downPlan 为下游工序计划数（默认取 plan） */
function makeOrder(plan, upGood, downPlan) {
  const oid = D.insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,status,created_at)
         VALUES(?,1,1,NULL,?,2,'running',?)`, ['TEST-' + Math.random().toString(36).slice(2, 8), plan, D.now()]);
  D.run(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,qty_good,qty_bad,status)
         VALUES(?,10,1,1,?,?,0,'done')`, [oid, plan, upGood]);
  D.run(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,qty_good,qty_bad,status)
         VALUES(?,20,2,2,?,0,0,'running')`, [oid, downPlan || plan]);
  const downStep = D.get('SELECT id FROM order_steps WHERE order_id=? AND seq=20', [oid]).id;
  return { oid, downStep };
}

(async () => {
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
  PORT = server.address().port;
  console.log('服务已启动，端口', PORT);

  const login = await post('/api/login', { username: 'admin', password: '123456' });
  const token = login.json.data && login.json.data.token;
  ok(!!token, 'admin 登录成功');
  if (!token) { console.log(login.json); process.exit(1); }

  D.db.exec("DELETE FROM reports; DELETE FROM order_steps; DELETE FROM orders;");

  // 场景A：下游工序计划足够大（不会因报满而 done），验证「已投满」边界
  {
    const { oid, downStep } = makeOrder(2000, 1000, 2000);
    const report = (g, b) => post('/api/reports', { order_id: oid, order_step_id: downStep, worker_id: 1, qty_good: g, qty_bad: b, work_min: 0, report_date: D.today() }, token);

    let r = await report(1001, 0);
    ok(r.status === 400 && /流转上限/.test(r.json.msg || ''), 'A1 报 1001 件被拦截（' + (r.json.msg || '').slice(0, 34) + '…）');

    r = await report(1000, 0);
    ok(r.status === 200 && r.json.ok, 'A2 报 1000 件（等于上限）通过');

    r = await report(1, 0);
    ok(r.status === 400 && /流转上限/.test(r.json.msg || ''), 'A3 已投满后再报 1 件被拦截');
  }

  // 场景B：良品 + 不良 合计约束
  {
    const { oid, downStep } = makeOrder(2000, 1000, 2000);
    const report = (g, b) => post('/api/reports', { order_id: oid, order_step_id: downStep, worker_id: 1, qty_good: g, qty_bad: b, work_min: 0, report_date: D.today() }, token);

    let r = await report(900, 101);
    ok(r.status === 400 && /流转上限/.test(r.json.msg || ''), 'B1 良品900+不良101=1001 被拦截');

    r = await report(900, 100);
    ok(r.status === 200 && r.json.ok, 'B2 良品900+不良100=1000 通过');
  }

  // 场景C：首工序无上游 → 上限为工单计划数
  {
    const { oid, downStep } = makeOrder(500, 500, 500);
    // 首工序其实也是 downStep 的上游=500，这里专门测「首道工序」：单独建一个只有首工序有报工的工单
    const oid3 = D.insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,status,created_at)
           VALUES(?,1,1,NULL,500,2,'running',?)`, ['TEST-FIRST', D.now()]);
    D.run(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,qty_good,qty_bad,status)
           VALUES(?,10,1,1,500,0,0,'running')`, [oid3]);
    const step1 = D.get('SELECT id FROM order_steps WHERE order_id=? AND seq=10', [oid3]).id;
    let r = await post('/api/reports', { order_id: oid3, order_step_id: step1, worker_id: 1, qty_good: 501, qty_bad: 0, work_min: 0, report_date: D.today() }, token);
    ok(r.status === 400 && /流转上限/.test(r.json.msg || ''), 'C1 首工序报 501（超计划 500）被拦截');

    r = await post('/api/reports', { order_id: oid3, order_step_id: step1, worker_id: 1, qty_good: 500, qty_bad: 0, work_min: 0, report_date: D.today() }, token);
    ok(r.status === 200 && r.json.ok, 'C2 首工序报 500（等于计划）通过');
  }

  // 场景D：多工序逐级递减，验证「前道合格流入下道」
  {
    const oid = D.insert(`INSERT INTO orders(code,product_id,route_id,customer_id,qty_plan,priority,status,created_at)
           VALUES(?,1,1,NULL,1000,2,'running',?)`, ['TEST-CHAIN', D.now()]);
    // 工序1 good=1000；工序2 good=980（有 20 不良报废）；工序3 未报
    D.run(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,qty_good,qty_bad,status)
           VALUES(?,10,1,1,1000,1000,0,'done')`, [oid]);
    D.run(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,qty_good,qty_bad,status)
           VALUES(?,20,2,2,1000,980,20,'done')`, [oid]);
    D.run(`INSERT INTO order_steps(order_id,seq,process_id,work_center_id,qty_plan,qty_good,qty_bad,status)
           VALUES(?,30,3,3,1000,0,0,'running')`, [oid]);
    const step3 = D.get('SELECT id FROM order_steps WHERE order_id=? AND seq=30', [oid]).id;
    // 工序3 的上游是工序2 合格 980，所以最多可报 980
    let r = await post('/api/reports', { order_id: oid, order_step_id: step3, worker_id: 1, qty_good: 981, qty_bad: 0, work_min: 0, report_date: D.today() }, token);
    ok(r.status === 400 && /流转上限/.test(r.json.msg || ''), 'D1 工序3 报 981（超上游合格 980）被拦截');

    r = await post('/api/reports', { order_id: oid, order_step_id: step3, worker_id: 1, qty_good: 980, qty_bad: 0, work_min: 0, report_date: D.today() }, token);
    ok(r.status === 200 && r.json.ok, 'D2 工序3 报 980（等于上游合格）通过');
  }

  console.log('\n结果：通过', pass, '，失败', fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常', e); process.exit(2); });
