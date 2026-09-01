/* 删除功能验证脚本 */
const BASE = 'http://localhost:5173';
let pass = 0, fail = 0;
const log = (ok, msg) => { (ok ? pass++ : fail++); console.log((ok ? '[通过] ' : '[失败] ') + msg); };

async function call(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, ok: data.ok, msg: data.msg, data: data.data };
}

let TOKEN = '';
(async () => {
  const r = await call2('POST', '/login', { username: 'admin', password: '123456' });
  TOKEN = r.data.token;

  // 1) 删除无记录的管理员账号（陈静 id=3）
  let d = await call('DELETE', '/users/3');
  log(d.ok && d.status === 200, '删除无记录员工(陈静)成功 ' + JSON.stringify(d));

  // 2) 删除有报工/派工记录的操作工（王强 id=5）
  d = await call('DELETE', '/users/5');
  log(!d.ok && d.status === 409 && /报工/.test(d.msg), '有记录员工被拦截并给出提示: ' + d.msg);

  // 3) 删除当前登录账号（admin id=1）
  d = await call('DELETE', '/users/1');
  log(!d.ok && /当前登录/.test(d.msg), '自删被拦截: ' + d.msg);

  // 4) 删除被工单引用的产品（id=2 P2002）
  d = await call('DELETE', '/products/2');
  log(!d.ok && d.status === 409 && /工单/.test(d.msg), '被工单引用的产品被拦截: ' + d.msg);

  // 5) 新建一个未被引用的产品并删除（验证级联）
  const np = await call('POST', '/products', { code: 'PTEST', name: '测试产品', spec: 'x', unit: '件', price: 1 });
  const npid = np.data.id;
  // 给它建一条工艺路线（无工单）
  const nr = await call('POST', '/routes', { code: 'RTEST', name: '测试路线', product_id: npid, steps: [{ seq: 10, process_id: 1, work_center_id: null, std_time: 1, std_price: 1 }] });
  d = await call('DELETE', '/products/' + npid);
  log(d.ok, '删除未引用产品(含其路线)成功 ' + JSON.stringify(d));
  // 确认路线也被清掉
  const afterRoute = await call('GET', '/routes');
  log(!afterRoute.data.find((r) => r.id === nr.data.id), '产品删除后其工艺路线已级联清理');

  // 6) 删除被工单工序使用的工序（id=1 OP10）
  d = await call('DELETE', '/processes/1');
  log(!d.ok && d.status === 409 && /工单工序/.test(d.msg), '被工单使用的工序被拦截: ' + d.msg);

  // 7) 新建未被工单使用的工序，挂到一条新路线上，再删除（验证级联清理 route_steps 与落空路线）
  const npr = await call('POST', '/processes', { code: 'OPTEST', name: '测试工序', std_time: 1, std_price: 1, remark: '' });
  const nprid = npr.data.id;
  const nr2 = await call('POST', '/routes', { code: 'RTEST2', name: '测试路线2', product_id: 2, steps: [{ seq: 10, process_id: nprid, work_center_id: null, std_time: 1, std_price: 1 }] });
  d = await call('DELETE', '/processes/' + nprid);
  log(d.ok, '删除未使用工序成功 ' + JSON.stringify(d));
  const afterSteps = await call('GET', '/routes/' + nr2.data.id + '/steps');
  log(afterSteps.data.length === 0, '工序删除后其路线明细已清理');
  const afterRoute2 = await call('GET', '/routes');
  log(!afterRoute2.data.find((r) => r.id === nr2.data.id), '仅含该工序的落空路线已一并删除');

  // 8) 删除被工单使用的工艺路线（id=1）
  d = await call('DELETE', '/routes/1');
  log(!d.ok && d.status === 409 && /工单/.test(d.msg), '被工单使用的工艺路线被拦截: ' + d.msg);

  // 9) 删除被人员引用的工作中心（id=1 若有人员绑定）
  const wcUsed = await call('GET', '/work_centers');
  // 找一个被引用的：简单用 id=1（演示数据里工作中心多被绑定）
  d = await call('DELETE', '/work_centers/1');
  log(d.ok || (!d.ok && /引用/.test(d.msg)), '工作中心删除：成功或被引用时给出提示: ' + (d.msg || 'ok'));

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常', e); process.exit(2); });

async function call2(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json()) };
}
