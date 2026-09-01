/* 基础数据：产品 / 工序 / 工作中心 / 工艺路线 / 客户 / 人员 / 不良原因 */
window.Views = window.Views || {};
Views.basic = {
  title: '基础数据',
  icon: 'basic',
  tab: 'products',

  tabs: [
    ['products', '产品'], ['processes', '工序'], ['workCenters', '工作中心'],
    ['routes', '工艺路线'], ['customers', '客户'], ['users', '人员'], ['badReasons', '不良原因'],
  ],

  /* 资源配置：接口 + 列表列 + 表单字段 */
  conf() {
    const M = this.meta;
    return {
      products: {
        api: '/products', name: '产品',
        cols: [
          { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` },
          { t: '名称', k: 'name' }, { t: '规格', f: (r) => UI.esc(r.spec || '—') },
          { t: '单位', k: 'unit' }, { t: '单价(¥)', f: (r) => `<span class="mono">${UI.n2(r.price)}</span>` },
        ],
        fields: [
          { k: 'code', t: '产品编码', req: 1 }, { k: 'name', t: '产品名称', req: 1 },
          { k: 'spec', t: '规格型号' }, { k: 'unit', t: '单位', def: '件' },
          { k: 'price', t: '单价(元)', type: 'number' },
        ],
      },
      processes: {
        api: '/processes', name: '工序',
        cols: [
          { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` }, { t: '名称', k: 'name' },
          { t: '标准工时(分/件)', f: (r) => `<span class="mono">${UI.f1(r.std_time)}</span>` },
          { t: '计件单价(¥)', f: (r) => `<span class="mono">${UI.f1(r.std_price)}</span>` },
          { t: '备注', f: (r) => UI.esc(r.remark || '—') },
        ],
        fields: [
          { k: 'code', t: '工序编码', req: 1 }, { k: 'name', t: '工序名称', req: 1 },
          { k: 'std_time', t: '标准工时(分钟/件)', type: 'number' },
          { k: 'std_price', t: '计件单价(元)', type: 'number' }, { k: 'remark', t: '备注' },
        ],
      },
      workCenters: {
        api: '/work_centers', name: '工作中心',
        cols: [
          { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` }, { t: '名称', k: 'name' },
          { t: '车间', f: (r) => UI.esc(r.workshop || '—') },
          { t: '状态', f: (r) => { const m = UI.WC_STATUS[r.status] || ['—', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; } },
        ],
        fields: [
          { k: 'code', t: '编码', req: 1 }, { k: 'name', t: '名称', req: 1 }, { k: 'workshop', t: '所属车间' },
          { k: 'status', t: '状态', type: 'select', opts: [['idle', '空闲'], ['running', '运转'], ['fault', '故障'], ['maintain', '保养']] },
        ],
      },
      customers: {
        api: '/customers', name: '客户',
        cols: [
          { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` }, { t: '名称', k: 'name' },
          { t: '联系人', f: (r) => UI.esc(r.contact || '—') }, { t: '电话', f: (r) => UI.esc(r.phone || '—') },
        ],
        fields: [
          { k: 'code', t: '客户编码', req: 1 }, { k: 'name', t: '客户名称', req: 1 },
          { k: 'contact', t: '联系人' }, { k: 'phone', t: '联系电话' },
        ],
      },
      badReasons: {
        api: '/bad_reasons', name: '不良原因',
        cols: [{ t: '名称', k: 'name' }],
        fields: [{ k: 'name', t: '不良原因', req: 1 }],
      },
      users: {
        api: '/users', name: '人员',
        cols: [
          { t: '账号', f: (r) => `<b>${UI.esc(r.username)}</b>` }, { t: '姓名', k: 'name' },
          { t: '角色', f: (r) => ({ admin: '<span class="chip chip-blue">管理员</span>', leader: '<span class="chip chip-info">班组长</span>', worker: '<span class="chip chip-gray">操作工</span>' }[r.role] || r.role) },
          { t: '班组', f: (r) => UI.esc(r.team || '—') },
          { t: '默认设备', f: (r) => UI.esc(r.wc_name || '—') },
          { t: '状态', f: (r) => r.active ? '<span class="chip chip-ok">启用</span>' : '<span class="chip chip-gray">停用</span>' },
        ],
        fields: [
          { k: 'username', t: '登录账号', req: 1 }, { k: 'name', t: '姓名', req: 1 },
          { k: 'password', t: '密码', type: 'password', hint: '新增时留空默认 123456；编辑时留空表示不修改' },
          { k: 'role', t: '角色', type: 'select', opts: [['admin', '管理员'], ['leader', '班组长'], ['worker', '操作工']] },
          { k: 'team', t: '班组' },
          { k: 'work_center_id', t: '默认工作中心', type: 'select', opts: () => [[null, '不设置']].concat(M.workCenters.map((w) => [w.id, w.code + ' ' + w.name])) },
          { k: 'active', t: '状态', type: 'select', opts: [[1, '启用'], [0, '停用']] },
        ],
      },
    };
  },

  async render(el) {
    this.meta = await API.get('/meta');
    const canEdit = App.canEdit();
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h">
          <h3 id="tbTitle"></h3>
          ${canEdit ? `<button class="btn btn-primary btn-sm" id="add">${UI.icon('plus')}新增</button>` : ''}
        </div>
        <div class="card-b tight" id="tb">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    if (this.tab === 'routes') return this.renderRoutes(el);
    if (canEdit) el.querySelector('#add').onclick = () => this.form();
    await this.loadTable(el);
  },

  async loadTable(el) {
    const c = this.conf()[this.tab];
    el.querySelector('#tbTitle').textContent = c.name + '列表';
    const rows = await API.get(c.api);
    const canEdit = App.canEdit();
    el.querySelector('#tb').innerHTML = UI.table(
      c.cols.concat(canEdit ? [{
        t: '操作', align: 'right', w: '130px',
        f: (r) => `<button class="btn btn-sm" data-edit="${r.id}">编辑</button>`
          + (this.tab === 'users' ? ` <button class="btn btn-sm" data-qr="${r.id}">二维码</button>` : '')
          + ` <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>`,
      }] : []), rows);
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => this.form(b.dataset.edit));
    if (canEdit) el.querySelectorAll('[data-qr]').forEach((b) => b.onclick = async () => {
      try {
        const d = await API.get('/qr/worker/' + b.dataset.qr);
        UI.qrModal('员工报工码 · ' + d.worker.name, {
          svg: d.svg, url: d.url,
          subtitle: (d.worker.team ? d.worker.team + ' · ' : '') + '微信扫一扫即可报工',
          fileName: '员工_' + d.worker.name,
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该记录？删除后不可恢复。'))) return;
      try { await API.del(c.api + '/' + b.dataset.del); UI.toast('已删除', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  async form(id) {
    const c = this.conf()[this.tab];
    const row = id ? (await API.get(c.api)).find((r) => r.id == id) : {};
    const body = `<div class="grid g2">` + c.fields.map((f) => {
      const v = row[f.k] === undefined || row[f.k] === null ? (f.def === undefined ? '' : f.def) : row[f.k];
      if (f.type === 'select') {
        const opts = typeof f.opts === 'function' ? f.opts() : f.opts;
        return `<label class="field"><span>${UI.esc(f.t)}</span><select class="input" data-k="${f.k}">${UI.options(opts.map(([val, lb]) => ({ id: val, name: lb })), v, 'name')}</select></label>`;
      }
      return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
        <input class="input" data-k="${f.k}" type="${f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'}"
          value="${UI.esc(v)}" ${f.req ? 'required' : ''} ${f.type === 'number' ? 'step="0.01"' : ''}>
        ${f.hint ? `<span class="small muted">${UI.esc(f.hint)}</span>` : ''}</label>`;
    }).join('') + `</div>`;

    UI.modal({
      title: (id ? '编辑' : '新增') + c.name,
      body,
      onOk: async (mask) => {
        const payload = {};
        c.fields.forEach((f) => {
          const inp = mask.querySelector(`[data-k="${f.k}"]`);
          let v = inp.value;
          if (f.type === 'number') v = (v === '' || v === null) ? 0 : Number(v);
          if (f.k === 'active' || f.k === 'work_center_id') v = v === '' || v === 'null' ? null : Number(v);
          if (f.req && (v === '' || v === null)) throw new Error('请填写「' + f.t + '」');
          if (f.type === 'password' && !v) return;
          payload[f.k] = v;
        });
        if (id) await API.put(c.api + '/' + id, payload);
        else await API.post(c.api, payload);
        UI.toast('已保存', 'ok');
        Views.basic.render(document.getElementById('view'));
      },
    });
  },

  /* ---------- 工艺路线（含工序明细） ---------- */
  async renderRoutes(el) {
    el.querySelector('#tbTitle').textContent = '工艺路线列表';
    const routes = await API.get('/routes');
    const stepCache = {};
    for (const r of routes) stepCache[r.id] = await API.get('/routes/' + r.id + '/steps');

    el.querySelector('#tb').innerHTML = UI.table([
      { t: '编码', f: (r) => `<b>${UI.esc(r.code)}</b>` },
      { t: '名称', k: 'name' },
      { t: '产品', f: (r) => `${UI.esc(r.product_name)} <span class="small muted">${UI.esc(r.product_code)}</span>` },
      { t: '工序', w: '46%', f: (r) => stepCache[r.id].map((s) =>
        `<span class="chip chip-gray" style="margin:2px 4px 2px 0">${s.seq} ${UI.esc(s.process_name)}</span>`).join('') },
      { t: '工序数', f: (r) => stepCache[r.id].length, align: 'right' },
      App.canEdit() ? {
        t: '操作', align: 'right', w: '130px',
        f: (r) => `<button class="btn btn-sm" data-edit="${r.id}">编辑</button>
                   <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>`,
      } : null,
    ].filter(Boolean), routes);

    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => this.routeForm(b.dataset.edit, stepCache[b.dataset.edit]));
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('删除工艺路线会影响引用它的工单，确定删除？'))) return;
      await API.del('/routes/' + b.dataset.del);
      UI.toast('已删除', 'ok');
      this.render(el);
    });
    if (el.querySelector('#add')) el.querySelector('#add').onclick = () => this.routeForm();
  },

  async routeForm(id, steps) {
    const M = this.meta;
    steps = steps || [];
    const row = id ? (await API.get('/routes')).find((r) => r.id == id) : {};
    const stepRow = (s) => `<div class="row steprow" style="gap:8px;margin-bottom:8px;flex-wrap:nowrap">
        <input class="input" data-s="seq" type="number" value="${s.seq || 10}" style="width:64px" title="顺序号">
        <select class="input" data-s="process_id" style="flex:1.2">${UI.options(M.processes, s.process_id, 'name')}</select>
        <select class="input" data-s="work_center_id" style="flex:1.2"><option value="">不限设备</option>${UI.options(M.workCenters, s.work_center_id, 'name')}</select>
        <input class="input" data-s="std_time" type="number" step="0.1" value="${s.std_time || 0}" style="width:78px" title="标准工时(分)">
        <input class="input" data-s="std_price" type="number" step="0.01" value="${s.std_price || 0}" style="width:78px" title="计件单价">
        <button class="icon-btn" data-rmStep>${UI.icon('close')}</button>
      </div>`;

    const m = UI.modal({
      title: (id ? '编辑' : '新增') + '工艺路线',
      size: 'lg',
      body: `
        <div class="grid g2">
          <label class="field"><span class="label-req">路线编码</span><input class="input" id="rCode" value="${UI.esc(row.code || '')}"></label>
          <label class="field"><span class="label-req">路线名称</span><input class="input" id="rName" value="${UI.esc(row.name || '')}"></label>
        </div>
        <label class="field"><span class="label-req">适用产品</span>
          <select class="input" id="rProduct">${UI.options(M.products, row.product_id, 'name')}</select></label>
        <div class="card-h" style="padding:10px 0;border:none">
          <h3 style="font-size:14px">工序明细</h3>
          <button class="btn btn-sm" id="addStep">${UI.icon('plus')}添加工序</button>
        </div>
        <div class="small muted" style="margin-bottom:8px">顺序号 · 工序 · 工作中心 · 标准工时(分钟/件) · 计件单价(元)</div>
        <div id="steps">${steps.map(stepRow).join('') || stepRow({ seq: 10 })}</div>`,
      onMount: (mask) => {
        mask.querySelector('#addStep').onclick = () => {
          const d = document.createElement('div');
          const last = mask.querySelectorAll('.steprow');
          const seq = last.length ? Number(last[last.length - 1].querySelector('[data-s=seq]').value) + 10 : 10;
          d.innerHTML = stepRow({ seq });
          mask.querySelector('#steps').appendChild(d.firstChild);
          mask.querySelectorAll('[data-rmStep]').forEach((b) => b.onclick = () =>
            mask.querySelectorAll('.steprow').length > 1 ? b.closest('.steprow').remove() : UI.toast('至少保留一道工序', 'err'));
        };
        mask.querySelectorAll('[data-rmStep]').forEach((b) => b.onclick = () =>
          mask.querySelectorAll('.steprow').length > 1 ? b.closest('.steprow').remove() : UI.toast('至少保留一道工序', 'err'));
      },
      onOk: async (mask) => {
        const payload = {
          code: mask.querySelector('#rCode').value.trim(),
          name: mask.querySelector('#rName').value.trim(),
          product_id: Number(mask.querySelector('#rProduct').value),
          steps: [...mask.querySelectorAll('.steprow')].map((r) => ({
            seq: Number(r.querySelector('[data-s=seq]').value),
            process_id: Number(r.querySelector('[data-s=process_id]').value),
            work_center_id: r.querySelector('[data-s=work_center_id]').value || null,
            std_time: Number(r.querySelector('[data-s=std_time]').value) || 0,
            std_price: Number(r.querySelector('[data-s=std_price]').value) || 0,
          })),
        };
        if (!payload.code || !payload.name) throw new Error('请填写路线编码与名称');
        if (!payload.steps.length) throw new Error('请至少添加一道工序');
        if (id) await API.put('/routes/' + id, payload);
        else await API.post('/routes', payload);
        UI.toast('已保存', 'ok');
        Views.basic.render(document.getElementById('view'));
      },
    });
    return m;
  },
};
