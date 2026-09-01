/* 关闭工单 + 微信扫码报工 全链路冒烟测试 */
const BASE = 'http://localhost:5173';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ [失败] ' + m); } };

async function call(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d; try { d = await r.json(); } catch (e) { d = { ok: false, msg: '非JSON' }; }
  return { status: r.status, data: d.data, ok: d.ok, msg: d.msg };
}

(async () => {
  console.log('=== 1. 登录 ===');
  const L = await call('POST', '/api/login', null, { username: 'admin', password: '123456' });
  ok(L.ok, '管理员登录成功');
  const T = L.data.token;

  console.log('=== 2. 关闭工单（含原因） ===');
  const list = await call('GET', '/api/orders?status=running,paused,released', T);
  ok(list.ok && list.data.length >= 2, '取到 ' + list.data.length + ' 张活动工单');
  const o1 = list.data[0], o2 = list.data[1];
  const cl = await call('PATCH', '/api/orders/' + o1.id + '/status', T, { status: 'closed', close_reason: '客户取消' });
  ok(cl.ok, '工单 ' + o1.code + ' 关闭成功');
  const o1b = await call('GET', '/api/orders/' + o1.id, T);
  ok(o1b.data.status === 'closed', '状态已变为 closed');
  ok(!!o1b.data.finish_time, '关闭时记录了完工时间 finish_time');
  ok(o1b.data.close_reason === '客户取消', '关闭原因已保存：' + o1b.data.close_reason);

  console.log('=== 3. 生成工单报工二维码 ===');
  const qr = await call('GET', '/api/qr/order/' + o2.id, T);
  ok(qr.ok && /<svg/.test(qr.data.svg), '返回二维码 SVG');
  ok(/900/.test(qr.data.url) === false && /\/m\/report\?o=/.test(qr.data.url), '二维码链接指向移动报工页：' + qr.data.url);
  const token = qr.data.token;

  console.log('=== 4. 免登录读取工单（公开接口） ===');
  const pub = await call('GET', '/api/public/order/' + o2.id + '?t=' + token);
  ok(pub.ok, '凭令牌读取工单成功');
  ok(pub.data.steps.length > 0, '返回 ' + pub.data.steps.length + ' 道工序');
  ok(pub.data.workers.length > 0, '返回 ' + pub.data.workers.length + ' 名可选报工人');
  const badTok = await call('GET', '/api/public/order/' + o2.id + '?t=invalid');
  ok(!badTok.ok && badTok.status === 403, '伪造令牌被拒绝(403)');

  console.log('=== 5. 免登录扫码报工 ===');
  const step = pub.data.steps.find((s) => s.status !== 'done') || pub.data.steps[0];
  const worker = pub.data.workers[0];
  const before = step.qty_good;
  const rep = await call('POST', '/api/public/reports', null, {
    token, order_id: o2.id, order_step_id: step.id, worker_id: worker.id,
    qty_good: 25, qty_bad: 1, bad_reason: '尺寸超差', report_date: new Date().toISOString().slice(0, 10), remark: '',
  });
  ok(rep.ok, '扫码报工提交成功');
  const pub2 = await call('GET', '/api/public/order/' + o2.id + '?t=' + token);
  const step2 = pub2.data.steps.find((s) => s.id === step.id);
  ok(step2.qty_good === before + 25, '工序合格数 ' + before + ' → ' + step2.qty_good);

  console.log('=== 6. 员工报工二维码 + 员工维度读取 ===');
  const wqr = await call('GET', '/api/qr/worker/' + worker.id, T);
  ok(wqr.ok && /<svg/.test(wqr.data.svg), '返回员工二维码 SVG');
  const wpub = await call('GET', '/api/public/worker/' + worker.id + '?t=' + wqr.data.token);
  ok(wpub.ok, '凭员工令牌读取其工单成功');
  // 用员工令牌访问其被指派的工单
  const assignOrder = wpub.data.orders[0];
  if (assignOrder) {
    const opub = await call('GET', '/api/public/order/' + assignOrder.id + '?t=' + wqr.data.token + '&wid=' + worker.id);
    ok(opub.ok, '员工令牌可访问其被指派工单 ' + assignOrder.code);
  } else { ok(true, '该员工当前无在制工单（跳过维度校验）'); }

  console.log('=== 7. 移动端页面可达 ===');
  const m = await fetch(BASE + '/m/');
  ok(m.status === 200 && /扫码报工/.test(await m.text()), '移动报工页 /m/ 可访问');

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
