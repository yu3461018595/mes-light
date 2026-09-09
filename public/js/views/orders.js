/* 工单管理 */
window.Views = window.Views || {};

/* 关闭工单时询问原因（选填），返回原因字符串或 null（取消） */
function askCloseReason() {
  return new Promise((resolve) => {
    const m = UI.modal({
      title: '关闭工单',
      body: `<p class="small muted" style="margin-bottom:10px">关闭后工单不可再报工。可填写关闭原因（选填）。</p>
        <label class="field"><span>关闭原因</span>
          <textarea class="input" id="cr" rows="3" placeholder="如：客户取消 / 物料不足 / 转单生产等"></textarea></label>`,
      onOk: (mask) => { resolve(mask.querySelector('#cr').value.trim()); },
    });
    m.el.addEventListener('click', (e) => { if (e.target === m.el) resolve(null); });
    m.el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(null)));
  });
}

Views.orders = {
  title: '工单管理',
  icon: 'orders',
  state: { status: '', keyword: '' },

  async render(el, id) {
    if (id) return this.detail(el, id);
    const meta = await API.get('/meta');
    this.meta = meta;
    const s = this.state;

    el.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <div class="tabs" style="margin:0;border:none">
          ${[['', '全部'], ['created', '待下发'], ['released', '已下发'], ['running,paused', '生产中'], ['done', '已完成']]
            .map(([v, t]) => `<div class="tab ${s.status === v ? 'active' : ''}" data-st="${v}">${t}</div>`).join('')}
        </div>
        <div class="row" style="gap:8px">
          <input class="input" id="kw" placeholder="搜索工单号 / 产品 / 客户" value="${UI.esc(s.keyword)}" style="width:210px">
          ${App.canEdit() ? `<button class="btn btn-primary" id="newOrder">${UI.icon('plus')}新建工单</button>` : ''}
        </div>
      </div>
      <div class="card"><div class="card-b tight"><div id="list">加载中…</div></div></div>`;

    el.querySelectorAll('[data-st]').forEach((t) => t.onclick = () => { s.status = t.dataset.st; this.render(el); });
    let timer;
    el.querySelector('#kw').oninput = (e) => {
      s.keyword = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(() => this.loadList(el), 260);
    };
    if (el.querySelector('#newOrder')) el.querySelector('#newOrder').onclick = () => this.form();
    await this.loadList(el);
  },

  async loadList(el) {
    const s = this.state;
    const q = [];
    if (s.status) q.push('status=' + encodeURIComponent(s.status));
    if (s.keyword) q.push('keyword=' + encodeURIComponent(s.keyword));
    const list = await API.get('/orders' + (q.length ? '?' + q.join('&') : ''));
    const box = el.querySelector('#list');
    box.innerHTML = UI.table([
      { t: '工单号', f: (r) => `<b class="link" data-id="${r.id}">${UI.esc(r.code)}</b>
          <div class="small muted">${UI.esc(r.customer_name || '无客户')}</div>` },
      { t: '产品', f: (r) => `${UI.esc(r.product_name)}<div class="small muted">${UI.esc(r.spec || r.product_code)}</div>` },
      { t: '数量', f: (r) => `<span class="mono">${UI.n2(r.qty_plan)}</span> <span class="small muted">${UI.esc(r.unit)}</span>` },
      { t: '完工 / 不良', f: (r) => `<span class="mono">${UI.n2(r.qty_done)}</span> <span class="small" style="color:var(--danger)">/${UI.n2(r.qty_bad)}</span>` },
      { t: '进度', w: '140px', f: (r) => `<div class="row" style="gap:8px;flex-wrap:nowrap">
          ${UI.progress(UI.pct(r.qty_done, r.qty_plan), r.qty_done >= r.qty_plan ? 'ok' : '')}
          <span class="small mono">${UI.f1(UI.pct(r.qty_done, r.qty_plan))}%</span></div>` },
      { t: '优先级', f: (r) => UI.prioChip(r.priority) },
      { t: '交期', f: (r) => `<span class="${r.plan_end < UI.today() && !['done', 'closed'].includes(r.status) ? 'chip chip-danger' : 'small muted'}">${UI.esc(r.plan_end)}</span>` },
      { t: '状态', f: (r) => UI.badge(r.status), align: 'right' },
    ], list, { emptyText: '没有符合条件的工单' });
    box.querySelectorAll('[data-id]').forEach((a) => a.onclick = () => location.hash = '#/orders/' + a.dataset.id);
  },

  /* ---------- 新建 / 编辑 ---------- */
  async form(id) {
    const meta = await API.get('/meta');
    let o = null;
    if (id) o = await API.get('/orders/' + id);
    const routeOf = (pid) => meta.routes.find((r) => r.product_id == pid);

    const body = `
      <div class="grid g2">
        <label class="field"><span class="label-req">产品</span>
          <select class="input" id="fProduct">${UI.options(meta.products, o ? o.product_id : '', 'name')}</select></label>
        <label class="field"><span class="label-req">工艺路线</span>
          <select class="input" id="fRoute"></select></label>
        <label class="field"><span>客户</span>
          <select class="input" id="fCustomer"><option value="">无</option>${UI.options(meta.customers, o ? o.customer_id : '', 'name')}</select></label>
        <label class="field"><span class="label-req">计划数量</span>
          <input class="input" id="fQty" type="number" min="1" value="${o ? o.qty_plan : 100}"></label>
        <label class="field"><span>优先级</span>
          <select class="input" id="fPrio">
            <option value="1"${o && o.priority == 1 ? ' selected' : ''}>高</option>
            <option value="2"${!o || o.priority == 2 ? ' selected' : ''}>中</option>
            <option value="3"${o && o.priority == 3 ? ' selected' : ''}>低</option></select></label>
        <label class="field"><span>备注</span><input class="input" id="fRemark" value="${o ? UI.esc(o.remark || '') : ''}"></label>
        <label class="field"><span>计划开工</span><input class="input" type="date" id="fStart" value="${o ? o.plan_start : UI.today()}"></label>
        <label class="field"><span>计划完工</span><input class="input" type="date" id="fEnd" value="${o ? o.plan_end : UI.today()}"></label>
      </div>
      ${o ? '' : `<div class="small muted">工单号自动生成；保存后按工艺路线展开工序，可再派工到人和设备。</div>`}`;

    const m = UI.modal({
      title: id ? '编辑工单 ' + o.code : '新建工单',
      body,
      onMount: (mask) => {
        const syncRoutes = () => {
          const pid = mask.querySelector('#fProduct').value;
          const rs = meta.routes.filter((r) => r.product_id == pid);
          mask.querySelector('#fRoute').innerHTML = rs.length
            ? rs.map((r) => `<option value="${r.id}">${UI.esc(r.code)} · ${UI.esc(r.name)}</option>`).join('')
            : '<option value="">该产品暂无工艺路线</option>';
          if (o && rs.some((r) => r.id == o.route_id)) mask.querySelector('#fRoute').value = o.route_id;
        };
        mask.querySelector('#fProduct').onchange = syncRoutes;
        syncRoutes();
      },
      onOk: async (mask) => {
        const payload = {
          product_id: mask.querySelector('#fProduct').value,
          route_id: mask.querySelector('#fRoute').value,
          customer_id: mask.querySelector('#fCustomer').value || null,
          qty_plan: Number(mask.querySelector('#fQty').value),
          priority: Number(mask.querySelector('#fPrio').value),
          remark: mask.querySelector('#fRemark').value,
          plan_start: mask.querySelector('#fStart').value,
          plan_end: mask.querySelector('#fEnd').value,
        };
        if (!payload.route_id) throw new Error('该产品没有工艺路线，请先到基础数据维护');
        if (!(payload.qty_plan > 0)) throw new Error('计划数量必须大于 0');
        if (id) await API.put('/orders/' + id, payload);
        else {
          const r = await API.post('/orders', payload);
          UI.toast('工单已创建：' + r.code, 'ok');
        }
        location.hash = '#/orders';
        Views.orders.render(document.getElementById('view'));
      },
    });
    if (id) {
      // 编辑时不允许改产品/路线（避免与已有报工冲突）
      m.el.querySelector('#fProduct').disabled = true;
      m.el.querySelector('#fRoute').disabled = true;
    }
  },

  /* ---------- 详情 ---------- */
  async detail(el, id) {
    const [o, meta] = await Promise.all([API.get('/orders/' + id), API.get('/meta')]);
    const p = UI.pct(o.qty_done, o.qty_plan);
    const canEdit = App.canEdit();

    const actions = {
      created: [['released', '下发工单', 'btn-primary']],
      released: [['running', '开始生产', 'btn-ok']],
      running: [['paused', '暂停', 'btn'], ['done', '完工', 'btn-ok'], ['closed', '关闭工单', 'btn']],
      paused: [['running', '恢复生产', 'btn-ok'], ['closed', '关闭工单', 'btn']],
      done: [['closed', '关闭工单', 'btn']],
      closed: [],
    }[o.status] || [];

    el.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <button class="btn btn-sm" id="back">${UI.icon('back')}返回列表</button>
        <div class="spacer"></div>
        ${canEdit ? actions.map((a) => `<button class="btn ${a[2]}" data-status="${a[0]}">${a[1]}</button>`).join('') : ''}
        ${canEdit ? `<button class="btn btn-sm" id="qrOrder">${UI.icon('scan')}报工二维码</button>` : ''}
        ${canEdit ? `<button class="btn btn-sm" id="edit">编辑</button>` : ''}
        ${App.isAdmin() ? `<button class="btn btn-sm btn-danger" id="del">删除</button>` : ''}
      </div>

      <div class="card" style="margin-bottom:14px"><div class="card-b">
        <div class="row" style="align-items:flex-start;gap:22px">
          ${UI.ring(p, { size: 118, label: '达成率' })}
          <div style="flex:1;min-width:200px">
            <div class="row" style="gap:10px">
              <h2 style="font-size:22px;font-weight:700">${UI.esc(o.code)}</h2>
              ${UI.badge(o.status)}${UI.prioChip(o.priority)}
              ${o.plan_end < UI.today() && !['done', 'closed'].includes(o.status) ? '<span class="chip chip-danger">已逾期</span>' : ''}
            </div>
            <div class="muted" style="margin-top:6px">${UI.esc(o.product_name)} ${UI.esc(o.spec || '')} · ${UI.esc(o.route_name)}</div>
            <div class="grid g4" style="gap:10px;margin-top:14px">
              <div><div class="small muted">计划数量</div><div class="big-num">${UI.n2(o.qty_plan)}</div></div>
              <div><div class="small muted">完工数量</div><div class="big-num" style="color:var(--ok)">${UI.n2(o.qty_done)}</div></div>
              <div><div class="small muted">不良数量</div><div class="big-num" style="color:var(--danger)">${UI.n2(o.qty_bad)}</div></div>
              <div><div class="small muted">累计工时</div><div class="big-num">${UI.f1((o.work_min || 0) / 60)}<span style="font-size:14px"> h</span></div></div>
            </div>
          </div>
        </div>
        <div class="grid g4" style="gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line2)">
          <div class="small"><span class="muted">客户：</span>${UI.esc(o.customer_name || '—')}</div>
          <div class="small"><span class="muted">计划开工：</span>${UI.esc(o.plan_start)}</div>
          <div class="small"><span class="muted">计划完工：</span>${UI.esc(o.plan_end)}</div>
          <div class="small"><span class="muted">实际开工：</span>${UI.esc(o.start_time || '—')}</div>
          <div class="small"><span class="muted">实际完工：</span>${UI.esc(o.finish_time || '—')}</div>
          <div class="small"><span class="muted">备注：</span>${UI.esc(o.remark || '—')}</div>
          ${o.close_reason ? `<div class="small"><span class="muted">关闭原因：</span><span class="chip chip-gray">${UI.esc(o.close_reason)}</span></div>` : ''}
        </div>
      </div></div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>工序进度</h3><span class="small muted">共 ${o.steps.length} 道工序</span></div>
        <div class="card-b tight">
          ${UI.table([
            { t: '序', f: (r) => `<span class="mono muted">${r.seq}</span>` },
            { t: '工序', f: (r) => `<b>${UI.esc(r.process_name)}</b><div class="small muted">${UI.esc(r.process_code)}</div>` },
            { t: '工作中心', f: (r) => UI.esc(r.wc_name || '—') },
            { t: '指派班组', f: (r) => r.assignee_team ? UI.esc(r.assignee_team) : '<span class="muted">暂无</span>' },
            { t: '合格', f: (r) => `<span class="mono">${UI.n2(r.qty_good)}</span>` },
            { t: '不良', f: (r) => `<span class="mono" style="color:var(--danger)">${r.qty_bad ? UI.n2(r.qty_bad) : '0'}</span>` },
            { t: '进度', w: '130px', f: (r) => `<div class="row" style="gap:8px;flex-wrap:nowrap">
                ${UI.progress(UI.pct(r.qty_good, r.qty_plan), r.status === 'done' ? 'ok' : '')}
                <span class="small mono">${UI.f1(UI.pct(r.qty_good, r.qty_plan))}%</span></div>` },
            { t: '状态', f: (r) => UI.badge(r.status) },
            { t: '操作', align: 'right', f: (r) => `
                <button class="btn btn-sm btn-ok" data-report="${r.id}" ${r.status === 'done' ? 'disabled' : ''}>报工</button>
                ${canEdit ? `<button class="btn btn-sm" data-assign="${r.id}">指派班组</button>` : ''}` },
          ], o.steps)}
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>报工流水</h3><span class="small muted">最近 100 条</span></div>
        <div class="card-b tight">
          ${UI.table([
            { t: '时间', f: (r) => `<span class="small mono">${UI.esc(r.created_at)}</span>` },
            { t: '工序', k: 'process_name', f: (r) => UI.esc(r.process_name || '—') },
            { t: '报工人', k: 'worker_name', f: (r) => UI.esc(r.worker_name || '—') },
            { t: '设备', k: 'wc_name', f: (r) => UI.esc(r.wc_name || '—') },
            { t: '合格', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.qty_good)}</span>` },
            { t: '不良', f: (r) => `<span class="mono" style="color:var(--danger)">${UI.n2(r.qty_bad)}</span>` },
            { t: '不良原因', f: (r) => r.bad_reason ? `<span class="chip chip-danger">${UI.esc(r.bad_reason)}</span>` : '<span class="muted">—</span>' },
            { t: '工时', f: (r) => `<span class="small mono">${UI.f1(r.work_min / 60)} h</span>` },
            { t: '', align: 'right', f: (r) => canEdit ? `<button class="btn btn-sm btn-ghost" data-del="${r.id}">撤销</button>` : '' },
          ], o.reports, { emptyText: '还没有报工记录' })}
        </div>
      </div>`;

    el.querySelector('#back').onclick = () => location.hash = '#/orders';
    el.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
      const st = b.dataset.status;
      if (st === 'closed') {
        const reason = await askCloseReason();
        if (reason === null) return;
        await API.patch('/orders/' + id + '/status', { status: 'closed', close_reason: reason });
      } else {
        await API.patch('/orders/' + id + '/status', { status: st });
      }
      UI.toast('状态已更新', 'ok');
      App.render();
    });
    const qrBtn = el.querySelector('#qrOrder');
    if (qrBtn) qrBtn.onclick = async () => {
      try {
        const d = await API.get('/qr/order/' + id);
        UI.qrModal('工单报工码 · ' + d.order.code, {
          svg: d.svg, url: d.url, subtitle: d.order.product_name + ' · 微信扫一扫即可报工', fileName: '工单_' + d.order.code,
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    el.querySelectorAll('[data-report]').forEach((b) => b.onclick = () => location.hash = '#/report/' + id + '/' + b.dataset.report);
    el.querySelectorAll('[data-assign]').forEach((b) => b.onclick = () => {
      const st = o.steps.find((x) => x.id == b.dataset.assign);
      const teams = ((meta.teams && meta.teams.length ? meta.teams : (o.teams || [])).map((t) => (t && t.team) ? t.team : t));
      UI.modal({
        title: '指派班组 · ' + st.process_name,
        body: `<label class="field"><span>指派班组</span>
            <select class="input" id="aTeam"><option value="">不指定（全员可报工）</option>${teams.map((t) => `<option value="${UI.esc(t)}"${st.assignee_team === t ? ' selected' : ''}>${UI.esc(t)}</option>`).join('')}</select></label>
          <label class="field"><span>工作中心 / 设备</span>
            <select class="input" id="aWc"><option value="">不指定</option>${UI.options(meta.workCenters, st.work_center_id || '', 'name')}</select></label>`,
        onOk: async (mask) => {
          await API.patch(`/orders/${id}/steps/${st.id}`, {
            assignee_team: mask.querySelector('#aTeam').value || null,
            work_center_id: mask.querySelector('#aWc').value || null,
          });
          UI.toast('已指派班组', 'ok');
          App.render();
        },
      });
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('撤销后将扣减该工序的累计数量，确定继续？', '撤销报工'))) return;
      await API.del('/reports/' + b.dataset.del);
      UI.toast('已撤销', 'ok');
      App.render();
    });
    const ed = el.querySelector('#edit');
    if (ed) ed.onclick = () => this.form(id);
    const dl = el.querySelector('#del');
    if (dl) dl.onclick = async () => {
      if (!(await UI.confirm('删除工单将同时删除其工序与报工记录，确定删除？', '删除工单'))) return;
      await API.del('/orders/' + id);
      UI.toast('已删除', 'ok');
      location.hash = '#/orders';
    };
  },
};
