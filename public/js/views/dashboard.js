/* 生产看板 */
window.Views = window.Views || {};
Views.dashboard = {
  title: '生产看板',
  icon: 'dash',
  async render(el) {
    el.innerHTML = `<div class="empty">${UI.icon('clock')}<div>加载中…</div></div>`;
    const [ov, trend, bad, rank, running, wcs] = await Promise.all([
      API.get('/stats/overview'),
      API.get('/stats/trend?days=14'),
      API.get('/stats/bad?days=14'),
      API.get('/stats/ranking?days=7'),
      API.get('/orders?status=running,paused'),
      API.get('/work_centers'),
    ]);

    const yieldCls = ov.yield >= 98 ? 'ok' : ov.yield >= 95 ? '' : 'danger';
    const d = new Date();
    const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`;

    el.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <div>
          <div style="font-size:19px;font-weight:700">生产看板</div>
          <div class="small muted">${dateStr} · 数据实时来自报工记录</div>
        </div>
        <button class="btn btn-primary" id="quickReport">${UI.icon('report')}快速报工</button>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat">
          <div class="stat-l"><i class="dot" style="background:var(--ok)"></i>今日合格产量</div>
          <div class="stat-v" style="color:var(--ok)">${UI.n2(ov.today.good)}</div>
          <div class="stat-s">不良 ${UI.n2(ov.today.bad)} 件 · 投入 ${UI.n2(ov.today.good + ov.today.bad)} 件</div>
        </div>
        <div class="stat">
          <div class="stat-l"><i class="dot" style="background:var(--primary)"></i>今日良率</div>
          <div class="stat-v">${UI.f1(ov.yield)}%</div>
          <div class="stat-s">${UI.progress(ov.yield, yieldCls)}</div>
        </div>
        <div class="stat">
          <div class="stat-l"><i class="dot" style="background:var(--warn)"></i>在制工单</div>
          <div class="stat-v" style="color:var(--warn)">${ov.orders.running + ov.orders.paused}</div>
          <div class="stat-s">生产中 ${ov.orders.running} · 暂停 ${ov.orders.paused} · 待下发 ${ov.orders.waiting}</div>
        </div>
        <div class="stat">
          <div class="stat-l"><i class="dot" style="background:var(--danger)"></i>逾期工单</div>
          <div class="stat-v" style="color:${ov.orders.overdue ? 'var(--danger)' : 'inherit'}">${ov.orders.overdue}</div>
          <div class="stat-s">本月累计产量 ${UI.n2(ov.monthGood)} 件</div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns:1.55fr 1fr;margin-bottom:14px">
        <div class="card">
          <div class="card-h"><h3>近 14 天产量趋势</h3>
            <span class="small muted">合格 / 不良</span></div>
          <div class="card-b">
            ${UI.lineChart(trend, [
              { key: 'good', label: '合格数', color: '#1d4ed8' },
              { key: 'bad', label: '不良数', color: '#d93b3b', area: false },
            ], { w: 660, h: 230 })}
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h3>设备状态</h3></div>
          <div class="card-b">
            <div class="grid g2 keep2" style="gap:10px;margin-bottom:14px">
              <div class="stat" style="box-shadow:none">
                <div class="stat-l small">运转中</div><div class="stat-v" style="color:var(--ok)">${ov.workCenters.running}</div></div>
              <div class="stat" style="box-shadow:none">
                <div class="stat-l small">故障 / 保养</div><div class="stat-v" style="color:var(--danger)">${ov.workCenters.fault + ov.workCenters.maintain}</div></div>
            </div>
            ${UI.table([
              { t: '设备', f: (r) => `<b>${UI.esc(r.code)}</b> <span class="small muted">${UI.esc(r.name)}</span>` },
              { t: '车间', k: 'workshop', f: (r) => UI.esc(r.workshop || '-') },
              { t: '状态', f: (r) => { const m = UI.WC_STATUS[r.status] || ['-', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; }, align: 'right' },
            ], wcs, { emptyText: '暂无设备' })}
          </div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns:1.55fr 1fr;margin-bottom:14px">
        <div class="card">
          <div class="card-h"><h3>在制工单进度</h3>
            <button class="btn btn-sm btn-ghost" id="allOrders">查看全部 ${UI.icon('back')}</button></div>
          <div class="card-b tight">
            ${UI.table([
              { t: '工单', f: (r) => `<div><b class="link" data-order="${r.id}">${UI.esc(r.code)}</b></div>
                   <div class="small muted">${UI.esc(r.product_name)} ${UI.esc(r.spec || '')}</div>` },
              { t: '状态', f: (r) => UI.badge(r.status) },
              { t: '交期', f: (r) => `<span class="${r.plan_end < UI.today() ? 'chip chip-danger' : 'small muted'}">${UI.esc(r.plan_end)}</span>` },
              { t: '进度', w: '150px', f: (r) => `<div class="row" style="gap:8px;flex-wrap:nowrap">
                   ${UI.progress(UI.pct(r.qty_done, r.qty_plan), r.qty_done >= r.qty_plan ? 'ok' : '')}
                   <span class="small mono">${UI.n2(r.qty_done)}/${UI.n2(r.qty_plan)}</span></div>` },
              { t: '工序', f: (r) => `<span class="small muted">${r.step_done}/${r.step_total}</span>`, align: 'right' },
            ], running, { emptyText: '当前没有在制工单' })}
          </div>
        </div>
        <div class="grid" style="gap:14px;align-content:start">
          <div class="card">
            <div class="card-h"><h3>不良原因 TOP（14天）</h3></div>
            <div class="card-b">
              ${UI.barChart(bad.slice(0, 6), { color: '#d93b3b', labelW: 76 })}
              <div class="small muted" style="margin-top:8px">近 14 天不良合计 <b>${UI.n2(bad.reduce((s, x) => s + x.qty, 0))}</b> 件</div>
            </div>
          </div>
          <div class="card">
            <div class="card-h"><h3>人员产出排行（7天）</h3></div>
            <div class="card-b">
              ${UI.barChart(rank.slice(0, 6).map((r) => ({ name: r.name, qty: r.good, unit: ' 件' })), { color: '#1d4ed8', labelW: 60 })}
            </div>
          </div>
        </div>
      </div>`;

    el.querySelector('#quickReport').onclick = () => location.hash = '#/report';
    el.querySelector('#allOrders').onclick = () => location.hash = '#/orders';
    el.querySelectorAll('[data-order]').forEach((a) => a.onclick = () => location.hash = '#/orders/' + a.dataset.order);
  },
};
