/* 一期检验模式 · 端到端闭环冒烟（真实 HTTP，模拟操作员-质检员-管理员三方协作）
   1) 创建带检验点的工单并下发
   2) 首道工序报工 → 落「待检」
   3) 质检员判定不合格 → 自动开异常单（定级/定责）+ 必要时暂停工单
   4) 管理员认领 → 提交处理 → 验证关闭 → 工单恢复
   5) 逐序报工并放行 → 末道合格放行自动成品入库
   6) 通知红点、质量统计可读
*/
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
process.env.DATA_DIR = tmp; process.env.PORT = '0';
const server = require('./server.js');
const D = require('./lib/db');

let PORT = 0, pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };
const j = async (m, p, b, t) => {
  const r = await fetch('http://localhost:' + PORT + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

(async () => {
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
  PORT = server.address().port;

  const admin = await j('POST', '/api/login', { username: 'admin', password: '123456' });
  const AT = admin.json.data.token;
  const qc = await j('POST', '/api/login', { username: 'qc01', password: '123456' });
  const QT = qc.json.data.token;
  ok(qc.status === 200 && qc.json.data.user.role === 'inspector', '质检员 qc01 登录成功');

  // 1) 找到一条含检验点的工艺路线，创建工单并下发
  const prod = D.get("SELECT id,name FROM products LIMIT 1");
  const route = D.get("SELECT id,name FROM routes WHERE id=(SELECT route_id FROM route_steps WHERE IFNULL(inspect_type,'')<>'' LIMIT 1)");
  ok(!!route, '存在含检验点的工艺路线：' + (route && route.name));

  const mk = await j('POST', '/api/orders', { product_id: prod.id, route_id: route.id, qty_plan: 50 }, AT);
  const oid = mk.json.data.id;
  ok(!!oid, '创建工单成功 id=' + oid);
  await j('POST', '/api/orders/' + oid + '/release', {}, AT);

  const steps = (await j('GET', '/api/orders/' + oid, null, AT)).json.data.steps;
  const inspStep = steps.find((s) => s.inspect_type);
  const normalStep = steps.find((s) => !s.inspect_type && s.seq > inspStep.seq);
  ok(!!inspStep && !!normalStep, '工单含检验点工序与非检验点工序');

  // 2) 报工检验点工序 → 应落待检
  const w = D.get("SELECT id,name FROM users WHERE role='worker' LIMIT 1");
  const rep = await j('POST', '/api/reports', { order_id: oid, order_step_id: inspStep.id, worker_id: w.id, qty_good: 40, qty_bad: 10, report_time: new Date().toISOString().slice(0, 16) }, AT);
  ok(rep.status === 200, '检验点工序报工成功');
  const after = D.get('SELECT * FROM order_steps WHERE id=?', [inspStep.id]);
  ok(after.inspect_status === 'waiting', '报工后工序进入待检 (inspect_status=waiting)');
  ok(after.status !== 'done', '工序未直接完成，等待质检判定');

  // 3) 待检队列可见
  const pend = await j('GET', '/api/inspections/pending', null, AT);
  const inQueue = (pend.json.data || []).some((x) => x.order_step_id === inspStep.id);
  ok(inQueue, '待检队列包含该工序');

  // 4) 质检员判定不合格（40 合格 / 10 不良 → 占比 20% → critical）
  const bad = D.get('SELECT id,name FROM bad_reasons LIMIT 1');
  const insp = await j('POST', '/api/inspections', {
    order_step_id: inspStep.id, qty_pass: 40, qty_fail: 10,
    conclusion: 'fail', remark: '端到端冒烟',
    defects: [{ bad_reason_id: bad.id, qty: 10 }],
  }, QT);
  ok(insp.status === 200, '质检员提交不合格判定成功');
  const issue = insp.json.data && insp.json.data.issue;
  ok(!!issue && !!issue.code, '自动生成异常单：' + (issue && issue.code));
  ok(issue && issue.level === 'critical', '不良占比 20% → 定级 critical');

  const issueId = issue.id;
  const ord2 = D.get('SELECT status FROM orders WHERE id=?', [oid]);
  ok(ord2.status === 'paused', 'critical 异常自动暂停工单');

  // 5) 异常单定责 + 通知
  const iss = (await j('GET', '/api/quality_issues/' + issueId, null, AT)).json.data;
  ok(!!iss.assignee_user_id, '异常单已定责（责任人 ' + iss.assignee_name + '）');
  const n = await j('GET', '/api/notifications/unread_count', null, AT);
  ok(n.json.data.count > 0, '产生站内未读通知 ' + n.json.data.count + ' 条');

  // 6) 认领 → 处理 → 验证关闭
  ok((await j('POST', '/api/quality_issues/' + issueId + '/claim', {}, AT)).status === 200, '认领异常单成功');
  ok((await j('POST', '/api/quality_issues/' + issueId + '/handle', { disposition: 'rework', remark: '返工并复检' }, AT)).status === 200, '提交处理结果成功');
  ok((await j('POST', '/api/quality_issues/' + issueId + '/close', { remark: '复检合格' }, AT)).status === 200, '验证关闭异常单成功');

  const ord3 = D.get('SELECT status FROM orders WHERE id=?', [oid]);
  ok(ord3.status === 'running', '异常闭环后工单自动恢复 running');
  const st3 = D.get('SELECT inspect_status FROM order_steps WHERE id=?', [inspStep.id]);
  ok(st3.inspect_status === 'passed', '该工序已放行 passed');

  // 7) 后续工序报工（非检验点）→ 应直接完成
  const rep2 = await j('POST', '/api/reports', { order_id: oid, order_step_id: normalStep.id, worker_id: w.id, qty_good: 50, qty_bad: 0, report_time: new Date().toISOString().slice(0, 16) }, AT);
  ok(rep2.status === 200, '非检验点工序报工成功');
  const nt = D.get('SELECT status, inspect_status FROM order_steps WHERE id=?', [normalStep.id]);
  ok(nt.status === 'done', '非检验点工序报工即完成（原流程不受影响）');
  ok(!nt.inspect_status, '非检验点工序无待检标记');

  // 8) 质量统计
  const q = (await j('GET', '/api/stats/quality', null, AT)).json.data;
  ok(typeof q === 'object' && q !== null, '质量统计接口可读');
  ok(Number(q.total_closed) >= 1, '统计含已闭环数 ' + q.total_closed);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
