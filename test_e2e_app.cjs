/* 端到端 HTTP 冒烟：起真实服务进程，验证 APP 静态资源可访问、登录→消息→报工全链路可用 */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eapp-'));
const PORT = 18321;
const ROOT = __dirname;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n); } };
const jreq = async (method, p, b, t) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
  return { status: r.status, ct, body };
};
const D = (r) => (r.body && r.body.data !== undefined ? r.body.data : null);

(async () => {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DATA_DIR: tmp, PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write('[srv] ' + s); });

  // 等待端口就绪
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/meta`); if (r.ok) { up = true; break; } } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(up, '服务启动并监听 ' + PORT);

  console.log('\n【1】APP 静态资源可达性');
  const pageRes = await fetch(`http://127.0.0.1:${PORT}/m/app/`);
  const pageHtml = await pageRes.text();
  ok(pageRes.status === 200 && /移动工作台/.test(pageHtml), 'GET /m/app/ 返回 APP 页面');
  ok(/app\.css/.test(pageHtml) && /app\.js/.test(pageHtml), '页面引用了 app.css / app.js');
  const mRes = await fetch(`http://127.0.0.1:${PORT}/m/`);
  ok(mRes.status === 200 && /移动工作台/.test(await mRes.text()), 'GET /m/ 直接进入 APP 工作台');
  const aliasRes = await fetch(`http://127.0.0.1:${PORT}/app`);
  ok(aliasRes.status === 200 && /移动工作台/.test(await aliasRes.text()), 'GET /app 别名可用');
  const scanRes = await fetch(`http://127.0.0.1:${PORT}/m/index.html`);
  ok(scanRes.status === 200 && /扫码报工/.test(await scanRes.text()), '/m/index.html 仍是免登录扫码报工页');
  for (const f of ['/m/app/app.css', '/m/app/app.js']) {
    const r = await fetch(`http://127.0.0.1:${PORT}${f}`);
    ok(r.status === 200, '静态文件可访问 ' + f);
  }
  const swRes = await fetch(`http://127.0.0.1:${PORT}/sw.js`);
  ok(swRes.status === 200 && /mes-light-v7/.test(await swRes.text()), 'Service Worker 缓存版本已升到 v7');
  const mfRes = await fetch(`http://127.0.0.1:${PORT}/manifest.json`);
  const mf = await mfRes.json().catch(() => ({}));
  ok(mf.display === 'standalone' && mf.start_url, 'PWA manifest 为 standalone 且有 start_url');

  console.log('\n【2】登录 → 我的工单 → 报工（APP 全链路）');
  const login = await jreq('POST', '/api/login', { username: 'admin', password: '123456' });
  const tok = D(login) && D(login).token;
  ok(!!tok, '管理员登录成功');
  const me = await jreq('GET', '/api/me', undefined, tok);
  ok(me.status === 200 && D(me).role === 'admin', '/api/me 返回当前用户');

  const my = await jreq('GET', '/api/app/my_orders', undefined, tok);
  ok(my.status === 200 && Array.isArray(D(my).orders), '/api/app/my_orders 返回工单数组');

  const users = D(await jreq('GET', '/api/users', undefined, tok)) || [];
  const ins = users.find((u) => u.role === 'inspector');
  ok(!!ins, '存在质检员账号 ' + (ins && ins.name));
  const qc = await jreq('POST', '/api/login', { username: ins.username, password: '123456' });
  const qcTok = D(qc) && D(qc).token;
  ok(!!qcTok, '质检员登录成功');
  const q = await jreq('GET', '/api/inspections/queue', undefined, qcTok);
  ok(q.status === 200 && Array.isArray(D(q).steps), '/api/inspections/queue 返回待检队列');
  ok(Array.isArray(D(q).badReasons), '队列回带不良原因字典');

  console.log('\n【3】消息中心全链路');
  const srcs = await jreq('GET', '/api/message_sources', undefined, tok);
  ok(srcs.status === 200 && D(srcs).length >= 4, '/api/message_sources 返回 4 类场景');
  const scan = await jreq('POST', '/api/stock_alerts/scan', {}, tok);
  ok(scan.status === 200 && typeof D(scan).sent === 'number', '/api/stock_alerts/scan 可用（sent=' + D(scan).sent + '）');
  const alerts = await jreq('GET', '/api/stock_alerts', undefined, tok);
  ok(alerts.status === 200 && Array.isArray(D(alerts)), '/api/stock_alerts 返回列表');
  ok(D(alerts).every((x) => x.level === 'short' || x.level === 'over'), '库存预警只含缺料/积压');
  const nc = await jreq('GET', '/api/notifications/unread_count', undefined, tok);
  ok(nc.status === 200 && typeof D(nc).count === 'number' && typeof D(nc).by_source === 'object', '未读计数接口结构正确');
  const list = await jreq('GET', '/api/notifications', undefined, tok);
  const rows = D(list) || [];
  ok(rows.length > 0, '消息列表有数据（' + rows.length + ' 条）');
  ok(rows.every((r) => r.source_label && r.kind_label), '每条消息都带中文场景/小类标签');
  ok(rows.every((r) => r.source), '每条消息都有 source 场景字段');
  if (rows.length) {
    const one = await jreq('POST', '/api/notifications/read', { id: rows[0].id }, tok);
    ok(one.status === 200, '单条已读成功');
    const nc2 = await jreq('GET', '/api/notifications/unread_count', undefined, tok);
    ok(D(nc2).count === D(nc).count - 1, '已读后未读计数减 1');
    const all = await jreq('POST', '/api/notifications/read', {}, tok);
    ok(all.status === 200, '全部已读成功');
    ok(D(await jreq('GET', '/api/notifications/unread_count', undefined, tok)).count === 0, '全部已读后计数归零');
  }
  const bySrc = await jreq('GET', '/api/notifications?source=stock', undefined, tok);
  ok((D(bySrc) || []).every((x) => x.source === 'stock'), '按 source=stock 筛选正确');

  console.log('\n【4】改密码与资料（APP「我的」页）');
  const pwdWrong = await jreq('POST', '/api/password', { old_password: 'bad', new_password: 'abcdef12' }, tok);
  ok(pwdWrong.status === 400, '原密码错误 → 400');
  const prof = await jreq('POST', '/api/profile', { name: '系统管理员' }, tok);
  ok(prof.status === 200 && D(prof).name === '系统管理员', '改姓名成功');
  const pwdOk = await jreq('POST', '/api/password', { old_password: '123456', new_password: '123456' }, tok);
  ok(pwdOk.status !== 200, '新旧密码相同 → 拒绝');

  console.log('\n【5】权限边界');
  const worker = users.find((u) => u.role === 'worker');
  const wl = await jreq('POST', '/api/login', { username: worker.username, password: '123456' });
  const wTok = D(wl) && D(wl).token;
  ok(!!wTok, '操作工登录成功 ' + worker.name);
  ok((await jreq('GET', '/api/stock_alerts', undefined, wTok)).status === 403, '操作工访问库存预警 → 403');
  ok((await jreq('POST', '/api/stock_alerts/scan', {}, wTok)).status === 403, '操作工触发扫描 → 403');
  ok((await jreq('GET', '/api/inspections/queue', undefined, wTok)).status === 403, '操作工访问质检台队列 → 403');
  ok((await jreq('GET', '/api/app/my_orders')).status === 401, '未登录访问我的工单 → 401');
  const wo = D(await jreq('GET', '/api/app/my_orders', undefined, wTok));
  ok(wo && Array.isArray(wo.orders), '操作工可读自己的在制工单（' + (wo.orders || []).length + ' 张）');

  console.log('\n————————————————————————');
  console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
  try { proc.kill(); } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E 异常：', e); process.exit(1); });
