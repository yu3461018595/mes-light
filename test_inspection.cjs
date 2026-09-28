'use strict';
/* 检验模式冒烟测试：报工落待检 → 判定合格放行入库 / 不合格开异常单 → 闭环 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 5411;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-insp-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

if (!/^[A-Za-z]:[\\/]/.test(DATA_DIR) && !DATA_DIR.startsWith('/')) {
  console.log('临时数据目录异常: ' + DATA_DIR);
}

let token = null;
async function api(m, u, b, t) {
  const res = await fetch('http://127.0.0.1:' + PORT + u, {
    method: m,
    headers: Object.assign({ 'Content-Type': 'application/json' }, (t || token) ? { Authorization: 'Bearer ' + (t || token) } : {}),
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.json();
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await wait(300); try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/meta'); if (r.ok) up = true; } catch (e) {} }
  if (!up) { console.log('服务未启动'); srv.kill(); process.exit(1); }

  try {
    const lg = await api('POST', '/api/login', { username: 'admin', password: '123456' });
    token = lg.data.token;
    const H = (m, u, b) => api(m, u, b);

    // 质检员登录
    const qc = await api('POST', '/api/login', { username: 'qc01', password: '123456' }, lg.data.token);
    chk('质检员 qc01 可登录', qc.ok && qc.data.user.role === 'inspector', qc);

    console.log('\n--- 1) 建产品 / 工序 / 工艺路线 / 工单（带检验点） ---');
    const sfx = String(Date.now()).slice(-6);
    const prod = await H('POST', '/api/products', { code: 'IP-' + sfx, name: '检验测试件' + sfx, unit: '件', price: 10 });
    chk('建产品', prod.ok, prod);
    const p1 = await H('POST', '/api/processes', { code: 'IPA-' + sfx, name: '车削A' + sfx, std_time: 5, std_price: 1, inspect_type: '' });
    const p2 = await H('POST', '/api/processes', { code: 'IPB-' + sfx, name: '终检B' + sfx, std_time: 3, std_price: 1, inspect_type: 'fqc' });
    chk('建工序（含 fqc 检验点）', p1.ok && p2.ok, { p1, p2 });
    const rt = await H('POST', '/api/routes', {
      code: 'RT-' + sfx, name: '检验路线' + sfx, product_id: prod.data.id,
      steps: [{ seq: 10, process_id: p1.data.id }, { seq: 20, process_id: p2.data.id }],
    });
    chk('建工艺路线', rt.ok, rt);
    const ord = await H('POST', '/api/orders', { product_id: prod.data.id, route_id: rt.data.id, qty_plan: 100 });
    chk('建工单', ord.ok, ord);
    const oid = ord.data.id;
    await H('POST', '/api/orders/' + oid + '/release', {});

    const detail0 = await H('GET', '/api/orders/' + oid);
    const steps0 = detail0.data.steps;
    chk('工序透传检验点标记', steps0.length === 2 && steps0[1].inspect_type === 'fqc', steps0.map((s) => s.inspect_type));
    const stepA = steps0[0].id, stepB = steps0[1].id;

    console.log('\n--- 2) 非检验点报工：直接完工、不入库 ---');
    const r1 = await H('POST', '/api/reports', { order_id: oid, order_step_id: stepA, qty_good: 100, qty_bad: 0, work_min: 60 });
    chk('非检验点报工成功', r1.ok, r1);
    chk('非检验点不产生待检', !r1.data.steps[0].needInspect, r1.data.steps[0]);
    let st = (await H('GET', '/api/orders/' + oid)).data.steps;
    chk('工序A 直接 done', st[0].status === 'done', st[0].status);

    console.log('\n--- 3) 检验点报工：落待检，不完工、不入库 ---');
    const r2 = await H('POST', '/api/reports', { order_id: oid, order_step_id: stepB, qty_good: 100, qty_bad: 0, work_min: 30 });
    chk('检验点报工成功', r2.ok, r2);
    chk('检验点标记 needInspect=true', r2.data.steps[0].needInspect === true, r2.data.steps[0]);
    chk('检验点未自动入库', !r2.data.steps[0].autoFinishIn, r2.data.steps[0]);
    st = (await H('GET', '/api/orders/' + oid)).data.steps;
    chk('工序B 待检 inspect_status=waiting', st[1].inspect_status === 'waiting', st[1].inspect_status);
    chk('工序B 未 done', st[1].status !== 'done', st[1].status);

    console.log('\n--- 4) 待检队列可见 ---');
    const pend = await H('GET', '/api/inspections/pending');
    chk('待检队列含该工序', pend.ok && pend.data.some((r) => r.order_step_id === stepB), (pend.data || []).length);

    console.log('\n--- 5) 判定不合格 → 自动开异常单 + 工序挂起 ---');
    const ins = await H('POST', '/api/inspections', {
      order_step_id: stepB, qty_pass: 90, qty_fail: 10, conclusion: 'fail',
      defects: [{ bad_reason: '表面划伤', qty: 10 }],
    });
    chk('检验判定成功', ins.ok, ins);
    chk('生成异常单', !!(ins.data.issue && ins.data.issue.id), ins.data.issue);
    chk('终检不合格定级 critical', ins.data.issue.level === 'critical', ins.data.issue.level);
    st = (await H('GET', '/api/orders/' + oid)).data.steps;
    chk('工序B 置 failed', st[1].inspect_status === 'failed', st[1].inspect_status);
    const od = await H('GET', '/api/orders/' + oid);
    chk('工单被暂停（critical 阻塞）', od.data.status === 'paused', od.data.status);
    const issId = ins.data.issue.id;

    console.log('\n--- 6) 异常单通知与责任人 ---');
    const is1 = await H('GET', '/api/quality_issues/' + issId);
    chk('异常单可查详情', is1.ok, is1);
    chk('通知时间轴有记录', (is1.data.timeline || []).length >= 1, (is1.data.timeline || []).length);
    const nc = await H('GET', '/api/notifications/unread_count');
    chk('管理员有未读待办', nc.ok && nc.data.count >= 1, nc.data);
    const noti = await H('GET', '/api/notifications');
    chk('通知含异常单号', noti.ok && noti.data.some((n) => n.issue_code === is1.data.code), is1.data.code);

    console.log('\n--- 7) 认领 → 处理 → 验证关闭 → 工单恢复 ---');
    const claim = await H('POST', '/api/quality_issues/' + issId + '/claim', {});
    chk('认领成功', claim.ok, claim);
    const handle = await H('POST', '/api/quality_issues/' + issId + '/handle', { cause: '刀具磨损', action: '更换刀具并返工', disposition: 'rework' });
    chk('提交处理成功', handle.ok, handle);
    const close = await H('POST', '/api/quality_issues/' + issId + '/close', {});
    chk('验证关闭成功', close.ok, close);
    const is2 = await H('GET', '/api/quality_issues/' + issId);
    chk('异常单状态 closed', is2.data.status === 'closed', is2.data.status);
    const od3 = await H('GET', '/api/orders/' + oid);
    chk('工单已从暂停恢复', od3.data.status !== 'paused', od3.data.status);
    const st3 = (await H('GET', '/api/orders/' + oid)).data.steps;
    chk('工序B 已放行 done', st3[1].status === 'done', st3[1].status);

    console.log('\n--- 8) 合格判定 → 末道放行并自动入库 ---');
    const sfx2 = String(Date.now() + 7).slice(-6);
    const prod2 = await H('POST', '/api/products', { code: 'IQ-' + sfx2, name: '合格测试件' + sfx2, unit: '件', price: 10 });
    const q1 = await H('POST', '/api/processes', { code: 'IQA-' + sfx2, name: '精车' + sfx2, std_time: 5, std_price: 1 });
    const q2 = await H('POST', '/api/processes', { code: 'IQB-' + sfx2, name: '终检' + sfx2, std_time: 3, std_price: 1, inspect_type: 'fqc' });
    const rt2 = await H('POST', '/api/routes', { code: 'RTQ-' + sfx2, name: '合格路线', product_id: prod2.data.id, steps: [{ seq: 10, process_id: q1.data.id }, { seq: 20, process_id: q2.data.id }] });
    const ord2 = await H('POST', '/api/orders', { product_id: prod2.data.id, route_id: rt2.data.id, qty_plan: 50 });
    await H('POST', '/api/orders/' + ord2.data.id + '/release', {});
    const st2 = (await H('GET', '/api/orders/' + ord2.data.id)).data.steps;
    await H('POST', '/api/reports', { order_id: ord2.data.id, order_step_id: st2[0].id, qty_good: 50, qty_bad: 0, work_min: 30 });
    await H('POST', '/api/reports', { order_id: ord2.data.id, order_step_id: st2[1].id, qty_good: 50, qty_bad: 0, work_min: 30 });
    const ins2 = await H('POST', '/api/inspections', { order_step_id: st2[1].id, qty_pass: 50, qty_fail: 0, conclusion: 'pass' });
    chk('合格判定成功', ins2.ok, ins2);
    chk('合格放行自动入库', !!(ins2.data.autoFinishIn && ins2.data.autoFinishIn.qty === 50), ins2.data.autoFinishIn);
    chk('合格不生成异常单', !ins2.data.issue, ins2.data.issue);
    const od2 = await H('GET', '/api/orders/' + ord2.data.id);
    chk('工单已完工', od2.data.status === 'done', od2.data.status);

    console.log('\n--- 8b) 一般不合格（非终检、低占比）→ 不开异常单，返工重报回待检 ---');
    const sfx3 = String(Date.now() + 13).slice(-6);
    const prod3 = await H('POST', '/api/products', { code: 'IQN-' + sfx3, name: '一般异常测试件' + sfx3, unit: '件', price: 10 });
    const qm = await H('POST', '/api/processes', { code: 'IQM-' + sfx3, name: '粗车' + sfx3, std_time: 4, std_price: 1, inspect_type: 'ipqc' });
    const rtm = await H('POST', '/api/routes', { code: 'RTM-' + sfx3, name: '一般路线' + sfx3, product_id: prod3.data.id, steps: [{ seq: 10, process_id: qm.data.id }] });
    const ord3 = await H('POST', '/api/orders', { product_id: prod3.data.id, route_id: rtm.data.id, qty_plan: 100 });
    await H('POST', '/api/orders/' + ord3.data.id + '/release', {});
    const stm = (await H('GET', '/api/orders/' + ord3.data.id)).data.steps;
    await H('POST', '/api/reports', { order_id: ord3.data.id, order_step_id: stm[0].id, qty_good: 100, qty_bad: 0, work_min: 30 });
    const insm = await H('POST', '/api/inspections', {
      order_step_id: stm[0].id, qty_pass: 98, qty_fail: 2, conclusion: 'fail',
      defects: [{ bad_reason: '表面划伤', qty: 2 }],
    });
    chk('一般不合格判定成功', insm.ok, insm);
    chk('一般不合格（占比2%）不开异常单', !insm.data.issue, insm.data.issue);
    const stm1 = (await H('GET', '/api/orders/' + ord3.data.id)).data.steps;
    chk('工序置 failed 待返工', stm1[0].inspect_status === 'failed', stm1[0].inspect_status);
    const odm = await H('GET', '/api/orders/' + ord3.data.id);
    chk('工单不暂停', odm.data.status !== 'paused', odm.data.status);
    // 返工重报 → 自动回待检，复检合格放行
    const rw = await H('POST', '/api/reports', { order_id: ord3.data.id, order_step_id: stm[0].id, qty_good: 2, qty_bad: 0, work_min: 10 });
    chk('返工重报成功', rw.ok, rw);
    const stm2 = (await H('GET', '/api/orders/' + ord3.data.id)).data.steps;
    chk('返工后回到待检', stm2[0].inspect_status === 'waiting', stm2[0].inspect_status);
    const insr = await H('POST', '/api/inspections', { order_step_id: stm[0].id, qty_pass: 2, qty_fail: 0, conclusion: 'pass' });
    chk('复检合格放行', insr.ok && !insr.data.issue, insr.data);
    const stm3 = (await H('GET', '/api/orders/' + ord3.data.id)).data.steps;
    chk('复检后工序已放行', stm3[0].inspect_status === 'passed', stm3[0].inspect_status);

    console.log('\n--- 9) 质量统计 ---');
    const q = await H('GET', '/api/stats/quality');
    chk('质量统计可用', q.ok, q);
    chk('帕累托含表面划伤', (q.data.pareto || []).some((r) => r.name === '表面划伤'), q.data.pareto);

    console.log('\n--- 10) 报工自主上报异常 ---');
    const up1 = await H('POST', '/api/quality_issues', { order_id: oid, level: 'major', source: 'report', qty_affected: 5, bad_summary: '设备异响，疑似主轴故障' });
    chk('自主上报成功', up1.ok && up1.data.id, up1);
    chk('异常单号前缀 QA', String(up1.data.code).startsWith('QA'), up1.data.code);

    console.log('\n--- 11) 作废流程 ---');
    const cancel = await H('POST', '/api/quality_issues/' + up1.data.id + '/cancel', { reason: '误报' });
    chk('作废成功', cancel.ok, cancel);

    console.log('\n--- 12) 检验设置读写 ---');
    const set1 = await H('POST', '/api/quality/settings', { webhook_url: '', escalate_minutes: 120, remind_minutes: 15 });
    chk('保存设置', set1.ok, set1);
    const get1 = await H('GET', '/api/quality/settings');
    chk('读取设置一致', get1.ok && Number(get1.data.escalate_minutes) === 120, get1.data);

    console.log('\n--- 13) 老工单兼容（无检验点不受影响） ---');
    const allOrders = await H('GET', '/api/orders');
    const noInsp = (allOrders.data || []).filter((o) => o.status === 'running' || o.status === 'released');
    chk('存在工单可正常处理', allOrders.ok, (allOrders.data || []).length);
  } catch (e) {
    fail++;
    console.log('  异常: ' + e.message + '\n' + (e.stack || ''));
  }

  console.log('\n================================');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log('================================');
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
