/* APP 雏形（移动端登录 + 消息中心）集成测试
 * 覆盖：
 *   1) 密码：本人改密码（校验原密码、长度、与原密码相同）、改后旧密码失效、其他会话被吊销、当前会话保留
 *   2) 管理员重置他人密码（含吊销其会话）
 *   3) 资料：修改姓名
 *   4) 消息中心：按场景筛选、未读计数与分组、单条/按场景/全部已读、来源字典
 *   5) 库存预警：扫描去重（同物料同日只提醒一次）、仅 admin/technician 可扫描
 *   6) 派工待办：工单下发 → 该班组成员收到 assign 消息
 *   7) 报工联动：报工出现不良 → 技术员/管理员收到质量提醒；报工落入待检 → 质检员收到待检任务
 *   8) 检验联动：不合格 → 责任班组收到结果消息；异常单处理 → 上报人抄送；闭环 → 上报人收到
 *   9) APP 登录态接口：/api/app/my_orders、/api/app/order/:id（班组外工序不可报）、/api/app/reports
 *  10) 鉴权：未带令牌访问消息中心/我的工单 → 401；普通员工无权扫描库存预警 → 403
 */
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
process.env.DATA_DIR = tmp; process.env.PORT = '0';
const server = require('./server.js');
const D = require('./lib/db');

let PORT = 0;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };
const jreq = async (method, p, b, t) => {
  const r = await fetch('http://localhost:' + PORT + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const jget = (p, t) => jreq('GET', p, undefined, t);
const jpost = (p, b, t) => jreq('POST', p, b, t);
const okData = (r) => r.json && r.json.data;
// 消息查询助手
const msgsOf = async (t, q) => (await jget('/api/notifications' + (q || ''), t)).json.data || [];
const unreadOf = async (t) => okData(await jget('/api/notifications/unread_count', t)) || { count: 0, by_source: {} };

(async () => {
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
  PORT = server.address().port;

  const login = async (u, p) => {
    const r = await jpost('/api/login', { username: u, password: p });
    return { token: okData(r) ? okData(r).token : null, user: okData(r) ? okData(r).user : null, status: r.status };
  };
  const admin = await login('admin', '123456');
  ok(!!admin.token, '管理员登录成功');
  const aTok = admin.token;

  console.log('\n【1】本人修改密码');
  // 造一个测试员工，改密码流程可反复验证
  const uname = 'app_test_' + Date.now();
  const makeUser = await jpost('/api/users', { username: uname, password: 'init1234', name: 'APP测试员', role: 'worker', team: 'APP测试组' }, aTok);
  const uid = okData(makeUser) ? okData(makeUser).id : (D.get('SELECT id FROM users WHERE username=?', [uname]) || {}).id;
  ok(!!uid, '创建测试员工成功');
  const u1 = await login(uname, 'init1234');
  ok(!!u1.token, '新员工可用初始密码登录');
  const u2 = await login(uname, 'init1234');       // 第二个会话，用于验证吊销
  ok(!!u2.token && u2.token !== u1.token, '同一账号第二个会话登录成功（用于验证吊销）');

  let r = await jpost('/api/password', { old_password: 'wrong-pwd', new_password: 'newpass123' }, u1.token);
  ok(r.status === 400 && /原密码/.test(r.json.msg), '原密码错误 → 400 拒绝');

  r = await jpost('/api/password', { old_password: 'init1234', new_password: '123' }, u1.token);
  ok(r.status !== 200 && /6 位/.test(r.json.msg), '新密码少于 6 位 → 拒绝');

  r = await jpost('/api/password', { old_password: 'init1234', new_password: 'init1234' }, u1.token);
  ok(r.status !== 200 && /不能与原密码相同/.test(r.json.msg), '新密码与原密码相同 → 拒绝');

  r = await jpost('/api/password', {}, u1.token);
  ok(r.status !== 200, '缺少参数 → 拒绝');

  r = await jpost('/api/password', { old_password: 'init1234', new_password: 'newpass123' }, u1.token);
  ok(r.status === 200, '正确修改密码成功');

  ok((await login(uname, 'init1234')).status === 401, '旧密码已失效，无法再登录');
  ok((await login(uname, 'newpass123')).status === 200, '新密码可正常登录');
  ok((await jget('/api/me', u1.token)).status === 200, '修改密码的当前会话保持登录');
  ok((await jget('/api/me', u2.token)).status === 401, '同账号其他会话已被吊销');

  console.log('\n【2】管理员重置密码');
  r = await jpost('/api/users/' + uid + '/reset_password', { new_password: '123' }, aTok);
  ok(r.status !== 200, '重置密码过短 → 拒绝');
  r = await jpost('/api/users/' + uid + '/reset_password', { new_password: 'reset1234' }, aTok);
  ok(r.status === 200, '管理员重置密码成功');
  ok((await login(uname, 'reset1234')).status === 200, '员工可用重置后的密码登录');
  const u3 = await login(uname, 'reset1234');
  // 重置后该员工的旧会话应全部失效
  ok((await jget('/api/me', u1.token)).status === 401, '重置密码后该员工旧会话失效');

  console.log('\n【3】修改资料');
  r = await jpost('/api/profile', { name: '' }, u3.token);
  ok(r.status !== 200, '姓名为空 → 拒绝');
  r = await jpost('/api/profile', { name: 'APP测试员改名' }, u3.token);
  ok(r.status === 200 && okData(r).name === 'APP测试员改名', '修改姓名成功并回带新资料');

  console.log('\n【4】消息中心');
  const src = await jget('/api/message_sources', aTok);
  ok(Array.isArray(okData(src)) && okData(src).some((x) => x.key === 'quality'), '消息场景字典含 quality');
  ok(okData(src).some((x) => x.key === 'stock') && okData(src).some((x) => x.key === 'assign'), '消息场景字典含 stock / assign');
  // 未登录访问消息中心：接口按设计返回空列表（前端未登录时不请求），但 /api/me 必须 401
  ok((await jget('/api/me')).status === 401, '未登录访问 /api/me → 401');
  ok(((await jget('/api/notifications')).json.data || []).length === 0, '未登录访问消息列表不泄露他人消息（返回空）');

  // 给测试员工塞 3 条不同场景消息
  D.run(`INSERT INTO issue_notifications(issue_id,to_user_id,to_name,channel,kind,title,body,source,ref_type,ref_id,link,read_at,sent_at,ok)
         VALUES(NULL,?,?,'inbox','created','测试质量','body1','quality','order',1,'#/quality',NULL,?,1)`, [uid, 'APP测试员改名', '2026-09-18 09:00:00']);
  D.run(`INSERT INTO issue_notifications(issue_id,to_user_id,to_name,channel,kind,title,body,source,ref_type,ref_id,link,read_at,sent_at,ok)
         VALUES(NULL,?,?,'inbox','created','测试库存','body2','stock',NULL,NULL,NULL,NULL,?,1)`, [uid, 'APP测试员改名', '2026-09-18 09:05:00']);
  D.run(`INSERT INTO issue_notifications(issue_id,to_user_id,to_name,channel,kind,title,body,source,ref_type,ref_id,link,read_at,sent_at,ok)
         VALUES(NULL,?,?,'inbox','created','测试派工','body3','assign','order',2,'#/orders',NULL,?,1)`, [uid, 'APP测试员改名', '2026-09-18 09:10:00']);

  let un = await unreadOf(u3.token);
  ok(un.count === 3, '未读计数正确（3 条）');
  ok(un.by_source.quality === 1 && un.by_source.stock === 1 && un.by_source.assign === 1, '未读按场景分组计数正确');
  let list = await msgsOf(u3.token);
  ok(list.length === 3, '消息列表返回 3 条');
  ok(list[0].source_label === '派工待办' && list[0].kind_label === '新消息', '消息带回中文场景/小类标签');
  ok(list.every((m) => m.to_user_id === uid), '消息列表只返回本人的消息');
  list = await msgsOf(u3.token, '?source=stock');
  ok(list.length === 1 && list[0].source === 'stock', '按场景筛选（stock）正确');
  list = await msgsOf(u3.token, '?unread=1');
  ok(list.length === 3, '只看未读正确');

  r = await jpost('/api/notifications/read', { id: list[0].id }, u3.token);
  ok(r.status === 200, '标记单条已读成功');
  un = await unreadOf(u3.token);
  ok(un.count === 2, '单条已读后未读计数变 2');
  await jpost('/api/notifications/read', { source: 'stock' }, u3.token);
  un = await unreadOf(u3.token);
  ok(un.count === 1 && !un.by_source.stock, '按场景已读后该场景未读清零');
  // 不能改别人的消息
  await jpost('/api/notifications/read', { id: (D.get('SELECT id FROM issue_notifications WHERE to_user_id=? AND source=?', [uid, 'quality']) || {}).id }, aTok);
  un = await unreadOf(u3.token);
  ok(un.count === 1, '他人无法把别人的消息标为已读');
  await jpost('/api/notifications/read', {}, u3.token);
  ok((await unreadOf(u3.token)).count === 0, '全部已读后未读计数归零');

  console.log('\n【5】库存预警扫描');
  const workersTok = (await login(uname, 'reset1234')).token;
  ok((await jget('/api/stock_alerts', workersTok)).status === 403, '普通员工访问库存预警 → 403');
  ok((await jget('/api/stock_alerts/scan', workersTok)).status === 404 || (await jpost('/api/stock_alerts/scan', {}, workersTok)).status === 403, '普通员工无权触发扫描 → 403');

  // 造一个必然缺料的物料
  const mcode = 'TST-' + Date.now();
  D.run("INSERT INTO materials(code,name,unit,category,safe_min,safe_max,active,created_at) VALUES(?,?,?,?,?,?,1,?)",
    [mcode, '测试缺料物料', '个', 'raw', 100, 0, '2026-09-18 09:00:00']);
  const mid = D.get('SELECT id FROM materials WHERE code=?', [mcode]).id;
  let scan = await jpost('/api/stock_alerts/scan', {}, aTok);
  ok(scan.status === 200, '管理员触发库存扫描成功');
  ok(Number(okData(scan).sent) > 0, '扫描至少发送 1 条提醒');
  const alerts = okData(await jget('/api/stock_alerts', aTok)) || [];
  ok(alerts.some((x) => x.code === mcode && x.level === 'short'), '扫描结果含该缺料物料（level=short）');
  const adminUn = await unreadOf(aTok);
  ok((adminUn.by_source.stock || 0) >= 1, '管理员收到库存预警未读消息');
  scan = await jpost('/api/stock_alerts/scan', {}, aTok);
  ok(Number(okData(scan).sent) === 0, '同日重复扫描不重复提醒（去重生效）');

  // 积压（高于上限）也应识别
  D.run("INSERT INTO materials(code,name,unit,category,safe_min,safe_max,active,created_at) VALUES(?,?,?,?,?,?,1,?)",
    ['OVR-' + Date.now(), '测试积压物料', '个', 'raw', 0, 5, '2026-09-18 09:00:00']);
  const oid = D.get("SELECT id FROM materials WHERE code LIKE 'OVR-%' ORDER BY id DESC LIMIT 1").id;
  D.run('INSERT INTO inventory(material_id,warehouse_id,batch,qty,updated_at) VALUES(?,1,?,?,?)', [oid, 'B1', 20, '2026-09-18 09:00:00']);
  const alerts2 = okData(await jget('/api/stock_alerts', aTok)) || [];
  ok(alerts2.some((x) => x.id === oid && x.level === 'over'), '高于安全上限识别为积压（level=over）');

  console.log('\n【6】派工待办消息');
  const TEAM = 'APP派工组' + Date.now();
  const mkWorker = async (nm, team) => {
    const name = 'w' + Date.now() + Math.floor(Math.random() * 1000);
    await jpost('/api/users', { username: name, password: 'pass1234', name: nm, role: 'worker', team }, aTok);
    const u = D.get('SELECT * FROM users WHERE username=?', [name]);
    return u;
  };
  const w1 = await mkWorker('派工甲', TEAM);
  const w2 = await mkWorker('派工乙', TEAM);
  const w3 = await mkWorker('他组丙', '别的组' + Date.now());
  const w1tok = (await login(w1.username, 'pass1234')).token;

  const ord = await jpost('/api/orders', { product_id: 1, route_id: 1, qty_plan: 50 }, aTok);
  const oid2 = okData(ord).id;
  ok(!!oid2, '创建测试工单成功');
  D.run('UPDATE order_steps SET assignee_team=? WHERE order_id=?', [TEAM, oid2]);
  r = await jreq('PATCH', '/api/orders/' + oid2 + '/status', { status: 'released' }, aTok);
  ok(r.status === 200, '下发工单成功');
  await new Promise((res) => setTimeout(res, 60));
  const m1 = await msgsOf(w1tok, '?source=assign');
  ok(m1.length >= 1, '下发后本班组成员收到派工待办消息');
  ok(m1.some((x) => /新任务/.test(x.title) && /待报工/.test(x.title)), '派工消息标题为「新任务…待报工」');
  const w3tok = (await login(w3.username, 'pass1234')).token;
  ok((await msgsOf(w3tok, '?source=assign')).length === 0, '其他班组员工不会收到该派工消息');

  console.log('\n【7】APP 登录态报工 / 待检通知');
  ok((await jget('/api/app/my_orders')).status === 401, '未登录访问我的工单 → 401');
  r = await jget('/api/app/my_orders', w1tok);
  const myOrders = okData(r).orders || [];
  ok(myOrders.some((o) => o.id === oid2), '本班组工单出现在我的在制工单');
  r = await jget('/api/app/order/' + oid2, w3tok);
  const o3 = okData(r);
  ok(!!o3 && Array.isArray(o3.steps), '跨班组成员仍可读取工单结构（但工序被锁定）');
  const stepsAllLocked = (o3.steps || []).filter((s) => s.assignee_team === TEAM).every((s) => Number(s.allow_report) === 0);
  ok(stepsAllLocked, '跨班组成员读取时，他人班组工序 allow_report=0（APP 中不可勾选）');

  // 给该工单配一个检验点，验证报工后质检员收到待检任务
  const qname = 'q' + Date.now();
  await jpost('/api/users', { username: qname, password: 'pass1234', name: 'APP质检员', role: 'inspector', team: '质检组' }, aTok);
  const qtok = (await login(qname, 'pass1234')).token;
  const inspBefore = (await unreadOf(qtok)).count;
  const st1 = D.get('SELECT id FROM order_steps WHERE order_id=? ORDER BY seq LIMIT 1', [oid2]);
  D.run("UPDATE order_steps SET inspect_type='ipqc' WHERE id=?", [st1.id]);

  r = await jpost('/api/app/reports', { order_id: oid2, steps: [{ order_step_id: st1.id, qty_good: 10, qty_bad: 2, bad_reasons: [{ bad_reason_id: (D.get('SELECT id FROM bad_reasons LIMIT 1') || {}).id, qty: 2 }] }] }, w1tok);
  ok(r.status === 200, 'APP 登录态提交报工成功');
  ok(!!okData(r).steps[0].needInspect, '报工结果标记该工序需检验（needInspect）');
  const qUn = await unreadOf(qtok);
  ok(qUn.count > inspBefore, '质检员收到待检任务消息');
  const qmsgs = await msgsOf(qtok);
  ok(qmsgs.some((m) => /待检任务/.test(m.title)), '待检消息标题为「待检任务…」');
  const badNotice = (await msgsOf(aTok)).some((m) => /报工不良提醒/.test(m.title));
  ok(badNotice, '报工出现不良 → 管理者收到质量提醒');

  console.log('\n【8】检验结果与异常单流转通知');
  r = await jget('/api/inspections/queue', qtok);
  ok(r.status === 200 && (okData(r).steps || []).some((s) => s.order_step_id === st1.id), '质检台队列返回该待检工序');
  const w1UnBefore = (await unreadOf(w1tok)).count;
  r = await jpost('/api/app/inspections', { order_step_id: st1.id, qty_pass: 8, qty_fail: 2, conclusion: 'fail', defects: [{ bad_reason_id: (D.get('SELECT id FROM bad_reasons LIMIT 1') || {}).id, qty: 2 }] }, qtok);
  ok(r.status === 200 && okData(r).issue, 'APP 质检台判定不合格 → 自动开质量异常单');
  const issue = okData(r).issue;
  ok((await unreadOf(w1tok)).count > w1UnBefore, '不合格结果通知到责任班组员工');

  const issueDetail = okData(await jget('/api/quality_issues/' + issue.id, aTok));
  ok(issueDetail && issueDetail.step && issueDetail.order, '异常详情回带工序与工单摘要（APP 展示用）');
  ok(issueDetail.dispositions && issueDetail.dispositions.rework === '返工', '异常详情带回处置方式字典');

  // 处理 → 上报人（质检员）抄送
  const qUnBefore2 = (await unreadOf(qtok)).count;
  r = await jpost('/api/quality_issues/' + issue.id + '/claim', {}, aTok);
  ok(r.status === 200, '认领异常单成功');
  r = await jpost('/api/quality_issues/' + issue.id + '/handle', { cause: '来料偏大', action: '返工并加严首检', disposition: 'rework' }, aTok);
  ok(r.status === 200, '提交处理结果成功');
  const qUn2 = await unreadOf(qtok);
  ok(qUn2.count > qUnBefore2, '处理结果抄送原上报人（质检员）');
  ok((await msgsOf(qtok)).some((m) => /处理中/.test(m.title)), '抄送消息标题为「质量异常处理中…」');

  const qUnBefore3 = (await unreadOf(qtok)).count;
  r = await jpost('/api/quality_issues/' + issue.id + '/close', { release: true }, aTok);
  ok(r.status === 200, '验证关闭异常单成功');
  ok((await unreadOf(qtok)).count > qUnBefore3, '闭环消息通知到上报人');
  ok((await msgsOf(qtok)).some((m) => /已闭环/.test(m.title)), '闭环消息标题为「质量异常已闭环…」');
  const stepAfter = D.get('SELECT inspect_status,status FROM order_steps WHERE id=?', [st1.id]);
  ok(stepAfter.inspect_status === 'passed', '闭环后工序检验状态置为 passed（恢复流转）');

  console.log('\n【9】检验合格路径通知');
  const ord2 = await jpost('/api/orders', { product_id: 1, route_id: 1, qty_plan: 20 }, aTok);
  const oid3 = okData(ord2).id;
  D.run('UPDATE order_steps SET assignee_team=? WHERE order_id=?', [TEAM, oid3]);
  D.run("UPDATE orders SET status='released' WHERE id=?", [oid3]);
  const st2 = D.get('SELECT id FROM order_steps WHERE order_id=? ORDER BY seq LIMIT 1', [oid3]);
  D.run("UPDATE order_steps SET inspect_type='iqc' WHERE id=?", [st2.id]);
  await jpost('/api/app/reports', { order_id: oid3, steps: [{ order_step_id: st2.id, qty_good: 5, qty_bad: 0, bad_reasons: [] }] }, w1tok);
  const w1Un2 = (await unreadOf(w1tok)).count;
  r = await jpost('/api/app/inspections', { order_step_id: st2.id, qty_pass: 5, qty_fail: 0, conclusion: 'pass', defects: [] }, qtok);
  ok(r.status === 200 && !okData(r).issue, '合格放行不产生异常单');
  ok((await unreadOf(w1tok)).count > w1Un2, '合格放行结果通知到责任班组');
  ok((await msgsOf(w1tok)).some((m) => /合格放行/.test(m.title)), '放行消息标题含「合格放行」');

  console.log('\n【10】权限与边界');
  ok((await jpost('/api/app/inspections', { order_step_id: st2.id, qty_pass: 1, qty_fail: 0, conclusion: 'pass' }, w1tok)).status === 403, '操作工无权提交检验判定 → 403');
  ok((await jget('/api/inspections/queue', w1tok)).status === 403, '操作工无权访问质检台队列 → 403');
  ok((await jpost('/api/password', { old_password: 'pass1234', new_password: 'pass1234' }, w1tok)).status !== 200, 'APP 改密码不能与原密码相同');
  const badLogin = await jpost('/api/login', { username: w1.username, password: 'x' });
  ok(badLogin.status === 401, '错误密码登录 → 401');

  console.log('\n————————————————————————');
  console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
  try { server.close(); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
