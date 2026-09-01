/* 冒烟测试：登录 → 建单 → 下发 → 报工 → 统计校验 */
const BASE = 'http://localhost:5173';
let token = '';
const log = (...a) => console.log(...a);

async function api(method, url, body) {
  const res = await fetch(BASE + '/api' + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json();
  if (!d.ok) throw new Error(`${method} ${url} → ${d.msg}`);
  return d.data;
}
const ok = (c, m) => log((c ? '  [通过] ' : '  [失败] ') + m);

(async () => {
  log('\n=== 1. 认证 ===');
  const r = await api('POST', '/login', { username: 'admin', password: '123456' });
  token = r.token;
  ok(!!token, '管理员登录成功：' + r.user.name);
  let bad = false;
  try { await api('POST', '/login', { username: 'admin', password: 'wrong' }); } catch (e) { bad = true; }
  ok(bad, '错误密码被拒绝');

  log('\n=== 2. 基础数据 ===');
  const meta = await api('GET', '/meta');
  ok(meta.products.length >= 8, `产品 ${meta.products.length} 个`);
  ok(meta.routes.length >= 8, `工艺路线 ${meta.routes.length} 条`);
  ok(meta.workCenters.length >= 7, `工作中心 ${meta.workCenters.length} 个`);

  log('\n=== 3. 创建工单 ===');
  const prod = meta.products[0];
  const route = meta.routes.find((x) => x.product_id === prod.id);
  const stepsBefore = await api('GET', '/routes/' + route.id + '/steps');
  const newOrder = await api('POST', '/orders', {
    product_id: prod.id, route_id: route.id, customer_id: meta.customers[0].id,
    qty_plan: 500, priority: 1, plan_start: '2026-09-01', plan_end: '2026-09-10', remark: '冒烟测试单',
  });
  ok(!!newOrder.code, '工单已创建：' + newOrder.code);
  const detail = await api('GET', '/orders/' + newOrder.id);
  ok(detail.steps.length === stepsBefore.length, `按工艺路线展开 ${detail.steps.length} 道工序`);
  ok(detail.status === 'created', '初始状态为「待下发」');

  log('\n=== 4. 状态流转 ===');
  await api('PATCH', `/orders/${newOrder.id}/status`, { status: 'released' });
  await api('PATCH', `/orders/${newOrder.id}/status`, { status: 'running' });
  let d2 = await api('GET', '/orders/' + newOrder.id);
  ok(d2.status === 'running', '已下发并开工');
  ok(d2.steps[0].status === 'running', '首道工序自动置为生产中');

  log('\n=== 5. 派工 ===');
  await api('PATCH', `/orders/${newOrder.id}/steps/${d2.steps[0].id}`, {
    assignee_id: meta.workers[0].id, work_center_id: meta.workCenters[0].id,
  });
  d2 = await api('GET', '/orders/' + newOrder.id);
  ok(d2.steps[0].assignee_name === meta.workers[0].name, '指派责任人：' + d2.steps[0].assignee_name);

  log('\n=== 6. 报工（含不良） ===');
  await api('POST', '/reports', {
    order_id: newOrder.id, order_step_id: d2.steps[0].id, worker_id: meta.workers[0].id,
    qty_good: 200, qty_bad: 5, bad_reason: '尺寸超差', work_min: 60, report_date: new Date().toISOString().slice(0, 10),
  });
  d2 = await api('GET', '/orders/' + newOrder.id);
  ok(d2.steps[0].qty_good === 200 && d2.steps[0].qty_bad === 5, '工序一累计：合格 200 / 不良 5');
  ok(d2.reports.length === 1, '报工流水已记录');

  await api('POST', '/reports', {
    order_id: newOrder.id, order_step_id: d2.steps[0].id, worker_id: meta.workers[0].id,
    qty_good: 300, qty_bad: 0, work_min: 90,
  });
  d2 = await api('GET', '/orders/' + newOrder.id);
  ok(d2.steps[0].status === 'done', '报满 500 件后工序自动完工');
  ok(d2.steps[1].status === 'running', '下一道工序自动启动');

  log('\n=== 7. 全部工序完工 → 工单自动完成 ===');
  for (let i = 1; i < d2.steps.length; i++) {
    await api('POST', '/reports', {
      order_id: newOrder.id, order_step_id: d2.steps[i].id, worker_id: meta.workers[1].id,
      qty_good: 500, qty_bad: 0, work_min: 30,
    });
  }
  d2 = await api('GET', '/orders/' + newOrder.id);
  ok(d2.status === 'done', '工单自动置为「已完成」');
  ok(d2.qty_done === 500, '完工数量 500（与计划一致）');

  log('\n=== 8. 撤销报工 ===');
  const first = d2.reports.find((x) => x.qty_good === 200 && x.qty_bad === 5);
  await api('DELETE', '/reports/' + first.id);
  const d3 = await api('GET', '/orders/' + newOrder.id);
  ok(d3.steps[0].qty_good === 300, `撤销「合格200/不良5」后工序一合格数回退为 ${d3.steps[0].qty_good}`);
  ok(d3.steps[0].status === 'running', '工序一自动回退为「生产中」（300 < 计划 500）');

  log('\n=== 9. 统计与看板 ===');
  const ov = await api('GET', '/stats/overview');
  ok(ov.today.good > 0, `今日产量 ${ov.today.good} 件 / 良率 ${ov.yield}% / 报工 ${ov.today.people} 人`);
  const trend = await api('GET', '/stats/trend?days=14');
  ok(trend.length > 0, `产量趋势 ${trend.length} 天`);
  const rank = await api('GET', '/stats/ranking?days=7');
  ok(rank.length > 0, `人员排行 ${rank.length} 人，榜首 ${rank[0].name} ${rank[0].good} 件`);
  const badR = await api('GET', '/stats/bad?days=14');
  ok(badR.length > 0, `不良原因 ${badR.length} 类`);

  log('\n=== 10. 权限与扫码 ===');
  const wt = token;
  const w = await api('POST', '/login', { username: 'worker1', password: '123456' });
  token = w.token;
  let denied = false;
  try { await api('POST', '/orders', { product_id: 1, route_id: 1, qty_plan: 1 }); } catch (e) { denied = /无权/.test(e.message); }
  ok(denied, '操作工无权创建工单（返回 403）');
  d2 = await api('GET', '/orders/' + newOrder.id);
  const scan = await api('GET', '/scan/' + d2.code);
  ok(scan.type === 'order' && scan.order.id === newOrder.id, '扫码定位工单成功：' + scan.order.code);
  token = wt;

  log('\n=== 11. 清理测试数据 ===');
  await api('DELETE', '/orders/' + newOrder.id);
  const logs = await api('GET', '/logs?limit=5');
  ok(logs.length > 0, '操作日志已记录：' + logs[0].action);

  log('\n全部冒烟用例执行完毕\n');
})().catch((e) => { console.error('\n[异常] ' + e.message + '\n'); process.exit(1); });
