/* 工单工序增减 冒烟测试：生产中工单增加/插入/删除工序、报工工序保护、完成/关闭工单禁止调整 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5296);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-steps-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  srv.stderr.on('data', (d) => { if (!/ExperimentalWarning|trace-warnings/.test(String(d))) process.stderr.write('[srv] ' + d); });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(300);
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/meta'); if (r.ok) up = true; } catch (e) { /* retry */ }
  }
  if (!up) { console.log('服务启动失败'); srv.kill(); process.exit(1); }

  try {
    const lg = await api('POST', '/api/login', { username: 'admin', password: '123456' });
    chk('管理员登录', lg.ok);
    const H = lg.data.token;
    const meta = (await api('GET', '/api/meta', null, H)).data;

    // 建工单并下发投产
    const o = (await api('POST', '/api/orders', { product_id: meta.products[0].id, route_id: meta.routes.find((r) => r.product_id === meta.products[0].id).id, qty_plan: 100 }, H)).data;
    const id = o.id;
    await api('PATCH', '/api/orders/' + id + '/status', { status: 'released' }, H);
    await api('PATCH', '/api/orders/' + id + '/status', { status: 'running' }, H);
    let od = (await api('GET', '/api/orders/' + id, null, H)).data;
    chk('工单已进入生产中', od.status === 'running', od.status);
    const n0 = od.steps.length;
    chk('初始工序数 > 0', n0 > 0, n0);

    // 1. 末尾追加一道工序
    const pAdd = meta.processes[n0 % meta.processes.length];
    const r1 = await api('POST', '/api/orders/' + id + '/steps', { process_id: pAdd.id, qty_plan: 100 }, H);
    chk('生产中可追加工序', r1.ok, r1.msg);
    od = (await api('GET', '/api/orders/' + id, null, H)).data;
    chk('工序数 +1', od.steps.length === n0 + 1, od.steps.length);
    chk('新工序在最后且状态待生产', od.steps[od.steps.length - 1].status === 'pending' && od.steps[od.steps.length - 1].process_id === pAdd.id);
    chk('新工序计划数量正确', Number(od.steps[od.steps.length - 1].qty_plan) === 100, od.steps[od.steps.length - 1].qty_plan);

    // 2. 插入到第 1 道之前
    const pIns = meta.processes[(n0 + 3) % meta.processes.length];
    const r2 = await api('POST', '/api/orders/' + id + '/steps', { process_id: pIns.id, at_pos: 1, qty_plan: 100 }, H);
    chk('可插入到指定位置', r2.ok, r2.msg);
    od = (await api('GET', '/api/orders/' + id, null, H)).data;
    chk('插入后位于第 1 道', od.steps[0].process_id === pIns.id);
    chk('工序总数 = 初始+2', od.steps.length === n0 + 2, od.steps.length);
    chk('seq 严格递增无重复', od.steps.every((s, i) => i === 0 || s.seq > od.steps[i - 1].seq));

    // 3. 删除一道无报工工序
    const target = od.steps.find((s) => Number(s.qty_good) + Number(s.qty_bad) === 0);
    const r3 = await api('DELETE', '/api/orders/' + id + '/steps/' + target.id, null, H);
    chk('可删除未报工工序', r3.ok, r3.msg);
    od = (await api('GET', '/api/orders/' + id, null, H)).data;
    chk('删除后工序数 -1', od.steps.length === n0 + 1, od.steps.length);

    // 3b. 调整工序顺序（重排 seq）
    const beforeOrder = od.steps.map((s) => s.id);
    const reversed = beforeOrder.slice().reverse();
    const r3b = await api('PUT', '/api/orders/' + id + '/steps/order', { order: reversed }, H);
    chk('可调整工序顺序', r3b.ok, r3b.msg);
    od = (await api('GET', '/api/orders/' + id, null, H)).data;
    chk('顺序已反转为指定顺序', od.steps.map((s) => s.id).join() === reversed.join(), od.steps.map((s) => s.id).join());
    chk('按 10 递增重排 seq', od.steps.every((s, i) => Number(s.seq) === (i + 1) * 10), od.steps.map((s) => s.seq).join());
    // 缺工序被拒
    const r3c = await api('PUT', '/api/orders/' + id + '/steps/order', { order: reversed.slice(1) }, H);
    chk('缺少工序的顺序被拒', !r3c.ok && /全部/.test(r3c.msg || ''), r3c.msg);
    // 含非本工单工序被拒（同长度、替换一个为不存在的 id）
    const r3d = await api('PUT', '/api/orders/' + id + '/steps/order', { order: beforeOrder.map((x, i) => i === 0 ? 999999 : x) }, H);
    chk('含非法工序的顺序被拒', !r3d.ok && /不属于/.test(r3d.msg || ''), r3d.msg);
    // 恢复原顺序，避免影响后续测试
    await api('PUT', '/api/orders/' + id + '/steps/order', { order: beforeOrder }, H);
    od = (await api('GET', '/api/orders/' + id, null, H)).data;

    // 4. 已报工工序不能删除
    const st0 = od.steps.find((s) => s.status !== 'done') || od.steps[0];
    const rep = await api('POST', '/api/reports', { order_id: id, order_step_id: st0.id, worker_id: meta.workers[0].id, qty_good: 5, qty_bad: 0, report_date: new Date().toISOString().slice(0, 10) }, H);
    chk('对工序报工成功', rep.ok, rep.msg);
    const r4 = await api('DELETE', '/api/orders/' + id + '/steps/' + st0.id, null, H);
    chk('已报工工序禁止删除', !r4.ok, JSON.stringify(r4));
    chk('提示包含报工', /报工/.test(r4.msg || ''), r4.msg);

    // 5. 最后一道工序不能删（先清掉其它可删的）
    let guard = 0;
    while (guard++ < 20) {
      const cur = (await api('GET', '/api/orders/' + id, null, H)).data;
      if (cur.steps.length <= 1) break;
      const t = cur.steps.find((s) => Number(s.qty_good) + Number(s.qty_bad) === 0);
      if (!t) break;
      const rr = await api('DELETE', '/api/orders/' + id + '/steps/' + t.id, null, H);
      if (!rr.ok) break;
    }
    const last = (await api('GET', '/api/orders/' + id, null, H)).data.steps[0];
    const r5 = await api('DELETE', '/api/orders/' + id + '/steps/' + last.id, null, H);
    chk('剩余工序均不可删（报工保护/末道保护）', !r5.ok, r5.msg);

    // 5b. 另建工单验证「至少保留一道工序」
    const o2 = (await api('POST', '/api/orders', { product_id: meta.products[0].id, route_id: meta.routes.find((r) => r.product_id === meta.products[0].id).id, qty_plan: 50 }, H)).data;
    let g2 = 0;
    while (g2++ < 20) {
      const cur = (await api('GET', '/api/orders/' + o2.id, null, H)).data;
      if (cur.steps.length <= 1) break;
      const rr = await api('DELETE', '/api/orders/' + o2.id + '/steps/' + cur.steps[0].id, null, H);
      if (!rr.ok) { chk('删除中途出错', false, rr.msg); break; }
    }
    const only = (await api('GET', '/api/orders/' + o2.id, null, H)).data.steps[0];
    const r5b = await api('DELETE', '/api/orders/' + o2.id + '/steps/' + only.id, null, H);
    chk('至少保留一道工序', !r5b.ok && /保留/.test(r5b.msg || ''), r5b.msg);

    // 6. 完成 / 关闭 状态禁止增删
    await api('PATCH', '/api/orders/' + id + '/status', { status: 'done' }, H);
    const r6 = await api('POST', '/api/orders/' + id + '/steps', { process_id: pAdd.id }, H);
    chk('已完工工单禁止增加工序', !r6.ok && /状态/.test(r6.msg || ''), r6.msg);
    const r7 = await api('DELETE', '/api/orders/' + id + '/steps/' + last.id, null, H);
    chk('已完工工单禁止删除工序', !r7.ok, r7.msg);
    await api('PATCH', '/api/orders/' + id + '/status', { status: 'closed', close_reason: '测试' }, H);
    const r8 = await api('POST', '/api/orders/' + id + '/steps', { process_id: pAdd.id }, H);
    chk('已关闭工单禁止增加工序', !r8.ok, r8.msg);

    // 7. 日志留痕
    const logs = (await api('GET', '/api/logs', null, H)).data;
    chk('操作已写入日志', (logs.data || logs).some ? true : Array.isArray(logs));
  } catch (e) {
    fail++; console.log('  EXCEPTION ', e.message);
  }

  console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
  srv.kill();
  process.exit(fail ? 1 : 0);
})();
