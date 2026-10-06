/* 线上全功能自检（只读，不污染生产数据）：遍历所有模块 GET 接口 + 关键静态页 + 新功能 */
'use strict';
const BASE = 'http://114.117.233.47:8080';
let pass = 0, failN = 0;
const chk = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { failN++; console.log('  FAIL  ' + name + (extra ? ' → ' + String(extra).slice(0, 160) : '')); }
};

async function req(method, url, body, token, raw) {
  const res = await fetch(BASE + url, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') || '' };
  let j = null;
  try { j = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, j };
}

(async () => {
  console.log('=== MES-Light 线上全功能自检 ' + new Date().toLocaleString('zh-CN') + ' ===');

  // 1. 登录与身份
  const lg = await req('POST', '/api/login', { username: '管理员', password: '123456' });
  const token = lg.j && lg.j.data && lg.j.data.token;
  chk('管理员登录', !!token, JSON.stringify(lg.j));
  const T = (m, u) => req(m, u, null, token);
  const me = await T('GET', '/api/me');
  chk('身份接口 /api/me', me.j && me.j.ok && !!me.j.data.name, JSON.stringify(me.j));

  // 2. 基础数据模块（只读遍历）
  const basics = [
    ['/api/meta', '元数据'], ['/api/users', '用户'], ['/api/processes', '工序'], ['/api/work_centers', '工作中心'],
    ['/api/products', '产品'], ['/api/routes', '工艺路线'], ['/api/warehouses', '仓库'], ['/api/materials', '物料'],
    ['/api/inventory', '库存台账'], ['/api/inventory_tx?limit=50', '收发明细'], ['/api/material_issues', '领退料单'],
    ['/api/finished_goods_in', '成品入库单'], ['/api/stock_shipments', '成品出库单'], ['/api/incoming_materials', '来料单'],
    ['/api/stock_alerts', '安全库存预警'], ['/api/boms', '产品单耗BOM'],
  ];
  for (const [u, name] of basics) {
    const r = await T('GET', u);
    chk('基础·' + name, r.j && r.j.ok && r.j.data != null, JSON.stringify(r.j).slice(0, 100));
  }

  // 3. 生产执行
  const orders = await T('GET', '/api/orders');
  chk('生产·工单列表', orders.j && orders.j.ok && Array.isArray(orders.j.data) && orders.j.data.length > 0, JSON.stringify(orders.j).slice(0, 100));
  const oid = orders.j.data[0].id;
  const od = await T('GET', '/api/orders/' + oid);
  chk('生产·工单详情(含工序)', od.j && od.j.ok && Array.isArray(od.j.data.steps) && od.j.data.steps.length > 0, JSON.stringify(od.j).slice(0, 120));
  const reps = await T('GET', '/api/reports');
  chk('生产·报工记录', reps.j && reps.j.ok && Array.isArray(reps.j.data), JSON.stringify(reps.j).slice(0, 80));

  // 4. 质量模块
  const q = [
    ['/api/quality_issues', '异常单列表'], ['/api/inspections', '检验记录'], ['/api/inspections/pending', '待检队列'],
    ['/api/inspections/queue', '质检工作台队列'], ['/api/checklists', '检查表模板'], ['/api/quality/settings', '质量设置'],
    ['/api/bad_reasons', '不良原因库'],
  ];
  for (const [u, name] of q) {
    const r = await T('GET', u);
    chk('质量·' + name, r.j && r.j.ok, JSON.stringify(r.j).slice(0, 100));
  }

  // 5. 统计报表
  const stats = [
    ['/api/stats/overview', '总览'], ['/api/stats/trend?days=14', '产量趋势'], ['/api/stats/bad?days=14', '不良分布'],
    ['/api/stats/ranking?days=14', '人员排名'], ['/api/stats/orders', '工单达成'], ['/api/stats/yield', '产出比'],
    ['/api/stats/quality', '质量统计'], ['/api/stats/fpy', 'FPY一次合格率'], ['/api/stats/supplier_quality', '供应商质量'],
    ['/api/stats/quality_trend', '质量月度趋势'], ['/api/stats/material_loss', '材料损耗'], ['/api/stats/production-stock', '产销对账'],
    ['/api/stats/inventory_summary', '收发存汇总'],
  ];
  for (const [u, name] of stats) {
    const r = await T('GET', u);
    chk('统计·' + name, r.j && r.j.ok, JSON.stringify(r.j).slice(0, 100));
  }

  // 6. 本次升级新功能
  const wage = await T('GET', '/api/stats/piece_wage?days=30');
  chk('升级·计件工资', wage.j && wage.j.ok && Array.isArray(wage.j.data.rows), JSON.stringify(wage.j).slice(0, 120));
  const wageCsv = await req('GET', '/api/stats/piece_wage?days=30&format=csv', null, token, true);
  chk('升级·计件工资CSV', wageCsv.status === 200 && wageCsv.ct.indexOf('text/csv') >= 0, wageCsv.ct);
  const repCsv = await req('GET', '/api/reports?format=csv', null, token, true);
  chk('升级·报工记录CSV', repCsv.status === 200 && repCsv.ct.indexOf('text/csv') >= 0, repCsv.ct);
  const txCsv = await req('GET', '/api/inventory_tx?format=csv', null, token, true);
  chk('升级·收发明细CSV', txCsv.status === 200 && txCsv.ct.indexOf('text/csv') >= 0, txCsv.ct);

  const board = await req('GET', '/api/public/board', null, null, true);
  let bj = null; try { bj = JSON.parse(board.text); } catch (e) { /* ignore */ }
  chk('升级·车间大屏API(免登录)', board.status === 200 && bj && bj.ok && Array.isArray(bj.data.wip), board.text.slice(0, 100));
  // 追溯：用工单号 + 库存流水批次各测一次
  const txs = await T('GET', '/api/inventory_tx?limit=300');
  const txb = (txs.j && txs.j.data || []).find((r) => r.batch);
  if (txb) {
    const tr = await T('GET', '/api/trace/' + encodeURIComponent(txb.batch));
    chk('升级·批次追溯(' + txb.batch + ')', tr.j && tr.j.ok && tr.j.data.type === 'batch', JSON.stringify(tr.j).slice(0, 120));
  } else { chk('升级·批次追溯', false, '库存流水无批次数据'); }
  const orderCode = bj && bj.data.wip[0] ? bj.data.wip[0].code : (orders.j.data[0].code);
  const trO = await T('GET', '/api/trace/' + encodeURIComponent(orderCode));
  chk('升级·工单追溯(' + orderCode + ')', trO.j && trO.j.ok && trO.j.data.type === 'order', JSON.stringify(trO.j).slice(0, 120));

  // 7. 移动端 APP 接口
  const mo = await T('GET', '/api/app/my_orders');
  chk('移动端·我的工单', mo.j && mo.j.ok && Array.isArray(mo.j.data.orders), JSON.stringify(mo.j).slice(0, 100));
  const mn = await T('GET', '/api/notifications');
  chk('移动端·消息中心', mn.j && mn.j.ok && Array.isArray(mn.j.data), JSON.stringify(mn.j).slice(0, 80));

  // 8. 关键页面
  const pages = ['/', '/m/', '/m/app/', '/m/app/app.js', '/install.html', '/board.html', '/downloads/mes-app-v1.0.apk'];
  for (const p of pages) {
    const r = await req('GET', p, null, null, true);
    chk('页面 ' + p, r.status === 200, 'HTTP ' + r.status);
  }

  // 9. 安全抽检（未登录访问受保护接口一律 401；meta/登录保持公开）
  const noauth = await req('GET', '/api/orders', null, null);
  chk('安全·未登录访问工单被拒(401)', noauth.status === 401, 'HTTP ' + noauth.status);
  const noauthUsers = await req('GET', '/api/users', null, null);
  chk('安全·未登录访问用户名单被拒(401)', noauthUsers.status === 401, 'HTTP ' + noauthUsers.status);
  const noauthLogs = await req('GET', '/api/logs', null, null);
  chk('安全·未登录访问日志被拒(401)', noauthLogs.status === 401, 'HTTP ' + noauthLogs.status);
  const pubMeta = await req('GET', '/api/meta', null, null);
  chk('安全·meta 探测保持公开', pubMeta.status === 200 && pubMeta.j && pubMeta.j.ok, 'HTTP ' + pubMeta.status);
  const pubBoard = await req('GET', '/api/public/board', null, null);
  chk('安全·大屏接口保持公开', pubBoard.status === 200, 'HTTP ' + pubBoard.status);

  console.log(`\n===== 自检结果：${pass} 通过 / ${failN} 失败 =====`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error('自检异常：', e); process.exit(1); });
