/* 生产报工（移动端优先，支持扫码枪） */
window.Views = window.Views || {};
Views.report = {
  title: '生产报工',
  icon: 'report',
  data: { order: null, step: null },

  async render(el, orderId, stepId) {
    const meta = await API.get('/meta');
    this.meta = meta;
    el.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-b">
        <div class="scan-row">
          <input class="input" id="scan" placeholder="扫码或输入工单号 / 产品编码后回车" autocomplete="off">
          <button class="btn btn-primary" id="goScan">${UI.icon('search')}查询</button>
        </div>
        <div class="small muted" style="margin-top:8px">支持扫码枪直接扫描工单条码；也可从下方「我的在制工单」快速选择。</div>
      </div></div>
      <div id="pick"></div>
      <div id="panel"></div>`;

    const doScan = async () => {
      const v = el.querySelector('#scan').value.trim();
      if (!v) return;
      try {
        const r = await API.get('/scan/' + encodeURIComponent(v));
        if (r.type === 'order') this.showOrder(el, r.order.id, stepId);
        else if (r.orders.length === 1) this.showOrder(el, r.orders[0].id, stepId);
        else { this.renderPick(el, r.orders, '产品「' + r.product.name + '」的在制工单'); }
      } catch (e) { UI.toast(e.message, 'err'); el.querySelector('#scan').select(); }
    };
    el.querySelector('#goScan').onclick = doScan;
    el.querySelector('#scan').onkeydown = (e) => { if (e.key === 'Enter') doScan(); };

    if (orderId) this.showOrder(el, orderId, stepId);
    else {
      const list = await API.get('/orders?status=running,released');
      this.renderPick(el, list, '在制工单');
    }
  },

  renderPick(el, list, title) {
    el.querySelector('#pick').innerHTML = `
      <div class="card"><div class="card-h"><h3>${UI.esc(title)}</h3><span class="small muted">${list.length} 张</span></div>
      <div class="card-b">${list.length ? list.map((o) => `
        <div class="step-card" data-o="${o.id}">
          <div class="row" style="justify-content:space-between">
            <div>
              <b>${UI.esc(o.code)}</b>
              <div class="small muted">${UI.esc(o.product_name)} ${UI.esc(o.spec || '')} · 计划 ${UI.n2(o.qty_plan)}</div>
            </div>
            <div style="text-align:right">
              ${UI.badge(o.status)}
              <div class="small muted" style="margin-top:4px">完工 ${UI.n2(o.qty_done)}</div>
            </div>
          </div>
        </div>`).join('') : `<div class="empty">${UI.icon('empty')}<div>暂无可报工的工单</div></div>`}
      </div></div>`;
    el.querySelectorAll('[data-o]').forEach((c) => c.onclick = () => {
      location.hash = '#/report/' + c.dataset.o;
      this.showOrder(el, c.dataset.o);
    });
  },

  async showOrder(el, orderId, stepId) {
    const o = await API.get('/orders/' + orderId);
    this.data.order = o;
    el.querySelector('#pick').innerHTML = '';
    el.querySelector('#scan').value = o.code;
    const steps = o.steps.filter((s) => s.status !== 'done');
    const pick = steps.find((s) => s.id == stepId) || steps[0] || o.steps[o.steps.length - 1];
    this.data.step = pick;
    // 报工人：默认当前登录者（管理员等非班组人员排在最前，标注为「我」）
    const wks = this.meta.workers.some((w) => w.id === App.user.id)
      ? this.meta.workers
      : [{ id: App.user.id, name: App.user.name + '（我）' }].concat(this.meta.workers);

    el.querySelector('#panel').innerHTML = `
      <div class="report-hero">
        <div class="rh-code"><span>${UI.esc(o.code)}</span>${UI.badge(o.status)}</div>
        <h3>${UI.esc(o.product_name)} ${UI.esc(o.spec || '')}</h3>
        ${UI.progress(UI.pct(o.qty_done, o.qty_plan)).replace('<i ', '<i style="background:rgba(255,255,255,.85)" ')}
        <div class="rh-prog">
          <div><b>${UI.n2(o.qty_done)}</b><span>已完工</span></div>
          <div><b>${UI.n2(o.qty_plan - o.qty_done)}</b><span>剩余</span></div>
          <div><b>${UI.n2(o.qty_bad)}</b><span>累计不良</span></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>选择工序</h3></div>
        <div class="card-b">
          ${o.steps.map((s) => `
            <div class="step-card ${s.id === pick.id ? 'active' : ''} ${s.status === 'done' ? 'done' : ''}" data-s="${s.id}">
              <div class="row" style="justify-content:space-between">
                <div>
                  <b>${s.seq} ${UI.esc(s.process_name)}</b>
                  <div class="small muted">${UI.esc(s.wc_name || '未指定设备')} · 责任人 ${UI.esc(s.assignee_name || '未指派')}</div>
                </div>
                <div style="text-align:right">
                  ${UI.badge(s.status)}
                  <div class="small muted" style="margin-top:4px" class="mono">${UI.n2(s.qty_good)}/${UI.n2(s.qty_plan)}</div>
                </div>
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>报工录入</h3><span class="small muted">${UI.esc(pick.process_name)}</span></div>
        <div class="card-b">
          <div class="grid g2">
            <div class="field">
              <span class="label-req">合格数量</span>
              <div class="qty-box">
                <button class="qbtn" id="gDec">−</button>
                <input class="input" id="fGood" type="number" inputmode="numeric" min="0" value="0">
                <button class="qbtn" id="gInc">+</button>
              </div>
              <div class="small muted" id="leftTip"></div>
            </div>
            <div class="field">
              <span>不良数量</span>
              <div class="qty-box">
                <button class="qbtn" id="bDec">−</button>
                <input class="input" id="fBad" type="number" inputmode="numeric" min="0" value="0">
                <button class="qbtn" id="bInc">+</button>
              </div>
            </div>
          </div>
          <div class="grid g2">
            <label class="field"><span>不良原因</span>
              <select class="input" id="fReason"><option value="">无</option>${UI.options(this.meta.badReasons, '', 'name')}</select></label>
            <label class="field"><span>实动工时（分钟）</span>
              <input class="input" id="fMin" type="number" min="0" value="0"></label>
            <label class="field"><span>报工人</span>
              <select class="input" id="fWorker">${UI.options(wks, App.user.id, 'name')}</select></label>
            <label class="field"><span>报工日期</span>
              <input class="input" id="fDate" type="date" value="${UI.today()}"></label>
          </div>
          <label class="field"><span>备注</span><input class="input" id="fRemark" placeholder="选填"></label>
          <button class="btn btn-primary btn-lg btn-block" id="submit">${UI.icon('check')}提交报工</button>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-h"><h3>本工单最近报工</h3></div>
        <div class="card-b tight">${UI.table([
          { t: '时间', f: (r) => `<span class="small mono">${UI.esc(r.created_at.slice(5))}</span>` },
          { t: '工序', f: (r) => UI.esc(r.process_name || '—') },
          { t: '报工人', f: (r) => UI.esc(r.worker_name || '—') },
          { t: '合格', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.qty_good)}</span>` },
          { t: '不良', f: (r) => `<span class="mono" style="color:var(--danger)">${UI.n2(r.qty_bad)}</span>` },
        ], o.reports.slice(0, 8), { emptyText: '暂无记录' })}</div>
      </div>`;

    const bindQty = () => {
      const left = Math.max(0, pick.qty_plan - pick.qty_good);
      el.querySelector('#leftTip').innerHTML = `本工序剩余待报 <b>${UI.n2(left)}</b> 件`;
    };
    bindQty();

    const g = el.querySelector('#fGood'), b = el.querySelector('#fBad');
    const add = (input, n) => { input.value = Math.max(0, (Number(input.value) || 0) + n); };
    el.querySelector('#gDec').onclick = () => add(g, -10);
    el.querySelector('#gInc').onclick = () => add(g, 10);
    el.querySelector('#bDec').onclick = () => add(b, -1);
    el.querySelector('#bInc').onclick = () => add(b, 1);

    el.querySelectorAll('[data-s]').forEach((c) => c.onclick = () => {
      this.showOrder(el, orderId, c.dataset.s);
    });

    el.querySelector('#submit').onclick = async () => {
      const payload = {
        order_id: o.id,
        order_step_id: pick.id,
        worker_id: Number(el.querySelector('#fWorker').value) || App.user.id,
        work_center_id: pick.work_center_id,
        qty_good: Number(g.value) || 0,
        qty_bad: Number(b.value) || 0,
        bad_reason: el.querySelector('#fReason').value,
        work_min: Number(el.querySelector('#fMin').value) || 0,
        report_date: el.querySelector('#fDate').value,
        remark: el.querySelector('#fRemark').value,
      };
      if (payload.qty_good + payload.qty_bad <= 0) throw UI.toast('请填写合格数或不良数', 'err');
      try {
        await API.post('/reports', payload);
        UI.toast('报工成功', 'ok');
        this.showOrder(el, orderId, pick.id);
      } catch (e) { UI.toast(e.message, 'err'); }
    };
  },
};
