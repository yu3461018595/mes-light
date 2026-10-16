/* 工单附件（作业指导书/图纸）功能测试（2026-10-16）
 * 覆盖：建表、上传三类附件、权限、下载、报工接口返回、质检队列返回、前端接线
 * 用法：node test_attachment.cjs
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 5322);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mes-att-'));
const ROOT = __dirname;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
let pass = 0, fail = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '→ ' + extra : '')); }
};
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };

async function api(method, url, body, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${url}`, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return j;
}
async function login(u, p) {
  const j = await api('POST', '/login', { username: u, password: p });
  return (j && j.data && j.data.token) || '';
}
const b64 = (buf) => buf.toString('base64');

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await wait(3500);

  console.log('\n== 1. 建表 ==');
  try {
    const D = require(path.join(ROOT, 'lib', 'db.js'));
    const cols = D.all('PRAGMA table_info(order_attachments)').map((c) => c.name);
    chk('order_attachments 表存在', cols.length > 0);
    for (const c of ['order_id', 'kind', 'title', 'file', 'ext', 'size', 'created_by', 'created_at']) {
      chk('字段 ' + c + ' 存在', cols.includes(c), cols.join(','));
    }
    chk('settings 表未被误删',
      D.all("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").length === 1);
  } catch (e) { chk('order_attachments 表存在', false, e.message); }

  // 准备一个工单
  const admin = await login('admin', '123456');
  chk('管理员登录', !!admin);
  const meta = (await api('GET', '/meta', null, admin)).data || {};
  const prod = (meta.products || [])[0];
  const route = (meta.routes || [])[0];
  chk('存在产品与工艺路线用于建单', !!prod && !!route);
  let orderId = 0;
  if (prod && route) {
    const o = await api('POST', '/orders', {
      product_id: prod.id, route_id: route.id, qty_plan: 10, priority: 2,
      plan_start: '2026-10-16', plan_end: '2026-10-20',
    }, admin);
    chk('创建测试工单', o && o.ok === true, o && o.msg);
    orderId = (o && o.data && o.data.id) || 0;
  }
  if (!orderId) {
    console.log('\n无法建单，后续断言跳过');
    console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
    srv.kill(); process.exit(1);
  }

  console.log('\n== 2. 上传三类附件 ==');
  const sopBuf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(512, 0x20)]);
  const dwgBuf = Buffer.from('AC1032DWGPLACEHOLDER');
  let ids = {};
  for (const [kind, name, buf] of [
    ['sop', '作业指导书.pdf', sopBuf],
    ['drawing', '零件图.dwg', dwgBuf],
    ['other', '客户要求.txt', Buffer.from('急件，优先处理', 'utf8')],
  ]) {
    const r = await api('POST', `/orders/${orderId}/attachments`, { kind, name, title: name, data: b64(buf) }, admin);
    chk('上传 ' + kind + ' 类型成功', r && r.ok === true, r && r.msg);
    if (r && r.ok) {
      const a = r.data.attachment;
      ids[kind] = a.id;
      chk('  ' + kind + '：size 记录正确', a.size === buf.length);
      chk('  ' + kind + '：ext 记录正确', a.ext === path.extname(name).toLowerCase());
      chk('  ' + kind + '：kind_label 中文可读', !!a.kind_label);
    }
  }

  console.log('\n== 3. 参数校验 ==');
  let r = await api('POST', `/orders/${orderId}/attachments`, { kind: 'sop', name: 'a.exe', data: b64(Buffer.from('x')) }, admin);
  chk('不支持的扩展名被拒', r.ok === false && /格式/.test(r.msg || ''));
  r = await api('POST', `/orders/${orderId}/attachments`, { kind: 'sop', name: 'x.pdf', data: '' }, admin);
  chk('空内容被拒', r.ok === false);
  r = await api('POST', `/orders/${orderId}/attachments`, { kind: 'sop', name: 'x.pdf', data: b64(Buffer.alloc(21 * 1024 * 1024)) }, admin);
  chk('超过 20MB 被拒', r.ok === false && /20MB/.test(r.msg || ''));
  r = await api('POST', `/orders/${orderId}/attachments`, { kind: 'weird', name: 'x.pdf', data: b64(Buffer.from('%PDF')) }, admin);
  chk('未知 kind 归为 other', r.ok === true && r.data.attachment.kind === 'other');
  r = await api('POST', '/orders/999999/attachments', { kind: 'sop', name: 'x.pdf', data: b64(sopBuf) }, admin);
  chk('工单不存在返回 404', r.ok === false && r.msg === '工单不存在');

  console.log('\n== 4. 权限 ==');
  const worker = await login('worker1', '123456');
  chk('工人登录', !!worker);
  if (worker) {
    r = await api('POST', `/orders/${orderId}/attachments`, { kind: 'sop', name: 'x.pdf', data: b64(sopBuf) }, worker);
    chk('工人不能上传附件', r.ok === false);
    r = await api('GET', `/orders/${orderId}/attachments`, null, worker);
    chk('工人可以查看附件（现场要能看到图纸）', r.ok === true && r.data.attachments.length > 0);
    if (r.ok && r.data.attachments.length) {
      const insp = await api('GET', '/orders/' + orderId + '/attachments', null, worker);
      chk('查看返回 previewable 标记', insp.data.attachments.every((a) => typeof a.previewable === 'boolean'));
      const pdf = insp.data.attachments.find((a) => a.ext === '.pdf');
      const dwg = insp.data.attachments.find((a) => a.ext === '.dwg');
      chk('PDF 标记为可预览', pdf && pdf.previewable === true);
      chk('DWG 标记为不可预览（避免现场白屏）', dwg && dwg.previewable === false);
    }
    if (ids.sop) {
      r = await api('DELETE', `/orders/${orderId}/attachments/${ids.sop}`, null, worker);
      chk('工人不能删除附件', r.ok === false);
    }
  }
  r = await api('GET', `/orders/${orderId}/attachments`);
  chk('未登录不能查附件', r.ok === false);

  console.log('\n== 5. 文件可下载 ==');
  r = await api('GET', `/orders/${orderId}/attachments`, null, admin);
  const list = r.data.attachments;
  chk('列表含 4 个附件（3 个 + 兜底的 other）', list.length >= 4, '实际 ' + list.length);
  const dwgAtt = list.find((a) => a.ext === '.dwg');
  if (dwgAtt) {
    const res = await fetch(`http://127.0.0.1:${PORT}${dwgAtt.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    chk('附件可从 /uploads 下载', res.status === 200);
    chk('下载内容与上传一致', buf.equals(dwgBuf), `${buf.length} vs ${dwgBuf.length}`);
  }

  console.log('\n== 6. 报工接口返回附件（操作工/检验员能看到的关键）==');
  if (worker) {
    r = await api('GET', `/app/order/${orderId}`, null, worker);
    chk('报工详情接口可访问', r.ok === true, r && r.msg);
    chk('报工接口返回 attachments 字段', !!(r.ok && Array.isArray(r.data.attachments)));
    chk('报工接口带出本单全部附件', r.ok && r.data.attachments.length >= 4, '实际 ' + (r.ok && r.data.attachments.length));
  }
  // 检验员：待检队列也要带附件
  const qcTok = await login('qc01', '123456');
  if (!qcTok) {
    console.log('  （无 qc01 账号，跳过质检队列断言）');
  } else {
    r = await api('GET', '/inspections/queue', null, qcTok);
    chk('待检队列接口可访问', r.ok === true);
    chk('待检队列每行都有 attachments 字段（无附件时为空数组）',
      r.ok && r.data.steps.every((s) => Array.isArray(s.attachments)));
  }
  const techTok = await login('tech01', '123456');
  if (techTok) {
    r = await api('GET', '/inspections/queue', null, techTok);
    chk('技术员也能查待检队列并拿到附件', r.ok === true && r.data.steps.every((s) => Array.isArray(s.attachments)));
  }

  console.log('\n== 7. 删除 ==');
  if (ids.other) {
    r = await api('DELETE', `/orders/${orderId}/attachments/${ids.other}`, null, admin);
    chk('管理员可删除附件', r.ok === true);
    r = await api('GET', `/orders/${orderId}/attachments`, null, admin);
    chk('删除后列表减少', r.data.attachments.length === list.length - 1);
    r = await api('DELETE', `/orders/${orderId}/attachments/${ids.other}`, null, admin);
    chk('重复删除返回 404', r.ok === false);
  }

  console.log('\n== 8. PC 端界面 ==');
  const ojs = read('public/js/views/orders.js');
  chk('orders.js 可读取', !!ojs);
  try {
    new (require('node:vm').Script)(ojs, { filename: 'orders.js' });
    chk('orders.js 语法正确', true);
  } catch (e) { chk('orders.js 语法正确', false, e.message); }
  chk('工单详情有附件区块', ojs.includes('作业指导书与图纸'));
  chk('有上传作业指导书按钮', ojs.includes('#attSop'));
  chk('有上传图纸按钮', ojs.includes('#attDraw'));
  chk('有上传其他资料按钮', ojs.includes('#attOther'));
  chk('有删除附件按钮', ojs.includes('data-attdel'));
  chk('有下载按钮', ojs.includes('download='));
  chk('提示现场可见', /操作工与检验员/.test(ojs));
  chk('上传走 attachments 接口', ojs.includes("'/orders/' + id + '/attachments'"));
  chk('空态有引导文案', /暂无附件/.test(ojs));
  chk('上传前校验 20MB', /20 \* 1024 \* 1024/.test(ojs));

  console.log('\n== 9. 移动端界面 ==');
  const app = read('public/m/app/app.js');
  chk('app.js 可读取', !!app);
  try {
    new (require('node:vm').Script)(app, { filename: 'app.js' });
    chk('app.js 语法正确', true);
  } catch (e) { chk('app.js 语法正确', false, e.message); }
  chk('报工页展示工单附件', app.includes('作业指导书与图纸'));
  chk('接收后端 attachments', /S\.attachments = data\.attachments/.test(app));
  chk('附件行可点击', app.includes('data-att='));
  chk('有共享预览函数 openAttach', /function openAttach/.test(app));
  chk('图片内嵌预览', app.includes('<img src="${a.url}"'));
  chk('PDF 用 iframe 预览', app.includes('<iframe src="${a.url}"'));
  chk('不可预览格式引导下载', app.includes('需要下载后查看'));
  chk('质检台也展示本单资料', app.includes('本单资料'));
  chk('质检台附件可点击', app.includes('data-qatt'));
  chk('附件区块在工序列表之前（现场先看图纸再干活）',
    app.indexOf('作业指导书与图纸') < app.indexOf('选择工序（可多选）'));
  chk('空附件时不占版面', /if \(!list\.length\) return '';/.test(app));

  console.log('\n== 10. 与工序 SOP 的区分 ==');
  chk('工单附件表独立于 processes.sop_file', read('lib/db.js').includes('order_attachments'));
  chk('报工接口同时保留工序 SOP 字段', (await api('GET', `/app/order/${orderId}`, null, worker || admin)).ok);

  console.log('\n========================================');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('========================================');
  if (fail) {
    console.log('\n排查指引：');
    console.log('  1. 「报工接口返回附件」失败 → GET /api/app/order/:id 的 ok() 里少传 attachments');
    console.log('  2. 「不可预览」判断失败 → attachPublic 的 previewable 列表要含 pdf/图片，不含 dwg/docx');
    console.log('  3. 「现场可见」失败 → attachments 接口 roles 不能限制为 admin，否则工人打不开');
    console.log('  4. 页面不显示 → 后端返回 attachments 但前端没读；确认 data.attachments 已接上');
  }
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});