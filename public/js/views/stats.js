/* 统计报表 + 操作日志 */
window.Views = window.Views || {};

Views.stats = {
  title: '统计报表',
  icon: 'stats',
  days: 14,

  async render(el) {
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <div class="tabs" style="margin:0;border:none">
          ${[7, 14, 30].map((d) => `<div class="tab ${this.days === d ? 'active' : ''}" data-d="${d}">近 ${d} 天</div>`).join('')}
        </div>
        <button class="btn" id="export">${UI.icon('box')}导出 CSV</button>
      </div>
      <div id="panel">加载中…</div>`;
    el.querySelectorAll('[data-d]').forEach((t) => t.onclick = () => { this.days = Number(t.dataset.d); this.render(el); });
    el.querySelector('#export').onclick = () => this.exportCsv();

    const [trend, bad, rank, orders] = await Promise.all([
      API.get('/stats/trend?days=' + this.days),
      API.get('/stats/bad?days=' + this.days),
      API.get('/stats/ranking?days=' + this.days),
      API.get('/stats/orders'),
    ]);
    this.last = { trend, bad, rank, orders };

    const totalGood = trend.reduce((s, r) => s + r.good, 0);
    const totalBad = trend.reduce((s, r) => s + r.bad, 0);
    const yRate = totalGood + totalBad ? (totalGood / (totalGood + totalBad)) * 100 : 100;
    const yieldRows = trend.map((r) => ({
      d: r.d, good: r.good + r.bad ? Math.round((r.good / (r.good + r.bad)) * 1000) / 10 : 100, bad: 0,
    }));

    el.querySelector('#panel').innerHTML = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l">期间总产量</div><div class="stat-v" style="color:var(--ok)">${UI.n2(totalGood)}</div>
          <div class="stat-s">件 · 日均 ${UI.n2(Math.round(totalGood / Math.max(1, trend.length)))}</div></div>
        <div class="stat"><div class="stat-l">期间不良数</div><div class="stat-v" style="color:var(--danger)">${UI.n2(totalBad)}</div>
          <div class="stat-s">件 · 涉及 ${bad.length} 类原因</div></div>
        <div class="stat"><div class="stat-l">综合良率</div><div class="stat-v">${UI.f1(yRate)}%</div>
          <div class="stat-s">${UI.progress(yRate, yRate >= 98 ? 'ok' : yRate >= 95 ? '' : 'danger')}</div></div>
        <div class="stat"><div class="stat-l">累计工时</div><div class="stat-v">${UI.f1(trend.reduce((s, r) => s + r.minu, 0) / 60)}</div>
          <div class="stat-s">小时 · 参与 ${rank.length} 人</div></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>产量与不良趋势</h3></div>
        <div class="card-b">${UI.lineChart(trend, [
          { key: 'good', label: '合格（全流程）', color: '#1d4ed8' },
          { key: 'bad', label: '不良（工序）', color: '#d93b3b', area: false },
        ], { w: 900, h: 240, title: '产量与不良趋势' })}</div>
      </div>

      <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
        <div class="card"><div class="card-h"><h3>每日良率</h3></div>
          <div class="card-b">${UI.lineChart(yieldRows, [{ key: 'good', label: '良率 %', color: '#0f9d58' }], { w: 460, h: 210, title: '每日良率' })}</div></div>
        <div class="card"><div class="card-h"><h3>不良原因分布</h3></div>
          <div class="card-b">${UI.barChart(bad, { color: '#d93b3b', labelW: 84, title: '不良原因分布' })}</div></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>人员产出明细</h3><span class="small muted">按合格数排序</span></div>
        <div class="card-b tight">${UI.table([
          { t: '排名', f: (r, i) => `<b style="color:${i < 3 ? 'var(--primary)' : 'var(--text3)'}">${i + 1}</b>` },
          { t: '姓名', k: 'name' }, { t: '班组', f: (r) => UI.esc(r.team || '—') },
          { t: '合格数', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.good)}</span>` },
          { t: '不良数', f: (r) => `<span class="mono" style="color:var(--danger)">${UI.n2(r.bad)}</span>` },
          { t: '良率', f: (r) => { const p = UI.pct(r.good, r.good + r.bad); return `<span class="chip ${p >= 98 ? 'chip-ok' : p >= 95 ? 'chip-warn' : 'chip-danger'}">${UI.f1(p)}%</span>`; } },
          { t: '工时', f: (r) => `<span class="mono">${UI.f1(r.minu / 60)} h</span>` },
          { t: '件均工时', f: (r) => `<span class="mono">${r.good ? UI.f1(r.minu / r.good) : '—'} 分/件</span>` },
        ], rank, { emptyText: '所选区间没有报工数据' })}</div>
      </div>

      <div class="card">
        <div class="card-h"><h3>工单达成情况</h3><span class="small muted">未完成工单 ${orders.filter((o) => o.status !== 'done').length} 张</span></div>
        <div class="card-b tight">${UI.table([
          { t: '工单号', f: (r) => `<b class="link" data-o="${r.id}">${UI.esc(r.code)}</b>` },
          { t: '产品', k: 'product_name', f: (r) => UI.esc(r.product_name) },
          { t: '状态', f: (r) => UI.badge(r.status) },
          { t: '计划 / 完工', f: (r) => `<span class="mono">${UI.n2(r.qty_done)} / ${UI.n2(r.qty_plan)}</span>` },
          { t: '达成率', w: '160px', f: (r) => `<div class="row" style="gap:8px;flex-wrap:nowrap">
              ${UI.progress(UI.pct(r.qty_done, r.qty_plan), UI.pct(r.qty_done, r.qty_plan) >= 100 ? 'ok' : '')}
              <span class="small mono">${UI.f1(UI.pct(r.qty_done, r.qty_plan))}%</span></div>` },
          { t: '交期', f: (r) => `<span class="${r.plan_end < UI.today() && r.status !== 'done' ? 'chip chip-danger' : 'small muted'}">${UI.esc(r.plan_end)}</span>`, align: 'right' },
        ], orders)}</div>
      </div>`;

    el.querySelectorAll('[data-o]').forEach((a) => a.onclick = () => location.hash = '#/orders/' + a.dataset.o);
  },

  exportCsv() {
    const { trend, bad, rank, orders } = this.last || {};
    if (!trend) return UI.toast('请先等待数据加载完成', 'err');
    const lines = ['【每日产量】', '日期,合格数,不良数,工时(分钟)'];
    trend.forEach((r) => lines.push([r.d, r.good, r.bad, UI.f1(r.minu)].join(',')));
    lines.push('', '【不良原因】', '原因,数量');
    bad.forEach((r) => lines.push([r.name, r.qty].join(',')));
    lines.push('', '【人员产出】', '姓名,班组,合格数,不良数,工时(分钟)');
    rank.forEach((r) => lines.push([r.name, r.team || '', r.good, r.bad, UI.f1(r.minu)].join(',')));
    lines.push('', '【工单达成】', '工单号,产品,状态,计划数,完工数,达成率%,交期');
    orders.forEach((r) => lines.push([r.code, r.product_name, UI.STATUS[r.status] ? UI.STATUS[r.status][0] : r.status,
      r.qty_plan, r.qty_done, UI.pct(r.qty_done, r.qty_plan), r.plan_end].join(',')));

    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `生产报表_${UI.today()}.csv`;
    a.click();
    UI.toast('已导出 CSV', 'ok');
  },
};

Views.logs = {
  title: '操作日志',
  icon: 'log',
  async render(el) {
    const rows = await API.get('/logs?limit=200');
    el.innerHTML = `<div class="card"><div class="card-h"><h3>操作日志</h3><span class="small muted">最近 ${rows.length} 条</span></div>
      <div class="card-b tight">${UI.table([
        { t: '时间', f: (r) => `<span class="small mono">${UI.esc(r.created_at)}</span>`, w: '160px' },
        { t: '操作人', k: 'user_name', f: (r) => UI.esc(r.user_name || '系统'), w: '110px' },
        { t: '动作', f: (r) => `<span class="chip chip-blue">${UI.esc(r.action)}</span>`, w: '130px' },
        { t: '详情', f: (r) => UI.esc(r.detail || '') },
      ], rows, { emptyText: '暂无日志' })}</div></div>`;
  },
};
