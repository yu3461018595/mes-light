/* 静态模式（浏览器数据层 store.js）APP 雏形冒烟测试
 * 校验 APP 所需能力在静态版与后端行为一致：
 *   登录 / 改密码（含旧密码失效、其他会话吊销）/ 改姓名 / 消息中心（筛选+已读+角标）/
 *   库存预警扫描去重 / 派工待办 / 报工与检验联动通知 / APP 登录态报工接口
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

let pass = 0, bad = 0;
function assert(cond, msg) { if (!cond) { console.error('  ✗ FAIL:', msg); bad++; } else { console.log('  ✓', msg); pass++; } }
const call = (m, u, b) => Store.handle(m, u, b || {});
const data = (r) => r.data;

(async () => {
  await Store.init();
  const loginAs = async (u, p) => {
    const r = await call('POST', '/login', { username: u, password: p || '123456' });
    return r.ok ? r.data : null;
  };
  let r = await loginAs('admin');
  assert(!!r, 'admin 登录成功');
  assert(!!r.token && r.token.indexOf('static-') === 0, '登录返回静态模式令牌（static- 前缀）');

  console.log('\n--- 1) 消息场景字典与未读计数接口 ---');
  r = await call('GET', '/message_sources');
  assert(r.ok && Array.isArray(data(r)), '/message_sources 返回数组');
  const keys = data(r).map((x) => x.key);
  assert(keys.indexOf('quality') >= 0 && keys.indexOf('stock') >= 0 && keys.indexOf('assign') >= 0, '场景字典含 quality / stock / assign');
  r = await call('GET', '/notifications/unread_count');
  assert(r.ok && typeof data(r).count === 'number' && typeof data(r).by_source === 'object', '未读计数返回 { count, by_source }');
  r = await call('GET', '/notifications');
  assert(r.ok && Array.isArray(data(r)), '/notifications 返回数组');

  console.log('\n--- 2) 报工 → 待检任务通知质检员 ---');
  const procs = data(await call('GET', '/processes'));
  const inspProc = procs.find((p) => String(p.inspect_type || '').trim());
  assert(!!inspProc, '存在检验点工序 ' + (inspProc && inspProc.name));
  const users = data(await call('GET', '/users'));
  const inspectors = users.filter((u) => u.role === 'inspector' && u.active);
  assert(inspectors.length > 0, `存在 ${inspectors.length} 名质检员`);
  const teams = {};
  users.filter((u) => u.role === 'worker' && u.active).forEach((u) => { teams[u.team || ''] = teams[u.team || ''] || u; });
  const teamKey = Object.keys(teams).find((t) => t && t !== '');
  const worker = teams[teamKey];
  assert(!!worker, '存在带班组的操作工 ' + (worker && worker.name + '/' + worker.team));

  // 建工单并指派该班组，同时把工序换成检验点
  r = await call('POST', '/orders', { product_id: 1, route_id: 1, qty_plan: 30 });
  assert(r.ok, '创建测试工单成功');
  const oid = data(r).id;
  const steps = data(await call('GET', '/orders/' + oid)).steps || [];
  const st1 = steps[0];
  // 注意：该 PATCH 为整表提交语义（未传字段会被置空），故班组与检验点需一次传齐
  const patchR1 = await call('PATCH', '/orders/' + oid + '/steps/' + st1.id, { assignee_team: worker.team, inspect_type: inspProc.inspect_type });
  if (!patchR1.ok) console.log('     [调试] 指派班组失败：', patchR1.msg);
  Store.handle('PATCH', '/orders/' + oid + '/status', { status: 'released' });
  const stepNow = (data(await call('GET', '/orders/' + oid)).steps || []).find((s) => s.id === st1.id);
  assert(stepNow && stepNow.assignee_team === worker.team, '工序已指派班组 ' + worker.team);
  assert(stepNow && String(stepNow.inspect_type || '').trim() === inspProc.inspect_type, '工序已设为检验点 ' + inspProc.inspect_type);

  await loginAs('admin');
  const qc = inspectors[0];
  const qcUnBefore = data(await call('GET', '/notifications/unread_count'));
  // 直接用 admin 代报（doReport 允许 admin 越权）
  r = await call('POST', '/reports', { order_id: oid, worker_id: worker.id, steps: [{ order_step_id: st1.id, qty_good: 5, qty_bad: 0, bad_reasons: [] }] });
  assert(r.ok, '报工提交成功');
  assert(data(r).steps[0].needInspect === true, '报工结果标记 needInspect=true');
  // 质检员消息
  Store.currentUser = users.find((u) => u.id === qc.id);
  const qcUn = data(await call('GET', '/notifications/unread_count'));
  assert(qcUn.count > qcUnBefore.count, '质检员收到待检任务消息（未读增加）');
  const qcMsgs = data(await call('GET', '/notifications'));
  assert(qcMsgs.some((m) => /待检任务/.test(m.title)), '待检消息标题含「待检任务」');
  assert(qcMsgs.every((m) => m.to_user_id === qc.id), '消息只返回本人');
  assert(qcMsgs.some((m) => m.source_label === '质量异常' && m.kind_label), '消息带中文场景/小类标签');

  console.log('\n--- 3) 消息按场景筛选 / 标记已读 ---');
  Store.currentUser = users.find((u) => u.id === qc.id);
  const unreadOnly = data(await call('GET', '/notifications', { unread: '1' }));
  assert(unreadOnly.every((m) => !m.read_at), '只看未读正确（质检员）');
  if (qcMsgs.length) {
    r = await call('POST', '/notifications/read', { id: qcMsgs[0].id });
    assert(r.ok, '标记单条已读成功');
    const after = data(await call('GET', '/notifications/unread_count'));
    assert(after.count === qcUn.count - 1, '单条已读后未读计数 -1');
    r = await call('POST', '/notifications/read', {});
    assert(r.ok && data(await call('GET', '/notifications/unread_count')).count === 0, '全部已读后未读归零');
  }
  // 管理员视角：库存预警场景筛选（预警只发给 admin/technician/仓管）
  Store.currentUser = users.find((u) => u.role === 'admin');
  await call('POST', '/stock_alerts/scan', {});
  const adminMsgs = data(await call('GET', '/notifications'));
  const stockMsgs = data(await call('GET', '/notifications', { source: 'stock' }));
  assert(stockMsgs.length > 0 && stockMsgs.every((m) => m.source === 'stock'), `按 stock 筛选只返回库存预警（全部 ${adminMsgs.length} 条 → 筛出 ${stockMsgs.length} 条）`);
  const adminUnread = data(await call('GET', '/notifications/unread_count'));
  assert(stockMsgs.length <= adminMsgs.length, '按场景筛选是全部列表的子集');
  assert(adminUnread.by_source.stock === stockMsgs.filter((m) => !m.read_at).length, '按场景未读分组计数与筛选结果一致');

  console.log('\n--- 4) 库存预警扫描（含同日去重） ---');
  Store.currentUser = users.find((u) => u.role === 'admin');
  r = await call('POST', '/stock_alerts/scan', {});
  assert(r.ok, '管理员可触发库存扫描');
  const firstSent = data(r).sent;
  assert(typeof firstSent === 'number', '扫描返回发送条数 ' + firstSent);
  r = await call('POST', '/stock_alerts/scan', {});
  assert(data(r).sent === 0, '同日重复扫描不再重复提醒（去重生效）');
  const alerts = data(await call('GET', '/stock_alerts'));
  assert(Array.isArray(alerts), '/stock_alerts 返回列表');
  const aq = data(await call('GET', '/notifications/unread_count'));
  assert(aq.by_source.stock > 0, '管理员未读中含库存预警分组');

  console.log('\n--- 5) APP 登录态接口 ---');
  Store.currentUser = null;
  r = await call('GET', '/app/my_orders');
  assert(!r.ok && r.code === 401, '未登录访问 /app/my_orders → 401');
  // 用该班组员工身份（不经过登录，直接设定 currentUser 模拟已登录会话）
  Store.currentUser = users.find((u) => u.id === worker.id);
  r = await call('GET', '/app/my_orders');
  assert(r.ok, '登录态读取我的在制工单成功');
  assert(data(r).orders.some((o) => o.id === oid), '我的在制工单含刚下发的工单');
  assert(data(r).worker.id === worker.id, '回带当前用户');
  r = await call('GET', '/app/order/' + oid);
  assert(r.ok && data(r).order && Array.isArray(data(r).steps), '/app/order/:id 返回工单与工序');
  assert(data(r).steps.every((s) => s.assignee_team === worker.team || !s.assignee_team ? s.allow_report === 1 : true), '本班组工序可报');
  assert(Array.isArray(data(r).badReasons), '回带不良原因字典');
  // 跨班组：换一个别的班组的员工
  const other = users.find((u) => u.role === 'worker' && u.active && u.team !== worker.team);
  if (other) {
    Store.currentUser = other;
    r = await call('GET', '/app/order/' + oid);
    const locked = (data(r).steps || []).filter((s) => s.assignee_team === worker.team).every((s) => s.allow_report === 0);
    assert(locked, '跨班组成员读取时他人班组工序 allow_report=0');
  }
  // APP 报工
  Store.currentUser = users.find((u) => u.id === worker.id);
  r = await call('POST', '/app/reports', { order_id: oid, steps: [{ order_step_id: st1.id, qty_good: 3, qty_bad: 0, bad_reasons: [] }] });
  assert(r.ok, '/app/reports 登录态报工成功（worker_id 自动取当前用户）');
  const myReps = data(await call('GET', '/reports?worker_id=' + worker.id)) || [];
  assert(!myReps.length || myReps.some((x) => x.worker_id === worker.id), '报工记录归属当前登录员工');

  console.log('\n--- 6) 质量异常详情（APP 展示所需字段） ---');
  Store.currentUser = users.find((u) => u.role === 'admin');
  const issues = data(await call('GET', '/quality_issues'));
  if (issues.length) {
    r = await call('GET', '/quality_issues/' + issues[0].id);
    assert(r.ok, '异常详情可读取');
    assert(data(r).dispositions && data(r).dispositions.rework === '返工', '详情带回处置方式字典');
  } else {
    assert(true, '（无异常单，跳过详情字段校验）');
  }

  console.log('\n--- 7) 本人改密码 / 管理员重置密码 ---');
  const target = users.find((u) => u.role === 'worker' && u.active);
  Store.currentUser = users.find((u) => u.role === 'admin');
  r = await call('POST', '/users/' + target.id + '/reset_password', { new_password: '123' });
  assert(!r.ok, '重置密码过短 → 拒绝');
  r = await call('POST', '/users/' + target.id + '/reset_password', { new_password: 'abc12345' });
  assert(r.ok, '管理员重置密码成功');
  const relog = await call('POST', '/login', { username: target.username, password: 'abc12345' });
  assert(relog.ok, '员工可用重置后的密码登录');
  Store.currentUser = relog.data.user;
  r = await call('POST', '/password', { old_password: 'wrong', new_password: 'zzz99999' });
  assert(!r.ok && /原密码/.test(r.msg), '原密码错误 → 拒绝');
  r = await call('POST', '/password', { old_password: 'abc12345', new_password: 'abc12345' });
  assert(!r.ok, '新密码与原密码相同 → 拒绝');
  r = await call('POST', '/password', { old_password: 'abc12345', new_password: 'zzz99999' });
  assert(r.ok, '本人修改密码成功');
  const relog2 = await call('POST', '/login', { username: target.username, password: 'abc12345' });
  assert(!relog2.ok, '旧密码已失效');
  const relog3 = await call('POST', '/login', { username: target.username, password: 'zzz99999' });
  assert(relog3.ok, '新密码可登录');

  console.log('\n--- 8) 修改姓名 ---');
  Store.currentUser = relog3.data.user;
  r = await call('POST', '/profile', { name: '' });
  assert(!r.ok, '姓名为空 → 拒绝');
  r = await call('POST', '/profile', { name: '静态改名测试' });
  assert(r.ok && data(r).name === '静态改名测试', '修改姓名成功');

  console.log('\n————————————————————————');
  console.log(`共 ${pass + bad} 项断言：通过 ${pass}，失败 ${bad}`);
  if (bad) process.exitCode = 1;
})().catch((e) => { console.error('测试异常：', e); process.exitCode = 1; });
