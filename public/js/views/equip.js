/* 设备管理：设备台账 + 点检记录（P1 升级），点检异常可一键生成质量异常单 */
window.Views = window.Views || {};
Views.equip = {
  title: '设备管理',
  icon: 'dash',

  async render(el) {
    const [eqs, canEdit] = [await API.get('/equipments'), App.canEdit()];
    this.data = eqs;
    const today = new Date().toISOString().slice(0, 10);
    const util = await API.get('/stats/equip_util?days=' + (this.utilDays || 7)).catch(() => null);
    el.innerHTML = `
      ${util ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h">
          <h3>设备稼动分析（近 ${util.days} 天）</h3>
          <div class="tabs" style="border-bottom:none;margin-bottom:0">
            <div class="tab ${this.utilDays !== 30 ? 'active' : ''}" data-ud="7" style="padding:6px 12px">近 7 天</div>
            <div class="tab ${this.utilDays === 30 ? 'active' : ''}" data-ud="30" style="padding:6px 12px">近 30 天</div>
          </div>
        </div>
        <div class="card-b">
          <div class="grid g4" style="margin-bottom:12px">
            <div class="stat"><div class="stat-l">平均稼动率</div>
              <div class="stat-v" style="color:${util.summary.avg_util >= 60 ? 'var(--ok)' : util.summary.avg_util >= 30 ? 'var(--warn)' : 'var(--danger)'}">${UI.f1(util.summary.avg_util)}%</div>
              <div class="stat-s">${util.summary.used_machines}/${util.summary.total_machines} 台设备有报工</div></div>
            <div class="stat"><div class="stat-l">实动工时合计</div><div class="stat-v">${UI.f1(util.summary.total_hours)}<span class="small muted"> h</span></div>
              <div class="stat-s">按 8h/天班制基准折算</div></div>
            <div class="stat"><div class="stat-l">加工合格</div><div class="stat-v" style="color:var(--ok)">${UI.n2(util.summary.good)}</div>
              <div class="stat-s">件 · 经该设备报工</div></div>
            <div class="stat"><div class="stat-l">综合合格率</div><div class="stat-v">${UI.f1(util.summary.good + util.summary.bad ? util.summary.good * 100 / (util.summary.good + util.summary.bad) : 100)}%</div>
              <div class="stat-s">不良 ${UI.n2(util.summary.bad)} 件</div></div>
          </div>
          ${UI.table([
            { t: '设备', f: (r) => `<b>${UI.esc(r.code)}</b> <span class="small muted">${UI.esc(r.name)}</span>` },
            { t: '车间', f: (r) => UI.esc(r.workshop || '—') },
            { t: '实动工时', f: (r) => `<span class="mono">${UI.f1(r.minu / 60)}</span> h` },
            { t: '稼动率', f: (r) => `${UI.progress(r.util_pct, r.util_pct >= 60 ? 'ok' : r.util_pct >= 30 ? 'warn' : 'danger')} <span class="mono small">${UI.f1(r.util_pct)}%</span>` },
            { t: '合格/不良', f: (r) => r.cnt ? `<span class="mono" style="color:var(--ok)">${UI.n2(r.good)}</span> / <span class="mono" style="color:var(--danger)">${UI.n2(r.bad)}</span>` : '<span class="muted">未使用</span>' },
          ], util.rows, { emptyText: '暂无设备' })}
          <div class="small muted" style="margin-top:8px">稼动率 = 设备实动工时 ÷（${util.days} 天 × 8 小时班制基准），上限 100%；数据来自工序报工自动累计，无需额外录入。</div>
        </div>
      </div>` : ''}
      <div class="card">
        <div class="card-h">
          <h3>设备台账（${eqs.length} 台）</h3>
          <div style="display:flex;gap:8px">
            ${canEdit ? `<button class="btn btn-primary btn-sm" id="eqAdd">${UI.icon('plus')}新增设备</button>` : ''}
          </div>
        </div>
        <div class="card-b tight">
          ${eqs.length ? UI.table([
            { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` },
            { t: '名称', f: (r) => UI.esc(r.name) },
            { t: '型号', f: (r) => UI.esc(r.model || '—') },
            { t: '位置', f: (r) => UI.esc(r.location || '—') },
            { t: '状态', f: (r) => this.statusChip(r.status) },
            { t: '点检周期', f: (r) => r.check_cycle > 0 ? `<span class="mono">${r.check_cycle}</span> 天` : '<span class="muted">不定期</span>' },
            { t: '最近点检', f: (r) => this.lastCheck(r, today) },
            { t: '操作', align: 'right', w: '270px', f: (r) => this.opButtons(r, canEdit) },
          ], eqs) : `<div class="muted" style="padding:22px 6px">暂无设备。${canEdit ? '点右上角「新增设备」建立台账；生成二维码贴到机台，员工扫码即可点检。' : '请联系管理员建立设备台账。'}</div>`}
        </div>
      </div>
      <p class="small muted" style="margin-top:10px">点检规则：异常点检可勾选「生成质量异常单」，走统一异常口径（非检验员上报为待定级，申报重大时通知检验员及时定级；检验员可直接定级）。</p>`;

    if (canEdit) el.querySelector('#eqAdd').onclick = () => this.form();
    el.querySelectorAll('[data-ud]').forEach((b) => b.onclick = () => { this.utilDays = Number(b.dataset.ud); this.render(el); });
    el.querySelectorAll('[data-check]').forEach((b) => b.onclick = () => this.checkForm(Number(b.dataset.check)));
    el.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => this.history(Number(b.dataset.hist)));
    if (canEdit) el.querySelectorAll('[data-eqr]').forEach((b) => b.onclick = async () => {
      try {
        const d = await API.get('/qr/equipment/' + b.dataset.eqr);
        UI.qrModal('设备点检码 · ' + d.equipment.name, {
          svg: d.svg, url: d.url,
          subtitle: '微信/APP 扫一扫即可打开点检页面',
          fileName: '设备_' + d.equipment.name,
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    if (canEdit) el.querySelectorAll('[data-eedit]').forEach((b) => b.onclick = () => this.form(Number(b.dataset.eedit)));
    if (canEdit) el.querySelectorAll('[data-edel]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该设备？其点检记录将一并删除。'))) return;
      try { await API.del('/equipments/' + b.dataset.edel); UI.toast('已删除', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  statusChip(s) {
    const m = { idle: ['空闲', 'chip-gray'], running: ['运转', 'chip-ok'], fault: ['故障', 'chip-danger'], maintain: ['保养', 'chip-warn'] }[s] || [s, 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },

  lastCheck(r, today) {
    if (!r.last_check_at) return '<span class="chip chip-gray">未点检</span>';
    const d = String(r.last_check_at).slice(0, 10);
    if (r.check_cycle > 0) {
      const due = new Date(d); due.setDate(due.getDate() + r.check_cycle);
      const overdue = due.toISOString().slice(0, 10) < today;
      return `${UI.esc(d)}${overdue ? ' <span class="chip chip-danger">已超期</span>' : ''}`;
    }
    return UI.esc(d);
  },

  opButtons(r, canEdit) {
    return `<button class="btn btn-sm btn-primary" data-check="${r.id}">点检</button>`
      + ` <button class="btn btn-sm" data-hist="${r.id}">记录</button>`
      + (canEdit ? ` <button class="btn btn-sm" data-eqr="${r.id}">二维码</button>`
        + ` <button class="btn btn-sm" data-eedit="${r.id}">编辑</button>`
        + ` <button class="btn btn-sm btn-danger" data-edel="${r.id}">删除</button>` : '');
  },

  /* 新增/编辑设备 */
  async form(id) {
    const row = id ? this.data.find((r) => r.id === id) : {};
    UI.modal({
      title: (id ? '编辑' : '新增') + '设备',
      body: `<div class="grid g2">
        <label class="field"><span class="label-req">设备编码</span><input class="input" data-k="code" value="${UI.esc(row.code || '')}" required placeholder="如 EQ-001"></label>
        <label class="field"><span class="label-req">设备名称</span><input class="input" data-k="name" value="${UI.esc(row.name || '')}" required placeholder="如 CNC 车床 1#"></label>
        <label class="field"><span>规格型号</span><input class="input" data-k="model" value="${UI.esc(row.model || '')}"></label>
        <label class="field"><span>安装位置</span><input class="input" data-k="location" value="${UI.esc(row.location || '')}" placeholder="如 一车间 A 区"></label>
        <label class="field"><span>状态</span><select class="input" data-k="status">${UI.options([{ id: 'idle', name: '空闲' }, { id: 'running', name: '运转' }, { id: 'fault', name: '故障' }, { id: 'maintain', name: '保养' }], row.status || 'idle', 'name')}</select></label>
        <label class="field"><span>点检周期(天)</span><input class="input" type="number" min="0" step="1" data-k="check_cycle" value="${row.check_cycle == null ? 1 : row.check_cycle}"><span class="small muted">0 = 不定期；设为 1 即每日点检，超期列表会标红</span></label>
      </div>
      <label class="field"><span>备注</span><input class="input" data-k="remark" value="${UI.esc(row.remark || '')}"></label>`,
      onOk: async (mask) => {
        const g = (k) => { const e2 = mask.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
        if (!g('code').trim() || !g('name').trim()) throw new Error('请填写设备编码与名称');
        const payload = { code: g('code').trim(), name: g('name').trim(), model: g('model'), location: g('location'), status: g('status'), check_cycle: Number(g('check_cycle')) || 0, remark: g('remark') };
        if (id) await API.put('/equipments/' + id, payload); else await API.post('/equipments', payload);
        UI.toast('已保存', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  /* 点检打分 */
  checkForm(id) {
    const r = this.data.find((x) => x.id === id);
    const isInsp = App.isQC();
    const m = UI.modal({
      title: `设备点检 · ${r.code} ${r.name}`,
      body: `<div class="grid g2">
        <label class="field"><span>点检结果</span><select class="input" data-k="result"><option value="ok">✅ 正常</option><option value="abnormal">⚠️ 异常</option></select></label>
        <label class="field"><span>设备状态（可选同步）</span><select class="input" data-k="fault"><option value="">不更改</option><option value="1">转为「故障」</option><option value="running">转为「运转」</option></select></label>
      </div>
      <label class="field"><span>点检说明 / 异常描述</span><input class="input" data-k="note" placeholder="如：主轴异响、漏油、导轨磨损"></label>
      <div id="abArea" style="display:none;margin-top:4px">
        <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="eqReport" checked style="width:auto"> 同时生成质量异常单（走统一异常上报口径）</label>
        <label class="field"><span>异常等级（${isInsp ? '检验员可直接定级' : '申报等级，重大异常将通知检验员及时定级'}）</span>
          <select class="input" data-k="level"><option value="major">严重</option><option value="critical">致命</option><option value="minor">轻微</option></select></label>
      </div>`,
      onOk: async (mask) => {
        const g = (k) => { const e2 = mask.querySelector(`[data-k="${k}"]`); return e2 ? e2.value : ''; };
        const payload = { result: g('result'), note: g('note').trim() };
        if (g('fault')) payload.fault = g('fault') === '1';
        if (g('result') === 'abnormal' && mask.querySelector('#eqReport').checked) {
          payload.report = 1; payload.level = g('level');
        }
        const res = await API.post('/equipments/' + id + '/check', payload);
        if (res && res.issue) UI.toast(`已记录异常，并生成异常单 ${res.issue.code}（${res.issue.level === 'pending' ? '待检验员定级' : '等级：' + res.issue.level}）`, 'ok');
        else UI.toast('点检已记录', 'ok');
        this.render(document.getElementById('view'));
      },
    });
    // 切换结果时显示/隐藏异常联动区
    const sel = m.el.querySelector('select[data-k="result"]');
    sel.onchange = () => { m.el.querySelector('#abArea').style.display = sel.value === 'abnormal' ? '' : 'none'; };
  },

  /* 点检历史 */
  async history(id) {
    const r = this.data.find((x) => x.id === id);
    const list = await API.get('/equipments/' + id + '/checks');
    const lvChip = { pending: ['待定级', 'chip-gray'], minor: ['轻微', 'chip-info'], major: ['严重', 'chip-warn'], critical: ['致命', 'chip-danger'] };
    UI.modal({
      title: `点检记录 · ${r.code} ${r.name}`,
      size: 'lg',
      body: list.length ? `<div class="tight">${UI.table([
        { t: '时间', f: (c) => `<span class="mono">${UI.esc(String(c.created_at).slice(0, 16))}</span>` },
        { t: '结果', f: (c) => c.result === 'ok' ? '<span class="chip chip-ok">正常</span>' : '<span class="chip chip-danger">异常</span>' },
        { t: '点检人', k: 'checked_name' },
        { t: '说明', f: (c) => UI.esc(c.note || '—') },
        { t: '关联异常单', f: (c) => c.issue_code
            ? `<span class="chip ${lvChip[c.issue_level] ? lvChip[c.issue_level][1] : 'chip-gray'}">${UI.esc(c.issue_code)}</span>`
            : '—' },
      ], list)}</div>` : '<div class="muted" style="padding:18px 4px">暂无点检记录</div>',
      footer: '<button class="btn" data-close>关闭</button>',
    });
  },
};
