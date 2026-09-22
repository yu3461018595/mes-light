/* 静态模式（浏览器数据层 store.js）检验模块冒烟测试
 * 校验一期检验模式在静态版里与后端行为一致：
 *   检验点透传 → 报工落待检 → 待检队列 → 判定放行 / 不合格开异常单 → 异常闭环 → 通知红点
 * 在 Node 中以浏览器全局环境模拟运行 store.js，不动 data/mes.db。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const mem = {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
const SEED = path.join(__dirname, 'public/data/seed.json');
globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(SEED, 'utf8')) });

const Store = require('./public/js/store.js');

let pass = 0; let bad = 0;
function assert(cond, msg) { if (!cond) { console.error('  ✗ FAIL:', msg); bad++; } else { console.log('  ✓', msg); pass++; } }
const call = (m, u, b) => Store.handle(m, u, b || {});

(async () => {
  await Store.init();
  // 登录 admin
  let r = await call('POST', '/login', { username: 'admin', password: '123456' });
  assert(r.ok, 'admin 登录成功');
  const admin = r.data;
  const loginAs = (u) => call('POST', '/login', { username: u, password: '123456' }).then((x) => x.data && x.data.user);

  console.log('\n--- 1) 质检员账号与检验点种子 ---');
  const users = (await call('GET', '/users')).data;
  const qc = users.find((u) => u.role === 'inspector');
  assert(!!qc, '存在质检员账号 ' + (qc && qc.username + '/' + qc.name));
  const procs = (await call('GET', '/processes')).data;
  const inspProcs = procs.filter((p) => String(p.inspect_type || '').trim());
  assert(inspProcs.length > 0, `${inspProcs.length} 道工序已标记检验点（如 ${inspProcs.map((p) => p.name).join('、')}）`);
  const orders = (await call('GET', '/orders')).data;
  assert(orders.length > 0, `演示工单 ${orders.length} 张`);

  console.log('\n--- 2) 质检员权限（可判定、不可改工单） ---');
  await loginAs('qc01');
  r = await call('GET', '/inspections/pending');
  assert(r.ok, '质检员可读待检队列');
  r = await call('GET', '/quality/settings');
  assert(!r.ok, '质检员不可读检验设置（仅 admin/technician）');
  await loginAs('admin');

  console.log('\n--- 3) 建检验点工单 → 报工落待检 ---');
  // 自建：产品 + 检验工序 + 路线 + 工单
  await call('POST', '/products', { code: 'QT-P1', name: '质检测试件', unit: '件' });
  const qp = (await call('GET', '/products')).data.find((x) => x.code === 'QT-P1');
  await call('POST', '/processes', { code: 'QT-OP1', name: '车削QT', inspect_type: 'ipqc' });
  await call('POST', '/work_centers', { code: 'QT-WC1', name: '车床QT' });
  const qop = (await call('GET', '/processes')).data.find((x) => x.code === 'QT-OP1');
  assert(String(qop.inspect_type) === 'ipqc', '工序档案 inspect_type 落库为 ipqc');
  const qwc = (await call('GET', '/work_centers')).data.find((x) => x.code === 'QT-WC1');
  r = await call('POST', '/routes', { code: 'QT-RT1', name: 'QT路线', product_id: qp.id, steps: [{ seq: 10, process_id: qop.id, work_center_id: qwc.id }] });
  const qrtId = r.data.id;
  const qrtSteps = (await call('GET', '/routes/' + qrtId + '/steps')).data;
  assert(String(qrtSteps[0].inspect_type) === 'ipqc', 'route_steps 透传 inspect_type');
  r = await call('POST', '/orders', { product_id: qp.id, route_id: qrtId, qty_plan: 100, priority: 1, plan_end: '2099-01-01' });
  const qoid = r.data.id;
  r = await call('PUT', '/orders/' + qoid, { status: 'released', product_id: qp.id, route_id: qrtId, qty_plan: 100, priority: 1 });
  const od = (await call('GET', '/orders/' + qoid)).data;
  assert(String(od.steps[0].inspect_type) === 'ipqc', 'order_steps 透传 inspect_type');
  assert(!String(od.steps[0].inspect_status || ''), '初始 inspect_status 为空');

  const wid = users.find((u) => u.role === 'worker').id;
  r = await call('POST', '/reports', { order_id: qoid, worker_id: wid, work_min: 0, steps: [{ order_step_id: od.steps[0].id, qty_good: 60, qty_bad: 0 }] });
  assert(r.ok, '报工成功');
  assert(r.data.steps[0].needInspect === true, '返回 needInspect=true');
  assert(!r.data.steps[0].autoFinishIn, '检验点报工不自动完工/入库');
  const after = (await call('GET', '/orders/' + qoid)).data;
  assert(after.steps[0].inspect_status === 'waiting', '工序落 inspect_status=waiting');
  assert(after.steps[0].status !== 'done', '工序未直接置 done（等判定）');

  console.log('\n--- 4) 待检队列 ---');
  await loginAs('qc01');
  const pend = (await call('GET', '/inspections/pending')).data;
  const mine = pend.filter((x) => Number(x.order_id) === Number(qoid));
  assert(mine.length === 1, '待检队列含该工序');
  assert(mine[0].process_name === '车削QT' && mine[0].qty_good === 60, '队列字段完整（工序名/已报合格数）');
  await loginAs('admin');

  console.log('\n--- 5) 判定不合格 → 开异常单 ---');
  let badReasons = (await call('GET', '/bad_reasons')).data;
  const br = badReasons.find((x) => x.name === '尺寸超差') || badReasons[0];
  r = await call('POST', '/inspections', {
    order_step_id: after.steps[0].id, qty_pass: 40, qty_fail: 20, conclusion: 'fail',
    defects: [{ bad_reason_id: br.id, qty: 20 }], remark: '首件抽检超差',
  });
  assert(r.ok, '提交不合格判定成功');
  const issueId = r.data.issue && r.data.issue.id;
  assert(!!issueId, '自动生成质量异常单 ' + (r.data.issue && r.data.issue.code));
  assert(r.data.issue.level === 'critical', '不合格占比 33% → 定级 critical');
  const stepAfterFail = (await call('GET', '/orders/' + qoid)).data;
  assert(stepAfterFail.steps[0].inspect_status === 'failed', '工序置 inspect_status=failed');
  assert(stepAfterFail.status === 'paused', 'critical 异常暂停工单');

  console.log('\n--- 6) 通知与待办 ---');
  const issueDetail = (await call('GET', '/quality_issues/' + issueId)).data;
  assert(!!issueDetail.assignee_user_id, '异常单已定责（责任人 ' + issueDetail.assignee_name + '）');
  assert(issueDetail.timeline.length >= 1, '生成开单通知 ' + issueDetail.timeline.length + ' 条');
  assert(issueDetail.inspection && issueDetail.inspection.defects.length === 1, '关联检验单含 1 项不良明细');

  console.log('\n--- 7) 认领 → 处理 → 验证关闭 → 工单恢复 ---');
  r = await call('POST', '/quality_issues/' + issueId + '/claim', {});
  assert(r.ok && (await call('GET', '/quality_issues/' + issueId)).data.status === 'processing', '认领后状态 processing');
  r = await call('POST', '/quality_issues/' + issueId + '/handle', { cause: '刀具磨损', action: '换刀并全检', disposition: 'rework' });
  assert(r.ok && (await call('GET', '/quality_issues/' + issueId)).data.status === 'verifying', '处理后面待验证');
  r = await call('POST', '/quality_issues/' + issueId + '/close', { release: true });
  assert(r.ok, '验证关闭成功');
  const closed = (await call('GET', '/quality_issues/' + issueId)).data;
  assert(closed.status === 'closed' && !!closed.closed_at, '异常单已闭环');
  const afterClose = (await call('GET', '/orders/' + qoid)).data;
  assert(afterClose.status === 'running', '工单已恢复 running');
  assert(String(afterClose.steps[0].inspect_status) === 'passed', '工序已放行 passed');

  console.log('\n--- 8) 合格放行（末道自动入库） ---');
  // 建一张末道为终检的工单
  await call('POST', '/processes', { code: 'QT-OP2', name: '检验QT', inspect_type: 'fqc' });
  const qop2 = (await call('GET', '/processes')).data.find((x) => x.code === 'QT-OP2');
  r = await call('POST', '/routes', { code: 'QT-RT2', name: 'QT路线2', product_id: qp.id, steps: [{ seq: 10, process_id: qop2.id, work_center_id: qwc.id }] });
  const qrt2 = r.data.id;
  r = await call('POST', '/orders', { product_id: qp.id, route_id: qrt2, qty_plan: 50, priority: 1, plan_end: '2099-01-01' });
  const qoid2 = r.data.id;
  await call('PUT', '/orders/' + qoid2, { status: 'released', product_id: qp.id, route_id: qrt2, qty_plan: 50, priority: 1 });
  const od2 = (await call('GET', '/orders/' + qoid2)).data;
  await call('POST', '/reports', { order_id: qoid2, worker_id: wid, work_min: 0, steps: [{ order_step_id: od2.steps[0].id, qty_good: 50, qty_bad: 0 }] });
  r = await call('POST', '/inspections', { order_step_id: od2.steps[0].id, qty_pass: 50, qty_fail: 0, conclusion: 'pass', defects: [], remark: '全检合格' });
  assert(r.ok && r.data.conclusion === 'pass', '合格放行成功');
  assert(r.data.autoFinishIn && Number(r.data.autoFinishIn.qty) === 50, '末道放行自动成品入库 50 件');
  const od2after = (await call('GET', '/orders/' + qoid2)).data;
  assert(od2after.status === 'done', '工单已完工');
  assert(String(od2after.steps[0].inspect_status) === 'passed', '末道已放行');

  console.log('\n--- 9) 通知中心红点 ---');
  await loginAs('admin');
  r = await call('GET', '/notifications/unread_count');
  const before = r.data.count;
  assert(typeof before === 'number', '未读数可读：' + before);
  r = await call('GET', '/notifications');
  assert(r.ok && Array.isArray(r.data), '通知列表可读 ' + r.data.length + ' 条');
  r = await call('POST', '/notifications/read', {});
  assert(r.ok, '全部标为已读成功');
  r = await call('GET', '/notifications/unread_count');
  assert(r.data.count === 0, '已读后未读数归零');

  console.log('\n--- 10) 质量统计 ---');
  const st = (await call('GET', '/stats/quality')).data;
  assert(typeof st.total_closed === 'number' && st.total_closed >= 1, '闭环数 ' + st.total_closed);
  assert(Array.isArray(st.pareto) && st.pareto.length >= 1, '不良帕累托含数据：' + st.pareto.map((x) => x.name + '×' + x.qty).join('、'));
  assert(Array.isArray(st.by_process) && st.by_process.length >= 1, '工序不良率含数据 ' + st.by_process.length + ' 行');
  assert(!r.ok || typeof st.avg_claim_minutes === 'number' || st.avg_claim_minutes === null, '平均响应时长可用：' + st.avg_claim_minutes);

  console.log('\n--- 11) 检验设置读写 ---');
  r = await call('POST', '/quality/settings', { remind_minutes: 15, escalate_minutes: 120, webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test' });
  assert(r.ok, '保存设置成功');
  const cfg = (await call('GET', '/quality/settings')).data;
  assert(cfg.remind_minutes === 15 && cfg.escalate_minutes === 120, '设置读回一致');
  assert(/webhook/.test(cfg.webhook_url), 'webhook 已保存');

  console.log('\n--- 12) 免登录质检台（扫码即判） ---');
  const pub = (await call('GET', '/public/inspector/' + qc.id)).data;
  assert(pub && pub.worker && pub.worker.name === qc.name, '免登录返回质检员信息');
  assert(Array.isArray(pub.steps) && Array.isArray(pub.badReasons), '免登录返回待检队列与不良原因字典');

  console.log('\n--- 13) 非检验点工序不受影响 ---');
  await call('POST', '/processes', { code: 'QT-OP3', name: '包装QT' });
  const qop3 = (await call('GET', '/processes')).data.find((x) => x.code === 'QT-OP3');
  r = await call('POST', '/routes', { code: 'QT-RT3', name: 'QT路线3', product_id: qp.id, steps: [{ seq: 10, process_id: qop3.id, work_center_id: qwc.id }] });
  r = await call('POST', '/orders', { product_id: qp.id, route_id: r.data.id, qty_plan: 10, priority: 1, plan_end: '2099-01-01' });
  const qoid3 = r.data.id;
  await call('PUT', '/orders/' + qoid3, { status: 'released', product_id: qp.id, route_id: (await call('GET', '/orders/' + qoid3)).data.route_id, qty_plan: 10, priority: 1 });
  const od3 = (await call('GET', '/orders/' + qoid3)).data;
  await call('POST', '/reports', { order_id: qoid3, worker_id: wid, work_min: 0, steps: [{ order_step_id: od3.steps[0].id, qty_good: 10, qty_bad: 0 }] });
  const od3after = (await call('GET', '/orders/' + qoid3)).data;
  assert(od3after.steps[0].status === 'done', '无检验点工序报工即完工（原流程不受影响）');
  assert(!String(od3after.steps[0].inspect_status || ''), '无检验点不产生待检标记');

  console.log('\n================================');
  console.log(`通过 ${pass} / 失败 ${bad}`);
  console.log('================================');
  if (bad) process.exitCode = 1;
})().catch((e) => { console.error('测试异常：', e && e.stack || e); process.exitCode = 1; });
