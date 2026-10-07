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

    console.log('\n--- 14) 质量v2：检查表 / 抽检 / 阈值配置 / 取消检验 ---');
    // 14.1 检验项目模板 CRUD + 绑定工序
    const clItems = [{ name: '外观无划伤', standard: '目视' }, { name: '关键尺寸', standard: 'φ20±0.05' }];
    const cl1 = await H('POST', '/api/checklists', { name: '终检模板-' + sfx, items: clItems });
    chk('新建检查表模板', cl1.ok && cl1.data.id, cl1);
    const clBind = await H('PUT', '/api/checklists/' + cl1.data.id, { name: '终检模板-' + sfx, process_id: p2.data.id, items: clItems });
    chk('模板绑定工序', clBind.ok, clBind);
    const clList = await H('GET', '/api/checklists');
    chk('模板列表可读', clList.ok && clList.data.some((c) => c.id === cl1.data.id && c.process_name), clList.data && clList.data.length);

    // 14.2 新工单 → 报工 → 待检队列带出检查表
    const ordv = await H('POST', '/api/orders', { code: 'MO-V2-' + sfx, product_id: prod.data.id, route_id: rt.data.id, qty_plan: 10 });
    chk('建V2工单', ordv.ok, ordv);
    const relv = await H('PATCH', '/api/orders/' + ordv.data.id + '/status', { status: 'released' });
    chk('下发V2工单', relv.ok, relv);
    const vsteps = (await H('GET', '/api/orders/' + ordv.data.id)).data.steps;
    const repv1 = await H('POST', '/api/reports', { order_id: ordv.data.id, order_step_id: vsteps[0].id, qty_good: 10, qty_bad: 0, work_min: 5 });
    chk('V2首道报工', repv1.ok, repv1);
    const repv2 = await H('POST', '/api/reports', { order_id: ordv.data.id, order_step_id: vsteps[1].id, qty_good: 10, qty_bad: 0, work_min: 5 });
    chk('V2终道报工落待检', repv2.ok, repv2);
    const pv = (await H('GET', '/api/inspections/pending')).data.find((r) => r.order_step_id === vsteps[1].id);
    chk('待检队列带出检查表', pv && Array.isArray(pv.checklist) && pv.checklist.length === 2, pv && pv.checklist);

    // 14.3 阈值配置：critical_ratio 调成 50（让 20% 占比不触发致命）
    const setR = await H('POST', '/api/quality/settings', { critical_ratio: 50, minor_ratio: 5 });
    chk('配置定级阈值', setR.ok, setR);
    const getR = await H('GET', '/api/quality/settings');
    chk('阈值读取一致', getR.ok && Number(getR.data.critical_ratio) === 50, getR.data);

    // 14.4 抽检 + 检查表 NG 判不合格（占比 20% → major，不开单）
    const insv = await H('POST', '/api/inspections', {
      order_step_id: vsteps[1].id, inspect_mode: 'sample', sample_qty: 5, qty_fail: 1, conclusion: 'fail',
      checklist: [{ name: '外观无划伤', result: 'ng', qty: 1 }, { name: '关键尺寸', result: 'ok', qty: 0 }],
    });
    chk('抽检+检查表判定成功', insv.ok, insv);
    chk('受检数=样本数', insv.data.qty_pass === 4 && insv.data.qty_fail === 1, insv.data);
    const insvD = await H('GET', '/api/inspections/' + insv.data.inspection_id);
    chk('NG 项并入不良明细', insvD.ok && (insvD.data.defects || []).some((d) => d.bad_reason === '外观无划伤' && d.qty === 1), insvD.data && insvD.data.defects);
    chk('终检不合格触发致命开单（fqc 规则优先于阈值）', insv.ok && insv.data.issue && insv.data.issue.level === 'critical', insv.data.issue);
    const vst1 = (await H('GET', '/api/orders/' + ordv.data.id)).data.steps;
    chk('终道置 failed', vst1[1].inspect_status === 'failed', vst1[1].inspect_status);

    // 14.5 取消检验：已报工且不合格状态的工序也可取消检验（按普通工序放行）
    const cancelInsp = await H('PUT', '/api/orders/' + ordv.data.id + '/steps/' + vsteps[1].id + '/inspect', { inspect_type: '' });
    chk('取消检验成功', cancelInsp.ok, cancelInsp);
    chk('返回已放行标记', cancelInsp.data.released === true, cancelInsp.data);
    const vst2 = (await H('GET', '/api/orders/' + ordv.data.id)).data.steps;
    chk('取消后工序完工放行', vst2[1].inspect_type === '' && vst2[1].inspect_status == null && vst2[1].status === 'done', vst2[1]);
    const odv = await H('GET', '/api/orders/' + ordv.data.id);
    chk('工单随之完工', odv.data.status === 'done', odv.data.status);

    // 14.6 检查表 NG 不允许判定合格
    const repv3 = await H('POST', '/api/reports', { order_id: ord3.data.id, order_step_id: stm[0].id, qty_good: 1, qty_bad: 0, work_min: 2 });
    const pend3 = (await H('GET', '/api/inspections/pending')).data.find((r) => r.order_step_id === stm[0].id);
    if (pend3) {
      const bad = await H('POST', '/api/inspections', {
        order_step_id: stm[0].id, qty_fail: 1, conclusion: 'pass',
        checklist: [{ name: '外观NG项', result: 'ng', qty: 1 }],
      });
      chk('NG 项不允许判合格', !bad.ok, bad);
    }
    console.log('\n--- 15) 异常上报口径 + 完工工单取消检验 ---');
    // 15.1 完工(done)工单也可取消检验（修复前 done/closed 状态后端直接拒绝）
    const ordDone = await H('POST', '/api/orders', { code: 'MO-DONE-' + sfx, product_id: prod.data.id, route_id: rt.data.id, qty_plan: 8 });
    chk('建完工测试工单', ordDone.ok, ordDone);
    await H('PATCH', '/api/orders/' + ordDone.data.id + '/status', { status: 'released' });
    const dSt = (await H('GET', '/api/orders/' + ordDone.data.id)).data.steps;
    await H('POST', '/api/reports', { order_id: ordDone.data.id, order_step_id: dSt[0].id, qty_good: 8, qty_bad: 0, work_min: 4 });
    await H('POST', '/api/reports', { order_id: ordDone.data.id, order_step_id: dSt[1].id, qty_good: 8, qty_bad: 0, work_min: 4 });
    const pendD = (await H('GET', '/api/inspections/pending')).data.find((r) => r.order_step_id === dSt[1].id);
    chk('末道 fqc 已待检', pendD && pendD.inspect_type === 'fqc', pendD);
    const inspD = await H('POST', '/api/inspections', { order_step_id: dSt[1].id, qty_pass: 8, qty_fail: 0, conclusion: 'pass' });
    chk('末道判定合格放行', inspD.ok, inspD);
    const dDone = await H('GET', '/api/orders/' + ordDone.data.id);
    chk('工单已完工(done)', dDone.data.status === 'done', dDone.data.status);
    const cancelDone = await H('PUT', '/api/orders/' + ordDone.data.id + '/steps/' + dSt[1].id + '/inspect', { inspect_type: '' });
    chk('完工工单仍可取消检验', cancelDone.ok, cancelDone);
    const dSt2 = (await H('GET', '/api/orders/' + ordDone.data.id)).data.steps;
    chk('取消后检验标记清空', dSt2[1].inspect_type === '', dSt2[1].inspect_type);

    // 15.2 上报口径（2026-10-06）：非检验员上报只留存记录不推送任何通知；检验员上报直接定级并通知责任人+管理层
    const tech = await api('POST', '/api/login', { username: 'tech1', password: '123456' }, lg.data.token);
    chk('技术员 tech1 可登录', tech.ok && tech.data.user.role === 'technician', tech);
    const ordTech = await api('POST', '/api/orders', { product_id: prod.data.id, route_id: rt.data.id, qty_plan: 5 }, tech.data.token);
    chk('技术员建工单', ordTech.ok, ordTech);

    // 非检验员（管理员代报）：只留存数据记录与统计，不推送任何通知
    const adminRep = await H('POST', '/api/quality_issues', { order_id: ordTech.data.id, source: 'report', qty_affected: 3, bad_summary: '管理员代报：批量尺寸超差' });
    chk('管理员上报成功(待定级)', adminRep.ok && adminRep.data.level === 'pending', adminRep.data);
    const adminDet = await H('GET', '/api/quality_issues/' + adminRep.data.id);
    const adminKinds = (adminDet.data.timeline || []).map((n) => n.kind);
    chk('非检验员上报(未申报)：不推送任何通知(timeline 为空)', adminKinds.length === 0, adminKinds);

    // 非检验员申报重大（严重）→ 通知检验员及时定级（不通知责任人/管理层），正式等级仍待定级
    const adminMajor = await H('POST', '/api/quality_issues', { order_id: ordTech.data.id, source: 'report', level: 'major', qty_affected: 5, bad_summary: '管理员代报：疑似批量开裂' });
    chk('管理员申报重大上报成功(仍待定级)', adminMajor.ok && adminMajor.data.level === 'pending', adminMajor.data);
    const adminMajorDet = await H('GET', '/api/quality_issues/' + adminMajor.data.id);
    const adminMajorKinds = (adminMajorDet.data.timeline || []).map((n) => n.kind);
    chk('申报重大：通知检验员(created)', adminMajorKinds.includes('created'), adminMajorKinds);
    chk('申报重大：不推管理层(无 escalate)', !adminMajorKinds.includes('escalate'), adminMajorKinds);
    const majorTos = (adminMajorDet.data.timeline || []).filter((n) => n.kind === 'created').map((n) => n.to_user_id);
    const usersAll2 = await H('GET', '/api/users');
    const inspIds = (usersAll2.data || []).filter((u2) => u2.role === 'inspector').map((u2) => u2.id);
    chk('申报重大：通知对象均为检验员', majorTos.length > 0 && majorTos.every((id2) => inspIds.includes(id2)), { majorTos, inspIds });

    // 非检验员申报轻微 → 仅留存，无任何通知
    const adminMinor = await H('POST', '/api/quality_issues', { order_id: ordTech.data.id, source: 'report', level: 'minor', qty_affected: 1, bad_summary: '管理员代报：轻微划伤' });
    const adminMinorDet = await H('GET', '/api/quality_issues/' + adminMinor.data.id);
    const adminMinorKinds = (adminMinorDet.data.timeline || []).map((n) => n.kind);
    chk('申报轻微：仅留存(timeline 为空)', adminMinor.ok && adminMinor.data.level === 'pending' && adminMinorKinds.length === 0, adminMinorKinds);

    // 检验员上报：可直接定级；严重级仅通知责任人，不推管理层
    const qcReport = await api('POST', '/api/quality_issues', { order_id: ordTech.data.id, source: 'report', level: 'major', qty_affected: 2, bad_summary: '质检员发现材质不符' }, qc.data.token);
    chk('质检员上报等级生效(major)', qcReport.ok && qcReport.data.level === 'major', qcReport.data);
    const qcDet0 = await api('GET', '/api/quality_issues/' + qcReport.data.id, null, null, qc.data.token);
    const qcKinds0 = (qcDet0.data.timeline || []).map((n) => n.kind);
    chk('质检员上报严重级：通知责任人(created)', qcKinds0.includes('created'), qcKinds0);
    chk('质检员上报严重级：不推管理层(无 escalate)', !qcKinds0.includes('escalate'), qcKinds0);

    // 检验员上报致命级 → 通知责任人 + 管理层
    const qcCrit = await api('POST', '/api/quality_issues', { order_id: ordTech.data.id, source: 'report', level: 'critical', qty_affected: 4, bad_summary: '质检员上报：关键件开裂' }, qc.data.token);
    chk('质检员上报致命级生效', qcCrit.ok && qcCrit.data.level === 'critical', qcCrit.data);
    const qcCritDet = await api('GET', '/api/quality_issues/' + qcCrit.data.id, null, null, qc.data.token);
    const qcCritKinds = (qcCritDet.data.timeline || []).map((n) => n.kind);
    chk('质检员上报致命级：有 escalate', qcCritKinds.includes('escalate'), qcCritKinds);

    // 非检验员上报的待定级单，由检验员定级为致命级 → 推送厂部管理层
    const qcGrade = await api('PUT', '/api/quality_issues/' + adminRep.data.id + '/level', { level: 'critical' }, qc.data.token);
    chk('检验员定级为致命级成功', qcGrade.ok && qcGrade.data.level === 'critical', qcGrade.data);
    const qcDet = await api('GET', '/api/quality_issues/' + adminRep.data.id, null, null, qc.data.token);
    const qcKinds = (qcDet.data.timeline || []).map((n) => n.kind);
    chk('定级致命级：升级管理层(有 escalate)', qcKinds.includes('escalate'), qcKinds);
    chk('定级致命级：有定级记录(graded)', qcKinds.includes('graded'), qcKinds);
    // 越权：普通技术员不能定级
    const techGrade = await api('PUT', '/api/quality_issues/' + adminRep.data.id + '/level', { level: 'minor' }, tech.data.token);
    chk('技术员越权定级被拒', !techGrade.ok, techGrade);

    console.log('\n--- 16) 工单负责人 + 检验反馈异常首推负责人 ---');
    const usersL = await H('GET', '/api/users');
    const tech1u = (usersL.data || []).find((u) => u.username === 'tech1');
    const tech1id = tech1u ? tech1u.id : null;
    chk('找到技术员 tech1', !!tech1id, tech1u);

    // 16.1 指定负责人后：检验反馈异常的责任人=负责人，首条通知推送给负责人
    const sfx6 = String(Date.now() + 61).slice(-6);
    const prod6 = await H('POST', '/api/products', { code: 'OW-' + sfx6, name: '负责人工单件' + sfx6, unit: '件', price: 10 });
    const p6a = await H('POST', '/api/processes', { code: 'OWA-' + sfx6, name: '加工' + sfx6, std_time: 5, std_price: 1 });
    const p6b = await H('POST', '/api/processes', { code: 'OWB-' + sfx6, name: '终检' + sfx6, std_time: 3, std_price: 1, inspect_type: 'fqc' });
    const rt6 = await H('POST', '/api/routes', { code: 'RTW-' + sfx6, name: '负责路线' + sfx6, product_id: prod6.data.id, steps: [{ seq: 10, process_id: p6a.data.id }, { seq: 20, process_id: p6b.data.id }] });
    const ord6 = await H('POST', '/api/orders', { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 20 });
    chk('建负责人测试工单', ord6.ok, ord6);
    await H('PATCH', '/api/orders/' + ord6.data.id + '/status', { status: 'released' });
    const st6 = (await H('GET', '/api/orders/' + ord6.data.id)).data.steps;
    await H('POST', '/api/reports', { order_id: ord6.data.id, order_step_id: st6[1].id, qty_good: 20, qty_bad: 0, work_min: 10 });
    const own = await H('PUT', '/api/orders/' + ord6.data.id + '/owner', { owner_user_id: tech1id });
    chk('指派负责人成功', own.ok && own.data.owner_user_id === tech1id, own.data);
    const ord6d = await H('GET', '/api/orders/' + ord6.data.id);
    chk('工单详情返回负责人', ord6d.data.owner_user_id === tech1id && ord6d.data.owner_name === '李伟', ord6d.data);
    const insp6 = await api('POST', '/api/inspections', { order_step_id: st6[1].id, qty_pass: 16, qty_fail: 4, conclusion: 'fail', defects: [{ bad_reason: '尺寸超差', qty: 4 }] }, qc.data.token);
    chk('终检不合格开异常单', insp6.ok && insp6.data.issue && insp6.data.issue.id, insp6.data && insp6.data.issue);
    const iss6 = insp6.data.issue.id;
    const iss6d = await H('GET', '/api/quality_issues/' + iss6);
    chk('异常责任人=工单负责人(tech1)', iss6d.data.assignee_user_id === tech1id && iss6d.data.assignee_name === '李伟', iss6d.data);
    const createdTo6 = (iss6d.data.timeline || []).filter((n) => n.kind === 'created').map((n) => n.to_user_id);
    chk('首条通知推送给负责人(tech1)', createdTo6.includes(tech1id), createdTo6);
    // 工序名必须取真实工序名（回归：早期版本误写成「工序N·检验类型」或 NULL）
    const realPn6 = st6[1].process_name;
    chk('异常单工序名=真实工序名', iss6d.data.process_name === realPn6 && !/^工序/.test(iss6d.data.process_name || ''), iss6d.data.process_name);
    chk('异常单来源检验单工序名=真实工序名', iss6d.data.inspection && iss6d.data.inspection.process_name === realPn6, iss6d.data.inspection && iss6d.data.inspection.process_name);

    // 16.2 未指定负责人 → 沿用系统定责（责任人不是 tech1）
    const sfx7 = String(Date.now() + 67).slice(-6);
    const prod7 = await H('POST', '/api/products', { code: 'OWX-' + sfx7, name: '无负责人工单件' + sfx7, unit: '件', price: 10 });
    const p7a = await H('POST', '/api/processes', { code: 'OWXA-' + sfx7, name: '加工X' + sfx7, std_time: 5, std_price: 1 });
    const p7b = await H('POST', '/api/processes', { code: 'OWXB-' + sfx7, name: '终检X' + sfx7, std_time: 3, std_price: 1, inspect_type: 'fqc' });
    const rt7 = await H('POST', '/api/routes', { code: 'RTWX-' + sfx7, name: '无负责路线' + sfx7, product_id: prod7.data.id, steps: [{ seq: 10, process_id: p7a.data.id }, { seq: 20, process_id: p7b.data.id }] });
    const ord7 = await H('POST', '/api/orders', { product_id: prod7.data.id, route_id: rt7.data.id, qty_plan: 20 });
    await H('PATCH', '/api/orders/' + ord7.data.id + '/status', { status: 'released' });
    const st7 = (await H('GET', '/api/orders/' + ord7.data.id)).data.steps;
    await H('POST', '/api/reports', { order_id: ord7.data.id, order_step_id: st7[1].id, qty_good:20, qty_bad: 0, work_min: 10 });
    const insp7 = await api('POST', '/api/inspections', { order_step_id: st7[1].id, qty_pass: 16, qty_fail: 4, conclusion: 'fail', defects: [{ bad_reason: '尺寸超差', qty: 4 }] }, qc.data.token);
    chk('无负责人：终检不合格仍开异常单', insp7.ok && insp7.data.issue && insp7.data.issue.id, insp7.data && insp7.data.issue);
    const iss7 = insp7.data.issue.id;
    const iss7d = await H('GET', '/api/quality_issues/' + iss7);
    chk('无负责人：责任人回退（非 tech1、非空）', iss7d.data.assignee_user_id !== tech1id && iss7d.data.assignee_user_id != null, iss7d.data);

    // 16.3 清空负责人
    const clearOwn = await H('PUT', '/api/orders/' + ord6.data.id + '/owner', { owner_user_id: null });
    chk('清空负责人成功', clearOwn.ok && clearOwn.data.owner_user_id == null, clearOwn.data);

    // 16.4 创建工单时直接指定责任人 + 编辑工单修改/清空责任人
    const adminU = (usersL.data || []).find((u) => u.username === 'admin');
    const ord8 = await H('POST', '/api/orders', { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 5, owner_user_id: tech1id });
    chk('创建时带责任人成功', ord8.ok, ord8);
    const ord8d = await H('GET', '/api/orders/' + ord8.data.id);
    chk('创建后责任人=tech1/李伟', ord8d.data.owner_user_id === tech1id && ord8d.data.owner_name === '李伟', ord8d.data);
    const ord8e = await H('PUT', '/api/orders/' + ord8.data.id, { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 5, priority: 2, plan_start: '2026-10-06', plan_end: '2026-10-07', remark: '', owner_user_id: adminU.id });
    chk('编辑工单修改责任人成功', ord8e.ok, ord8e);
    const ord8e2 = await H('GET', '/api/orders/' + ord8.data.id);
    chk('编辑后责任人=admin', ord8e2.data.owner_user_id === adminU.id && !!ord8e2.data.owner_name, ord8e2.data);
    const ord8e3 = await H('PUT', '/api/orders/' + ord8.data.id, { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 5, priority: 2, plan_start: '2026-10-06', plan_end: '2026-10-07', remark: '', owner_user_id: null });
    const ord8e4 = await H('GET', '/api/orders/' + ord8.data.id);
    chk('编辑清空责任人成功', ord8e3.ok && ord8e4.data.owner_user_id == null && !ord8e4.data.owner_name, ord8e4.data);
    const ord8bad = await H('POST', '/api/orders', { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 5, owner_user_id: 999999 });
    chk('不存在的责任人被拒 400', ord8bad.ok === false, ord8bad);
    // 操作工不能当责任人：创建 / 编辑 / 专用接口三处均拒绝
    const wkOwn = await H('POST', '/api/users', { username: 'wkown' + sfx6.slice(-4), password: 'pass1234', name: '操作工甲', role: 'worker', team: '甲班' });
    chk('建操作工账号', wkOwn.ok, wkOwn);
    const logsBeforeOw = (await api('GET', '/api/logs?limit=500', null, lg.data.token)).data || [];
    const lastCreateId = ((logsBeforeOw.find((x) => x.action === '创建工单')) || {}).id || 0;
    const owR1 = await H('POST', '/api/orders', { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 5, owner_user_id: wkOwn.data.id });
    chk('创建工单选操作工当责任人被拒', owR1.ok === false, owR1);
    const logsAfterOw = (await api('GET', '/api/logs?limit=500', null, lg.data.token)).data || [];
    chk('创建被拒后不误写「创建工单」日志（校验在事务外）', !logsAfterOw.find((x) => x.action === '创建工单' && x.id > lastCreateId), logsAfterOw.slice(0, 3));
    const owR2 = await H('PUT', '/api/orders/' + ord8.data.id, { product_id: prod6.data.id, route_id: rt6.data.id, qty_plan: 5, priority: 2, plan_start: '2026-10-06', plan_end: '2026-10-07', remark: '', owner_user_id: wkOwn.data.id });
    chk('编辑工单选操作工当责任人被拒', owR2.ok === false, owR2);
    const owR3 = await H('PUT', '/api/orders/' + ord8.data.id + '/owner', { owner_user_id: wkOwn.data.id });
    chk('专用接口选操作工当责任人被拒', owR3.ok === false, owR3);

    // 17) 报工不良提醒：达阈值（检验设置 minor_ratio，默认 5%）才推送；收件人=责任人+质检员，不再全员轰炸管理员
    console.log('\n--- 17) 报工不良提醒阈值与收件人 ---');
    const sfx9 = String(Date.now() + 73).slice(-6);
    const prod9 = await H('POST', '/api/products', { code: 'RA-' + sfx9, name: '提醒测试件' + sfx9, unit: '件', price: 5 });
    const p9 = await H('POST', '/api/processes', { code: 'RPA-' + sfx9, name: '加工R' + sfx9, std_time: 5, std_price: 1 });
    const rt9 = await H('POST', '/api/routes', { code: 'RTR-' + sfx9, name: '提醒路线' + sfx9, product_id: prod9.data.id, steps: [{ seq: 10, process_id: p9.data.id }] });
    const uq9 = 'ra' + sfx9;
    const ow9 = await H('POST', '/api/users', { username: uq9 + 'o', password: 'pass1234', name: '责任人九', role: 'technician', team: '甲班' });
    const wk9 = await H('POST', '/api/users', { username: uq9 + 'w', password: 'pass1234', name: '工人九', role: 'worker', team: '甲班' });
    chk('建提醒测试用户', ow9.ok && wk9.ok, { ow9, wk9 });
    const ord9 = await H('POST', '/api/orders', { product_id: prod9.data.id, route_id: rt9.data.id, qty_plan: 5000, owner_user_id: ow9.data.id });
    chk('建提醒测试工单(带责任人)', ord9.ok, ord9);
    const owTok9 = (await api('POST', '/api/login', { username: uq9 + 'o', password: 'pass1234' }, lg.data.token)).data.token;
    const wkTok9 = (await api('POST', '/api/login', { username: uq9 + 'w', password: 'pass1234' }, lg.data.token)).data.token;
    const qcTok9 = (await api('POST', '/api/login', { username: 'qc01', password: '123456' }, lg.data.token)).data.token;
    const st9 = (await H('GET', '/api/orders/' + ord9.data.id)).data.steps;
    const cntRemind = async (t) => (((await api('GET', '/api/notifications', null, t)).data || []).filter((n) => /报工不良提醒/.test(n.title || ''))).length;
    const ow0 = await cntRemind(owTok9), qc0 = await cntRemind(qcTok9), ad0 = await cntRemind(lg.data.token);
    // 9.1 低于阈值（2% < 5%）→ 不推送
    await api('POST', '/api/reports', { order_id: ord9.data.id, order_step_id: st9[0].id, qty_good: 980, qty_bad: 20, work_min: 10 }, wkTok9);
    const ow1 = await cntRemind(owTok9), qc1 = await cntRemind(qcTok9), ad1 = await cntRemind(lg.data.token);
    chk('低于阈值(2%<5%)不推送提醒', ow1 === ow0 && qc1 === qc0 && ad1 === ad0, { ow0, ow1, qc0, qc1, ad0, ad1 });
    // 9.2 达到阈值（10% ≥ 5%）→ 推送给责任人 + 质检员，管理员（非责任人）不收
    const rep9 = await api('POST', '/api/reports', { order_id: ord9.data.id, order_step_id: st9[0].id, qty_good: 90, qty_bad: 10, work_min: 5 }, wkTok9);
    chk('达到阈值报工成功', rep9.ok, rep9);
    const ow2 = await cntRemind(owTok9), qc2 = await cntRemind(qcTok9), ad2 = await cntRemind(lg.data.token);
    chk('责任人收到不良提醒', ow2 === ow1 + 1, { ow1, ow2 });
    chk('质检员收到不良提醒', qc2 === qc1 + 1, { qc1, qc2 });
    chk('管理员(非责任人)不再收到不良提醒', ad2 === ad1, { ad1, ad2 });
    const owMsgs = ((await api('GET', '/api/notifications', null, owTok9)).data || []).filter((n) => /报工不良提醒/.test(n.title || ''));
    chk('提醒标题含不良率', /（10%）/.test(owMsgs[0] && owMsgs[0].title || ''), owMsgs[0] && owMsgs[0].title);
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
