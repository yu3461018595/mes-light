/* 派工（按班组）相关集成测试：
   1) 未指派班组的工序 → 全员可报（出现在任意员工的「我的在制工单」，扫码可访问）
   2) 已指派班组 → 仅该班组员工可见/可访问，其他班组员工拒绝
   3) 接口返回 assignee_team，未指派时为空（前端显示「暂无」）
   4) 管理员/技术员可越权访问

   说明：2026-09-09 起原「责任人（单人）」口径改为「按班组派工」，
   工序所属班组存于 order_steps.assignee_team，对应 users.team。 */

const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-'));
process.env.DATA_DIR = tmp; process.env.PORT = '0';
const server = require('./server.js');
const D = require('./lib/db');

let PORT = 0;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };
const jpost = async (p, b, t) => { const r = await fetch('http://localhost:' + PORT + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const jget = async (p, t) => { const r = await fetch('http://localhost:' + PORT + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

(async () => {
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
  PORT = server.address().port;
  const login = await jpost('/api/login', { username: 'admin', password: '123456' });
  const token = login.json.data.token;

  const users = D.all("SELECT id,name,team FROM users WHERE role='worker'");
  ok(users.length >= 2, '存在至少 2 名操作工用于测试');

  // 准备两个不同的班组，分别放一名员工
  const TEAM_A = '__TEST_TEAM_A__', TEAM_B = '__TEST_TEAM_B__';
  D.run('UPDATE users SET team=? WHERE id=?', [TEAM_A, users[0].id]);
  D.run('UPDATE users SET team=? WHERE id=?', [TEAM_B, users[1].id]);
  const wA = users[0].id, wB = users[1].id;

  // 两张测试工单：OPEN=全部未指派班组；ASG=全部工序指派给班组 TEAM_A
  const open = await jpost('/api/orders', { product_id: 1, route_id: 1, qty_plan: 100 }, token);
  const asg = await jpost('/api/orders', { product_id: 1, route_id: 1, qty_plan: 100 }, token);
  const openId = open.json.data.id, asgId = asg.json.data.id;
  ok(openId && asgId, '两张测试工单创建成功');

  const st = D.all('SELECT id FROM order_steps WHERE order_id=? ORDER BY seq', [asgId]);
  D.run('UPDATE order_steps SET assignee_team=? WHERE order_id=?', [TEAM_A, asgId]);
  D.run("UPDATE orders SET status='released' WHERE id IN (?,?)", [openId, asgId]);

  const qrA = await jget('/api/qr/worker/' + wA, token); const wtA = qrA.json.data.token;
  const qrB = await jget('/api/qr/worker/' + wB, token); const wtB = qrB.json.data.token;
  ok(!!wtA && !!wtB, '获取员工A/B扫码令牌成功');

  // 1) 可见性：员工A（TEAM_A）应看到 OPEN 与 ASG；员工B（TEAM_B）只看到 OPEN
  const myIdsOf = async (wid, wt) => {
    const r = await jget('/api/public/worker/' + wid + '?t=' + wt, token);
    return (r.json.data && r.json.data.orders ? r.json.data.orders : []).map((o) => o.id);
  };
  const idsA = await myIdsOf(wA, wtA);
  ok(idsA.includes(openId), '未指派班组的工单出现在员工A的在制列表（全员可报）');
  ok(idsA.includes(asgId), '指派给本班组的工单出现在员工A的在制列表');
  const idsB = await myIdsOf(wB, wtB);
  ok(idsB.includes(openId), '未指派班组的工单也出现在员工B的在制列表');
  ok(!idsB.includes(asgId), '指派给他班组的工单不出现在员工B列表');

  // 2) 扫码访问
  const openAccess = await jget('/api/public/order/' + openId + '?t=' + wtA + '&wid=' + wA, token);
  ok(openAccess.status === 200, '未指派班组的工单：任意员工扫码可访问');
  const asgAccessA = await jget('/api/public/order/' + asgId + '?t=' + wtA + '&wid=' + wA, token);
  ok(asgAccessA.status === 200, '已指派班组：本班组员工可访问');
  const asgAccessB = await jget('/api/public/order/' + asgId + '?t=' + wtB + '&wid=' + wB, token);
  ok(asgAccessB.status === 403, '已指派班组：他班组员工访问被拒绝');

  // 3) 字段透出：移动端接口
  const detail = asgAccessA.json.data;
  const s1 = detail.steps.find((s) => s.id === st[0].id);
  ok(s1 && s1.assignee_team === TEAM_A, '已指派工序返回班组：' + (s1 && s1.assignee_team));
  ok(detail.steps.every((s) => 'assignee_team' in s), '移动端工序列表均含 assignee_team 字段');
  const openDetail = openAccess.json.data;
  ok(openDetail.steps[0].assignee_team == null || openDetail.steps[0].assignee_team === '', '未指派工序 assignee_team 为空（前端显示「暂无」）');

  // 4) 订单详情（PC）班组字段
  const orderDetail = await jget('/api/orders/' + asgId, token);
  const od1 = orderDetail.json.data.steps.find((s) => s.id === st[0].id);
  ok(od1 && od1.assignee_team === TEAM_A, 'PC 工单详情返回指派班组');

  // 5) 管理兜底：admin 可访问任意工单
  const adminAccess = await jget('/api/orders/' + asgId, token);
  ok(adminAccess.status === 200, '管理员可访问任意工单（管理兜底）');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
