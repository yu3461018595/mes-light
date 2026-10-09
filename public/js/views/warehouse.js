/* 物料仓储：库存台账 + 来料入库 + 成品入库 + 收发明细 + 物料档案
 * 对标市面小工单系统的库存闭环：单据 → 收发明细（流水）→ 库存台账 → 安全库存预警。
 * 台账与流水由单据自动生成，不允许手工修改；单据删除/修改会自动冲销并重算库存。 */
window.Views = window.Views || {};
Views.warehouse = {
  title: '物料仓储',
  icon: 'box',
  tab: 'stock',
  tabs: [
    ['stock', '库存台账'],
    ['incoming', '来料入库'],
    ['issues', '领料退料'],
    ['finished', '成品入库'],
    ['shipments', '成品出库'],
    ['sales', '销售订单'],
    ['tx', '收发明细'],
    ['ratio', '产出比'],
    ['materials', '物料档案'],
    ['prod', '产销报表'],
    ['warehouses', '仓库'],
    ['trace', '批次追溯'],
  ],

  // 领料/退料类型
  ISSUE_TYPE: {
    pick: ['领料', 'chip-warn'],
    return: ['退料', 'chip-info'],
  },
  issueChip(t) {
    const m = this.ISSUE_TYPE[t] || [t || '—', 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },

  // 检验/质检结论样式
  RESULT: {
    pending: ['待检', 'chip-gray'],
    qualified: ['合格', 'chip-ok'],
    rejected: ['不合格', 'chip-danger'],
  },
  resChip(r) {
    const m = this.RESULT[r] || ['—', 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },
  // 收发明细类型
  TX_TYPE: {
    in_incoming: ['来料入库', 'chip-blue'],
    in_finish: ['成品入库', 'chip-ok'],
    out_pick: ['领料出库', 'chip-warn'],
    in_return: ['退料入库', 'chip-info'],
    out_ship: ['成品出库', 'chip-warn'],
    adjust: ['盘点调整', 'chip-gray'],
  },
  txChip(t) {
    const m = this.TX_TYPE[t] || [t || '—', 'chip-gray'];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  },
  // 安全库存预警：低于下限=缺料，高于上限=积压（total 传入时按物料全部批次合计判定）
  alertOf(r, total) {
    const q = total === undefined ? (Number(r.qty) || 0) : Number(total) || 0;
    const mn = r.safe_min === null || r.safe_min === undefined ? null : Number(r.safe_min);
    const mx = r.safe_max === null || r.safe_max === undefined ? null : Number(r.safe_max);
    if (mn !== null && q < mn) return ['缺料预警', 'chip-danger', 'low'];
    if (mx !== null && mx > 0 && q > mx) return ['库存积压', 'chip-warn', 'high'];
    return ['正常', 'chip-ok', 'ok'];
  },
  alertChip(r) {
    const tot = this._tot ? this._tot[r.material_id] : undefined;
    const a = this.alertOf(r, tot);
    return `<span class="chip ${a[1]}">${a[0]}</span>`;
  },

  /* 各标签页配置：接口 + 列表列 + 表单字段 */
  conf() {
    const M = this.meta || {};
    const ordersOpts = () => [[null, '不关联']].concat((M.orders || []).map((o) => [o.id, o.code + ' ' + o.product_name]));
    const resultOpts = [['pending', '待检'], ['qualified', '合格'], ['rejected', '不合格']];
    const matOpts = () => [[null, '不关联物料（只记单据，不计库存）']]
      .concat((M.materials || []).filter((m) => m.active !== 0).map((m) => [m.id, m.code + ' ' + m.name]));
    const whOpts = () => [[null, '默认']].concat((M.warehouses || []).map((w) => [w.id, w.code + ' ' + w.name]));
    const CATS = ['原料', '半成品', '成品', '外协件'];

    return {
      // ---------------- 库存台账（只读，由流水汇总） ----------------
      stock: {
        api: '/inventory', name: '库存台账', readonly: true, export: true,
        cols: [
          { t: '物料编码', f: (r) => `<b>${UI.esc(r.material_code || '')}</b>` },
          { t: '物料名称', f: (r) => `${UI.esc(r.material_name || '')}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}` },
          { t: '分类', f: (r) => UI.esc(r.category || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '当前库存', align: 'right', f: (r) => `<b class="mono">${UI.n2(r.qty)}</b> ${UI.esc(r.unit || '')}` },
          { t: '安全库存', align: 'right', f: (r) => `<span class="muted">${r.safe_min == null ? '—' : UI.n2(r.safe_min)} ~ ${r.safe_max == null ? '—' : UI.n2(r.safe_max)}</span>` },
          { t: '状态', f: (r) => this.alertChip(r) },
          { t: '更新时间', f: (r) => `<span class="small muted">${UI.esc((r.updated_at || '').slice(0, 16).replace('T', ' '))}</span>` },
        ],
        fields: [],
      },

      // ---------------- 收发明细（只读流水） ----------------
      tx: {
        api: '/inventory_tx', name: '收发明细', readonly: true, export: true, noAdd: true,
        cols: [
          { t: '时间', f: (r) => `<span class="small">${UI.esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</span>` },
          { t: '单据类型', f: (r) => this.txChip(r.tx_type) },
          { t: '物料', f: (r) => `${UI.esc(r.material_code || '')} ${UI.esc(r.material_name || '')}` },
          { t: '变动数量', align: 'right', f: (r) => `<b class="mono" style="color:${Number(r.qty) >= 0 ? 'var(--ok)' : 'var(--danger)'}">${Number(r.qty) >= 0 ? '+' : ''}${UI.n2(r.qty)}</b>` },
          { t: '变动前', align: 'right', f: (r) => `<span class="mono muted">${UI.n2(r.before_qty)}</span>` },
          { t: '变动后', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.after_qty)}</span>` },
          { t: '关联单据', f: (r) => UI.esc(r.ref_code || '—') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '操作人', f: (r) => UI.esc(r.operator || '—') },
          { t: '备注', f: (r) => `<span class="small muted">${UI.esc(r.remark || '')}</span>` },
        ],
        fields: [],
      },

      // ---------------- 来料入库 ----------------
      incoming: {
        api: '/incoming_materials', name: '来料入库',
        cols: [
          { t: '来料单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '来料日期', f: (r) => UI.esc(r.incoming_date || '') },
          { t: '供应商', f: (r) => UI.esc(r.supplier || '—') },
          { t: '物料', f: (r) => `${UI.esc(r.material_name || '')}${r.material_spec ? ` <span class="small muted">${UI.esc(r.material_spec)}</span>` : ''}` },
          { t: '数量', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '检验结论', f: (r) => this.resChip(r.result) },
          { t: '检验员', f: (r) => UI.esc(r.inspector || '—') },
        ],
        fields: [
          { k: 'code', t: '来料单号', hint: '留空自动生成（LM+日期+序号）' },
          { k: 'incoming_date', t: '来料日期', type: 'date', def: UI.today() },
          { k: 'supplier', t: '供应商', list: 'supList', placeholder: '可输入或从下拉选择' },
          { k: 'material_id', t: '物料档案', type: 'select', opts: matOpts, hint: '选择后自动生成库存与收发明细' },
          { k: 'warehouse_id', t: '入库仓库', type: 'select', opts: whOpts },
          { k: 'material_code', t: '物料编码' },
          { k: 'material_name', t: '物料名称', req: 1 },
          { k: 'material_spec', t: '规格型号' },
          { k: 'qty', t: '来料数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批次/批号' },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts },
          { k: 'inspector', t: '检验员' },
          { k: 'result', t: '检验结论', type: 'select', opts: resultOpts, def: 'pending', hint: '选「待检」暂不入库，质检员在「质量→来料检验」判定合格后自动入库；不合格不计库存' },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 成品入库 ----------------
      finished: {
        api: '/finished_goods_in', name: '成品入库',
        cols: [
          { t: '入库单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '入库日期', f: (r) => UI.esc(r.in_date || '') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '产品', f: (r) => `${UI.esc(r.product_name || '')}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}` },
          { t: '入库数量', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批号', f: (r) => UI.esc(r.batch || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '质检结果', f: (r) => this.resChip(r.result) },
          { t: '入库人', f: (r) => UI.esc(r.inspector || '—') },
        ],
        fields: [
          { k: 'code', t: '入库单号', hint: '留空自动生成（RK+日期+序号）' },
          { k: 'in_date', t: '入库日期', type: 'date', def: UI.today() },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts, hint: '选中工单可自动带出产品编码/名称/规格' },
          { k: 'material_id', t: '物料档案', type: 'select', opts: matOpts, hint: '选择后自动生成库存与收发明细' },
          { k: 'warehouse_id', t: '入库仓库', type: 'select', opts: whOpts },
          { k: 'product_code', t: '产品编码' },
          { k: 'product_name', t: '产品名称', req: 1 },
          { k: 'spec', t: '规格型号' },
          { k: 'qty', t: '入库数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批号' },
          { k: 'location', t: '库位' },
          { k: 'inspector', t: '入库人/质检员' },
          { k: 'result', t: '质检结果', type: 'select', opts: resultOpts, def: 'qualified', hint: '不合格不计入库存' },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 领料 / 退料（关联工单） ----------------
      issues: {
        api: '/material_issues', name: '领料退料',
        cols: [
          { t: '单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '类型', f: (r) => this.issueChip(r.type) },
          { t: '日期', f: (r) => UI.esc(r.issue_date || '') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || (r.type === 'pick' ? '<span style="color:var(--danger)">未关联</span>' : '—')) },
          { t: '物料', f: (r) => `${UI.esc(r.material_name || '')}${r.material_spec ? ` <span class="small muted">${UI.esc(r.material_spec)}</span>` : ''}` },
          { t: '数量', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '用途/原因', f: (r) => `<span class="small">${UI.esc(r.reason || '—')}</span>` },
          { t: '经手人', f: (r) => UI.esc(r.operator || '—') },
        ],
        fields: [
          { k: 'code', t: '单号', hint: '留空自动生成（领料 LL / 退料 TL + 日期 + 序号）' },
          { k: 'type', t: '单据类型', type: 'select', opts: [['pick', '领料（扣库存）'], ['return', '退料（回增库存）']], def: 'pick' },
          { k: 'issue_date', t: '单据日期', type: 'date', def: UI.today() },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts, hint: '领料必选；退料建议选择以便工单核算' },
          { k: 'material_id', t: '物料档案', type: 'select', opts: matOpts, hint: '选择后自动带出编码/名称/单位/仓库' },
          { k: 'warehouse_id', t: '仓库', type: 'select', opts: whOpts },
          { k: 'material_code', t: '物料编码' },
          { k: 'material_name', t: '物料名称', req: 1 },
          { k: 'material_spec', t: '规格型号' },
          { k: 'qty', t: '数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批次' },
          { k: 'reason', t: '领料用途 / 退料原因' },
          { k: 'operator', t: '经手人' },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 成品出库（发货 / 销售） ----------------
      shipments: {
        api: '/stock_shipments', name: '成品出库',
        cols: [
          { t: '出库单号', f: (r) => `<b>${UI.esc(r.code || '—')}</b>` },
          { t: '出库日期', f: (r) => UI.esc(r.ship_date || '') },
          { t: '客户', f: (r) => UI.esc(r.customer || '—') },
          { t: '关联工单', f: (r) => UI.esc(r.order_code || '—') },
          { t: '销售单号', f: (r) => UI.esc(r.sale_ref || '—') },
          { t: '物料', f: (r) => `${UI.esc(r.material_name || '')}${r.material_spec ? ` <span class="small muted">${UI.esc(r.material_spec)}</span>` : ''}` },
          { t: '数量', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit || '')}` },
          { t: '批次', f: (r) => UI.esc(r.batch || '—') },
          { t: '仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '经手人', f: (r) => UI.esc(r.operator || '—') },
        ],
        fields: [
          { k: 'code', t: '出库单号', hint: '留空自动生成（CK+日期+序号）' },
          { k: 'ship_date', t: '出库日期', type: 'date', def: UI.today() },
          { k: 'customer', t: '客户', list: 'custList', placeholder: '可输入或从下拉选择' },
          { k: 'order_id', t: '关联工单', type: 'select', opts: ordersOpts },
          { k: 'sale_ref', t: '销售单号' },
          { k: 'material_id', t: '物料档案', type: 'select', opts: matOpts, hint: '选择后自动带出编码/名称/单位/仓库' },
          { k: 'warehouse_id', t: '仓库', type: 'select', opts: whOpts },
          { k: 'material_code', t: '物料编码' },
          { k: 'material_name', t: '物料名称', req: 1 },
          { k: 'material_spec', t: '规格型号' },
          { k: 'qty', t: '出库数量', type: 'number', req: 1 },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'batch', t: '批次' },
          { k: 'operator', t: '经手人' },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 物料档案 ----------------
      materials: {
        api: '/materials', name: '物料档案',
        cols: [
          { t: '物料编码', f: (r) => `<b>${UI.esc(r.code || '')}</b>` },
          { t: '物料名称', f: (r) => `${UI.esc(r.name || '')}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}` },
          { t: '分类', f: (r) => UI.esc(r.category || '—') },
          { t: '材质', f: (r) => UI.esc(r.material || '—') },
          { t: '单位', f: (r) => UI.esc(r.unit || '') },
          { t: '默认仓库', f: (r) => UI.esc(r.warehouse_name || '—') },
          { t: '库位', f: (r) => UI.esc(r.location || '—') },
          { t: '安全下限', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.safe_min)}</span>` },
          { t: '安全上限', align: 'right', f: (r) => r.safe_max == null ? '<span class="muted">—</span>' : `<span class="mono">${UI.n2(r.safe_max)}</span>` },
          { t: '状态', f: (r) => (r.active === 0 ? '<span class="chip chip-gray">已停用</span>' : '<span class="chip chip-ok">启用</span>') },
        ],
        fields: [
          { k: 'code', t: '物料编码', req: 1 },
          { k: 'name', t: '物料名称', req: 1 },
          { k: 'category', t: '分类', type: 'select', opts: CATS.map((c) => [c, c]), def: '原料' },
          { k: 'spec', t: '规格型号' },
          { k: 'material', t: '材质' },
          { k: 'unit', t: '单位', def: '件' },
          { k: 'warehouse_id', t: '默认仓库', type: 'select', opts: whOpts },
          { k: 'location', t: '默认库位' },
          { k: 'safe_min', t: '安全库存下限', type: 'number', def: 0, hint: '库存低于此值 → 缺料预警' },
          { k: 'safe_max', t: '安全库存上限', type: 'number', hint: '留空表示不限制；高于此值 → 积压提示' },
          { k: 'active', t: '状态', type: 'select', opts: [[1, '启用'], [0, '停用']], def: 1 },
          { k: 'remark', t: '备注' },
        ],
      },

      // ---------------- 仓库 ----------------
      warehouses: {
        api: '/warehouses', name: '仓库',
        cols: [
          { t: '仓库编号', f: (r) => `<b>${UI.esc(r.code || '')}</b>` },
          { t: '仓库名称', f: (r) => UI.esc(r.name || '') },
          { t: '备注', f: (r) => `<span class="small muted">${UI.esc(r.remark || '—')}</span>` },
          { t: '创建时间', f: (r) => `<span class="small muted">${UI.esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</span>` },
        ],
        fields: [
          { k: 'code', t: '仓库编号', req: 1, hint: '如 WH01' },
          { k: 'name', t: '仓库名称', req: 1 },
          { k: 'remark', t: '备注' },
        ],
      },
    };
  },

  async render(el) {
    if (this.tab === 'prod') { await this.renderProd(el); return; }
    if (this.tab === 'ratio') { await this.renderRatio(el); return; }
    if (this.tab === 'trace') { await this.renderTrace(el); return; }
    if (this.tab === 'sales') { await this.renderSales(el); return; }
    try { this.meta = await API.get('/meta'); } catch (e) { this.meta = {}; }
    try { this.meta.orders = await API.get('/orders'); } catch (e) { this.meta.orders = []; }
    try { this.meta.materials = await API.get('/materials'); } catch (e) { this.meta.materials = []; }
    try { this.meta.warehouses = await API.get('/warehouses'); } catch (e) { this.meta.warehouses = []; }
    const canEdit = App.canEdit();
    const c = this.conf()[this.tab];
    const showAdd = canEdit && !c.noAdd && (c.fields || []).length > 0;
    const txSummary = this.tab === 'tx' && this.txView === 'summary';
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h"><h3 id="tbTitle"></h3>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="tbStat" class="small muted"></span>
            ${c.export && !txSummary ? `<button class="btn btn-sm" id="exp">导出 CSV</button>` : ''}
            ${(this.tab === 'materials' && canEdit) ? `<button class="btn btn-sm" id="imp">从产品导入</button><button class="btn btn-sm" id="bom">产品单耗(BOM)</button>` : ''}
            ${(this.tab === 'stock' && canEdit) ? `<button class="btn btn-sm" id="adjustBtn">${UI.icon('edit')}盘点调整</button>` : ''}
            ${(this.tab === 'tx') ? `<button class="btn btn-sm" id="sumBtn">${txSummary ? '← 返回明细' : '收发存汇总'}</button>` : ''}
            ${showAdd ? `<button class="btn btn-primary btn-sm" id="add">${UI.icon('plus')}新增</button>` : ''}
          </div>
        </div>
        <div class="card-b tight" id="tb">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    if (showAdd) el.querySelector('#add').onclick = () => this.form();
    if (c.export && !txSummary) el.querySelector('#exp').onclick = () => this.exportCsv(el);
    const sumBtn = el.querySelector('#sumBtn');
    if (sumBtn) sumBtn.onclick = () => { this.txView = txSummary ? 'detail' : 'summary'; this.render(el); };
    const adjustBtn = el.querySelector('#adjustBtn');
    if (adjustBtn) adjustBtn.onclick = () => this.adjustModal(el);
    const imp = el.querySelector('#imp');
    if (imp) imp.onclick = async () => {
      try { const r = await API.post('/materials/import_products', {}); UI.toast(`已导入 ${r.imported} 条成品物料`, 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    };
    const bomBtn = el.querySelector('#bom');
    if (bomBtn) bomBtn.onclick = () => this.bomModal(el);
    if (txSummary) { el.querySelector('#tbTitle').textContent = '收发存汇总'; await this.renderTxSummary(el); return; }
    await this.loadTable(el);
  },

  /* ------------------------------ 产品单耗（简易 BOM）编辑 ------------------------------ */
  async bomModal(el) {
    const M = this.meta || {};
    const products = M.products || [];
    if (!products.length) return UI.toast('暂无产品档案，请先在「基础数据 → 产品」中创建', 'err');
    let pid = products[0].id;
    const loadRows = async () => {
      const boms = await API.get('/boms');
      return (boms || []).filter((x) => String(x.product_id) === String(pid));
    };
    const matOpts = (M.materials || []).map((x) => `<option value="${x.id}">${UI.esc(x.code + ' ' + x.name)}${x.unit ? '（' + UI.esc(x.unit) + '）' : ''}</option>`).join('');
    const paint = (mask, rows) => {
      const box = mask.querySelector('#bomRows');
      box.innerHTML = rows.length ? rows.map((r, i) => `
        <div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:nowrap" data-bomrow="${i}">
          <select class="input" data-b="material_id" style="flex:2">${matOpts.replace(`value="${r.material_id}"`, `value="${r.material_id}" selected`)}</select>
          <input class="input" data-b="qty_per_unit" type="number" step="0.0001" min="0" value="${r.qty_per_unit}" style="flex:1" title="单耗（每件成品消耗量）">
          <input class="input" data-b="loss_rate" type="number" step="0.1" min="0" max="100" value="${r.loss_rate || 0}" style="flex:1" title="损耗率（%）">
          <button class="icon-btn" data-brm>${UI.icon('close')}</button>
        </div>`).join('') : '<div class="small muted" style="padding:8px 0">暂无材料，点击下方「添加材料」配置单耗。</div>';
      box.querySelectorAll('[data-brm]').forEach((b) => b.onclick = () => b.closest('[data-bomrow]').remove());
    };
    const collect = (mask) => [...mask.querySelectorAll('[data-bomrow]')].map((r) => ({
      material_id: Number(r.querySelector('[data-b=material_id]').value),
      qty_per_unit: Number(r.querySelector('[data-b=qty_per_unit]').value) || 0,
      loss_rate: Number(r.querySelector('[data-b=loss_rate]').value) || 0,
    }));
    UI.modal({
      title: '产品单耗（简易 BOM）', size: 'lg',
      body: `
        <label class="field"><span>产品</span>
          <select class="input" id="bomProd">${products.map((p) => `<option value="${p.id}">${UI.esc(p.code + ' ' + p.name)}</option>`).join('')}</select>
          <span class="small muted">每件成品消耗的材料数量与损耗率；保存后用于领料建议用量与材料损耗率分析。</span></label>
        <div class="row small muted" style="gap:8px;margin:8px 0 6px"><span style="flex:2">材料</span><span style="flex:1">单耗/件</span><span style="flex:1">损耗率%</span><span style="width:32px"></span></div>
        <div id="bomRows">加载中…</div>
        <button class="btn btn-sm" id="bomAdd" style="margin-top:6px">${UI.icon('plus')}添加材料</button>`,
      onMount: async (mask) => {
        paint(mask, await loadRows());
        mask.querySelector('#bomProd').onchange = async (e) => { pid = Number(e.target.value); paint(mask, await loadRows()); };
        mask.querySelector('#bomAdd').onclick = () => {
          const rows = collect(mask);
          rows.push({ material_id: (M.materials[0] || {}).id, qty_per_unit: 1, loss_rate: 0 });
          paint(mask, rows);
        };
      },
      onOk: async (mask) => {
        await API.put('/products/' + pid + '/bom', { items: collect(mask) });
        UI.toast('产品单耗已保存', 'ok');
        Views.warehouse.render(document.getElementById('view'));
      },
    });
  },

  /* ------------------------------ 盘点调整（账面 → 实盘差异流水） ------------------------------ */
  async adjustModal(el) {
    const M = this.meta || {};
    let inv = [];
    try { inv = await API.get('/inventory'); } catch (e) { /* 忽略 */ }
    const matOpts = (M.materials || []).filter((m) => m.active !== 0);
    const book = (mid, wid, batch) => {
      const r = inv.find((x) => String(x.material_id) === String(mid)
        && String(x.warehouse_id || '') === String(wid || '')
        && String(x.batch || '') === String(batch || ''));
      return r ? Number(r.qty) || 0 : 0;
    };
    UI.modal({
      title: '库存盘点调整',
      body: `
        <label class="field"><span class="label-req">物料</span>
          <select class="input" id="aMat"><option value="">请选择</option>${matOpts.map((m) => `<option value="${m.id}">${UI.esc(m.code)} ${UI.esc(m.name)}</option>`).join('')}</select></label>
        <div class="grid g2">
          <label class="field"><span>仓库</span><select class="input" id="aWh"><option value="">默认</option>${(M.warehouses || []).map((w) => `<option value="${w.id}">${UI.esc(w.code)} ${UI.esc(w.name)}</option>`).join('')}</select></label>
          <label class="field"><span>批次</span><input class="input" id="aBatch" placeholder="留空=无批次"></label>
        </div>
        <div class="grid g2">
          <label class="field"><span>账面数量</span><input class="input" id="aBook" disabled value="—"></label>
          <label class="field"><span class="label-req">实盘数量</span><input class="input" id="aQty" type="number" step="0.01"></label>
        </div>
        <label class="field"><span>差异说明</span><input class="input" id="aRemark" placeholder="如：破损 / 丢失 / 盘盈"></label>
        <div class="small muted">确认后按「实盘 − 账面」差异自动生成盘点调整流水，全程留痕；可在收发明细按「盘点调整」类型审计。</div>`,
      onMount: (mask) => {
        const upd = () => {
          const q = book(mask.querySelector('#aMat').value, mask.querySelector('#aWh').value, mask.querySelector('#aBatch').value.trim());
          mask.querySelector('#aBook').value = q;
        };
        ['#aMat', '#aWh'].forEach((s) => mask.querySelector(s).addEventListener('change', upd));
        mask.querySelector('#aBatch').addEventListener('input', upd);
      },
      onOk: async (mask) => {
        if (!mask.querySelector('#aMat').value) throw new Error('请选择物料');
        const r = await API.post('/inventory/adjust', {
          material_id: Number(mask.querySelector('#aMat').value),
          warehouse_id: mask.querySelector('#aWh').value ? Number(mask.querySelector('#aWh').value) : null,
          batch: mask.querySelector('#aBatch').value.trim() || null,
          physical_qty: mask.querySelector('#aQty').value,
          remark: mask.querySelector('#aRemark').value.trim() || null,
        });
        UI.toast(`盘点完成：账面 ${r.book} → 实盘 ${r.physical}（差异 ${r.diff > 0 ? '+' : ''}${r.diff}）`, 'ok');
        this.render(el);
      },
    });
  },

  /* ------------------------------ 收发存汇总（期初 + 收入 − 发出 = 期末） ------------------------------ */
  /* 批次/工单双向追溯：输入批次号或工单号，展示来料→领料→报工→检验→入库→出库全链路 */
  async renderTrace(el) {
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h"><h3>批次追溯</h3><span class="small muted">输入物料批次号或工单号，双向追溯来料来源与成品去向</span></div>
        <div class="card-b">
          <div class="row" style="gap:8px;margin-bottom:6px">
            <input class="input" id="trCode" placeholder="如：B20261006-01 或 MO-26100601" style="max-width:320px">
            <button class="btn btn-primary" id="trGo">${UI.icon('search')}追溯</button>
          </div>
          <div id="trResult"><p class="small muted">支持两种追溯方向：① 按批次（来料批/成品批）→ 查供应商、流向工单、出库客户；② 按工单 → 查用料批次、报工、检验、成品批次。</p></div>
        </div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    const go = async () => {
      const code = el.querySelector('#trCode').value.trim();
      if (!code) return UI.toast('请输入批次号或工单号', 'err');
      const box = el.querySelector('#trResult');
      box.innerHTML = '<p class="small muted">追溯中…</p>';
      let r;
      try { r = await API.get('/trace/' + encodeURIComponent(code)); }
      catch (e) { box.innerHTML = `<p class="small" style="color:var(--danger)">${UI.esc(e.message)}</p>`; return; }
      const sec = (title, cols, rows) => rows && rows.length
        ? `<div class="card" style="margin-top:12px"><div class="card-h"><h3>${title}</h3><span class="small muted">${rows.length} 条</span></div><div class="card-b tight">${UI.table(cols, rows)}</div></div>`
        : '';
      const conclChip = { pass: ['合格', 'chip-ok'], fail: ['不合格', 'chip-danger'], concession: ['让步', 'chip-warn'] };
      const cChip = (c) => { const m = conclChip[c] || [c || '—', 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; };
      let html = `<p style="margin:4px 0 0">追溯对象：<b class="mono">${UI.esc(r.code)}</b>　<span class="chip chip-blue">${r.type === 'order' ? '工单' : '批次'}</span>
        ${r.suppliers && r.suppliers.length ? `　来源供应商：<b>${r.suppliers.map(UI.esc).join('、')}</b>` : ''}
        ${r.customers && r.customers.length ? `　流向客户：<b>${r.customers.map(UI.esc).join('、')}</b>` : ''}</p>`;
      if (r.type === 'batch') {
        html += sec('批次流水', [
          { t: '日期', k: 'tx_date' },
          { t: '类型', f: (x) => this.txChip(x.tx_type) },
          { t: '物料', f: (x) => `${UI.esc(x.material_code)} ${UI.esc(x.material_name)}` },
          { t: '数量', f: (x) => `<span class="mono" style="color:${x.qty >= 0 ? 'var(--ok)' : 'var(--danger)'}">${x.qty > 0 ? '+' : ''}${x.qty}</span> ${UI.esc(x.unit)}` },
          { t: '仓库', f: (x) => UI.esc(x.warehouse_name || '—') },
          { t: '关联工单', f: (x) => x.order_code ? `<b class="mono">${UI.esc(x.order_code)}</b>` : '—' },
          { t: '单号', f: (x) => UI.esc(x.ref_code || '—') },
        ], r.txs);
      }
      if (r.order) {
        html += `<p style="margin:8px 0 0">工单 <b class="mono">${UI.esc(r.order.code)}</b> · ${UI.esc(r.order.product_name)} · 计划 ${UI.n2(r.order.qty_plan)} · ${UI.badge(r.order.status)}</p>`;
      }
      (r.orders || []).forEach((o) => {
        html += `<p style="margin:8px 0 0">流向工单 <b class="mono">${UI.esc(o.code)}</b> · ${UI.esc(o.product_name)} · ${UI.badge(o.status)}</p>`;
        html += sec('报工记录', [
          { t: '日期', k: 'report_date' }, { t: '工序', k: 'process_name' }, { t: '工人', k: 'worker_name' },
          { t: '合格', f: (x) => `<span class="mono" style="color:var(--ok)">${x.qty_good}</span>` },
          { t: '不良', f: (x) => `<span class="mono" style="color:var(--danger)">${x.qty_bad}</span>` },
        ], o.reports);
        html += sec('检验记录', [
          { t: '检验单', k: 'code' }, { t: '结论', f: (x) => cChip(x.conclusion) },
          { t: '合格/不良', f: (x) => `<span class="mono">${x.qty_pass}/${x.qty_fail}</span>` },
          { t: '时间', f: (x) => `<span class="small mono">${UI.esc(x.created_at)}</span>` },
        ], o.inspections);
      });
      html += sec('用料明细', [
        { t: '物料', f: (x) => `${UI.esc(x.material_code)} ${UI.esc(x.material_name)}` },
        { t: '批次', f: (x) => `<b class="mono">${UI.esc(x.batch || '—')}</b>` },
        { t: '数量', f: (x) => `<span class="mono">${x.qty} ${UI.esc(x.unit)}</span>` },
        { t: '仓库', f: (x) => UI.esc(x.warehouse_name || '—') },
        { t: '日期', k: 'issue_date' },
      ], r.materials);
      html += sec('检验记录', [
        { t: '检验单', k: 'code' }, { t: '工序', k: 'process_name' }, { t: '结论', f: (x) => cChip(x.conclusion) },
        { t: '受检', k: 'qty_check' }, { t: '合格/不良', f: (x) => `<span class="mono">${x.qty_pass}/${x.qty_fail}</span>` },
        { t: '检验员', k: 'inspector' },
      ], r.inspections);
      html += sec('成品入库', [
        { t: '入库单', k: 'code' }, { t: '日期', k: 'in_date' },
        { t: '批次', f: (x) => `<b class="mono">${UI.esc(x.batch || '—')}</b>` },
        { t: '数量', f: (x) => `<span class="mono">${x.qty} ${UI.esc(x.unit)}</span>` },
      ], r.finished);
      html += sec('成品出库', [
        { t: '出库单', k: 'code' }, { t: '日期', k: 'ship_date' },
        { t: '客户', f: (x) => UI.esc(x.customer || '—') },
        { t: '批次', f: (x) => `<b class="mono">${UI.esc(x.batch || '—')}</b>` },
        { t: '数量', f: (x) => `<span class="mono">${x.qty} ${UI.esc(x.unit)}</span>` },
      ], r.shipments);
      box.innerHTML = html;
    };
    el.querySelector('#trGo').onclick = go;
    el.querySelector('#trCode').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  },

  async renderTxSummary(el) {
    const d = new Date();
    const defStart = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    const host = el.querySelector('#tb');
    if (!host) return;   // DOM 防御：容器缺失时静默返回，避免整页报错
    host.innerHTML = `
      <div class="row" style="gap:10px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
        <span class="small muted">期间</span>
        <input class="input" id="sumStart" type="date" value="${defStart}" style="width:150px">
        <span class="small muted">至</span>
        <input class="input" id="sumEnd" type="date" value="${UI.today()}" style="width:150px">
        <button class="btn btn-sm btn-primary" id="sumGo">查询</button>
        <button class="btn btn-sm" id="sumExp">导出 CSV</button>
        <span class="small muted">口径：期初 + 收入 − 发出 = 期末（含盘点调整）</span>
      </div>
      <div id="sumBody">加载中…</div>`;
    const load = async () => {
      const start = el.querySelector('#sumStart').value, end = el.querySelector('#sumEnd').value;
      try {
        const r = await API.get(`/stats/inventory_summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
        this._sumRows = r.rows || [];
        el.querySelector('#sumBody').innerHTML = UI.table([
          { t: '物料编码', f: (x) => `<b>${UI.esc(x.material_code)}</b>` },
          { t: '物料名称', f: (x) => UI.esc(x.material_name) },
          { t: '分类', f: (x) => UI.esc(x.category || '—') },
          { t: '单位', f: (x) => UI.esc(x.unit || '') },
          { t: '期初', align: 'right', f: (x) => `<span class="mono">${UI.n2(x.opening)}</span>` },
          { t: '收入', align: 'right', f: (x) => `<span class="mono" style="color:var(--ok)">+${UI.n2(x.in_qty)}</span>` },
          { t: '发出', align: 'right', f: (x) => `<span class="mono" style="color:var(--danger)">−${UI.n2(x.out_qty)}</span>` },
          { t: '期末', align: 'right', f: (x) => `<b class="mono">${UI.n2(x.closing)}</b>` },
        ], this._sumRows);
      } catch (e) {
        el.querySelector('#sumBody').innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
      }
    };
    el.querySelector('#sumGo').onclick = load;
    el.querySelector('#sumExp').onclick = () => {
      const lines = [`【收发存汇总】 ${el.querySelector('#sumStart').value} 至 ${el.querySelector('#sumEnd').value}`];
      lines.push('物料编码,物料名称,分类,单位,期初,收入,发出,期末');
      (this._sumRows || []).forEach((x) => lines.push([x.material_code, x.material_name, x.category || '', x.unit || '', x.opening, x.in_qty, x.out_qty, x.closing].join(',')));
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `收发存汇总_${UI.today()}.csv`;
      a.click();
      UI.toast('已导出 CSV', 'ok');
    };
    await load();
  },

  /* ------------------------------ 产出比报表（来料 → 成品入库） ------------------------------ */
  ratioChip(v) {
    if (v === null || v === undefined) return '<span class="muted">—</span>';
    const n = Number(v);
    const cls = n >= 90 ? 'chip-ok' : n >= 70 ? 'chip-warn' : 'chip-danger';
    return `<span class="chip ${cls}">${UI.f1(n)}%</span>`;
  },

  async renderRatio(el) {
    this.ratioPeriod = this.ratioPeriod || 'month';
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>投入产出比</h3>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <span id="tbStat" class="small muted"></span>
            <select class="input" id="rPeriod" style="width:120px">
              <option value="month"${this.ratioPeriod === 'month' ? ' selected' : ''}>本月</option>
              <option value="quarter"${this.ratioPeriod === 'quarter' ? ' selected' : ''}>近 3 月</option>
              <option value="year"${this.ratioPeriod === 'year' ? ' selected' : ''}>近 1 年</option>
              <option value="all"${this.ratioPeriod === 'all' ? ' selected' : ''}>全部</option>
            </select>
            <label class="small muted" style="display:flex;gap:4px;align-items:center;cursor:pointer" title="默认只统计检验合格的来料/入库">
              <input type="checkbox" id="rPending"> 含待检数量</label>
            <button class="btn btn-sm" id="rExp">导出 CSV</button>
          </div>
        </div>
        <div class="card-b" id="rBody">加载中…</div>
      </div>
      <div class="card">
        <div class="card-h"><h3>按工单明细</h3><span class="small muted">来料 / 成品入库按单据关联工单汇总；未关联工单的来料计入「公共来料」</span></div>
        <div class="card-b" id="rOrders">加载中…</div>
      </div>
      <div class="card">
        <div class="card-h"><h3>材料损耗分析</h3><span class="small muted">应耗 = 成品入库 × 单耗 × (1+损耗率)；实领超应耗 10% 标红 · 需先配置「产品单耗(BOM)」</span></div>
        <div class="card-b" id="rLoss">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    const periodStart = (p) => {
      const d = new Date();
      if (p === 'month') return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
      if (p === 'quarter') { const q = new Date(d); q.setMonth(q.getMonth() - 2); q.setDate(1); return q.toISOString().slice(0, 10); }
      if (p === 'year') { const y = new Date(d); y.setFullYear(y.getFullYear() - 1); return y.toISOString().slice(0, 10); }
      return '2000-01-01';
    };
    const loadLoss = async () => {
      const box = el.querySelector('#rLoss');
      if (!box) return;
      try {
        const r = await API.get(`/stats/material_loss?start=${periodStart(this.ratioPeriod)}&end=${UI.today()}`);
        const rows = r.rows || [];
        if (!rows.length) { box.innerHTML = `<div class="empty"><p>${UI.esc(r.hint || '期间内暂无成品入库')}</p></div>`; return; }
        box.innerHTML = UI.table([
          { t: '工单号', f: (x) => `<b>${UI.esc(x.order_code)}</b>` },
          { t: '产品', f: (x) => UI.esc(x.product_name || '—') },
          { t: '材料', f: (x) => `${UI.esc(x.material_name)}<span class="small muted"> ${UI.esc(x.material_code || '')}</span>` },
          { t: '成品入库', align: 'right', f: (x) => `<span class="mono">${UI.n2(x.finished_qty)}</span>` },
          { t: '单耗/件', align: 'right', f: (x) => `<span class="mono">${x.qty_per_unit}${Number(x.loss_rate_std) ? `<span class="small muted"> +${x.loss_rate_std}%</span>` : ''}</span>` },
          { t: '应耗', align: 'right', f: (x) => `<span class="mono">${UI.n2(x.should_use)}</span>` },
          { t: '实领', align: 'right', f: (x) => `<span class="mono" style="color:${x.actual_pick > x.should_use ? 'var(--danger)' : 'var(--ok)'}">${UI.n2(x.actual_pick)}</span>` },
          { t: '损耗率', align: 'right', f: (x) => x.loss_rate === null ? '<span class="muted">—</span>' : `<b style="color:${x.loss_rate > 10 ? 'var(--danger)' : x.loss_rate >= 0 ? 'var(--warn)' : 'var(--ok)'}">${x.loss_rate > 0 ? '+' : ''}${x.loss_rate}%</b>` },
        ], rows);
      } catch (e) { box.innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`; }
    };
    const load = async () => {
      try {
        this.yield = await API.get(`/stats/yield?period=${this.ratioPeriod}&include_pending=${el.querySelector('#rPending').checked ? '1' : '0'}`);
        this.paintRatio(el);
      } catch (e) {
        el.querySelector('#rBody').innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
      }
    };
    el.querySelector('#rPeriod').onchange = () => { this.ratioPeriod = el.querySelector('#rPeriod').value; load(); loadLoss(); };
    el.querySelector('#rPending').onchange = load;
    el.querySelector('#rExp').onclick = () => this.exportYield();
    await load();
    await loadLoss();
  },

  paintRatio(el) {
    const data = this.yield || { summary: {}, monthly: [], orders: [] };
    const s = data.summary || {};
    const stat = el.querySelector('#tbStat');
    if (stat) stat.textContent = (s.start ? '自 ' + s.start + ' 起 · ' : '') + (data.include_pending ? '含待检' : '仅合格');
    const ratioHtml = s.ratio === null || s.ratio === undefined ? '<span class="muted">—</span>' : `<b style="font-size:26px;color:${Number(s.ratio) >= 90 ? 'var(--ok)' : Number(s.ratio) >= 70 ? 'var(--warn)' : 'var(--danger)'}">${UI.f1(s.ratio)}%</b>`;
    el.querySelector('#rBody').innerHTML = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l">来料合格总量</div><div class="stat-v">${UI.n2(s.incoming_qty || 0)}</div><div class="stat-s">含公共来料 ${UI.n2(s.public_incoming || 0)}</div></div>
        <div class="stat"><div class="stat-l">成品入库总量</div><div class="stat-v" style="color:var(--primary)">${UI.n2(s.finished_qty || 0)}</div><div class="stat-s">件数按各单据单位</div></div>
        <div class="stat"><div class="stat-l">综合产出比</div><div class="stat-v">${ratioHtml}</div><div class="stat-s">成品入库 ÷ 来料</div></div>
        <div class="stat"><div class="stat-l">涉及工单</div><div class="stat-v">${s.orders_count || 0}</div><div class="stat-s">个</div></div>
      </div>
      ${UI.lineChart((data.monthly || []).map((m) => ({ d: m.month, incoming_qty: m.incoming_qty, finished_qty: m.finished_qty })), [
        { key: 'incoming_qty', label: '来料入库', color: '#1d4ed8' },
        { key: 'finished_qty', label: '成品入库', color: '#0f9d58' },
      ], { title: '近 6 个月 来料 vs 成品入库', h: 210 })}
      <div class="small muted" style="margin-top:6px">提示：来料与成品的计量单位可能不同（如来料按 KG、成品按 件），数量比供趋势与管理参考。</div>`;
    const rows = data.orders || [];
    el.querySelector('#rOrders').innerHTML = UI.table([
      { t: '工单号', f: (r) => `<b class="link" data-go="${r.order_id}">${UI.esc(r.order_code)}</b>` },
      { t: '产品', f: (r) => UI.esc(r.product_name || '—') },
      { t: '计划', align: 'right', f: (r) => `<span class="mono muted">${UI.n2(r.qty_plan)}</span>` },
      { t: '完工', align: 'right', f: (r) => `<span class="mono">${UI.n2(r.qty_done)}</span>` },
      { t: '来料合计', align: 'right', f: (r) => `<span class="mono" style="color:var(--primary)">${UI.n2(r.incoming_qty)}</span>` },
      { t: '成品入库', align: 'right', f: (r) => `<span class="mono" style="color:var(--ok)">${UI.n2(r.finished_qty)}</span>` },
      { t: '产出比', f: (r) => this.ratioChip(r.ratio) },
    ], rows) || '<div class="empty">期间内暂无关联工单的来料 / 成品入库</div>';
    el.querySelectorAll('[data-go]').forEach((a) => a.onclick = () => { location.hash = '#/orders/' + a.dataset.go; });
  },

  exportYield() {
    const data = this.yield || { summary: {}, monthly: [], orders: [] };
    const s = data.summary || {};
    const lines = [`【投入产出比】 期间: ${data.period}${s.start ? '（自 ' + s.start + '）' : ''}${data.include_pending ? ' 含待检' : ' 仅合格'}`];
    lines.push('来料合格总量,成品入库总量,综合产出比(%),涉及工单数,公共来料');
    lines.push([s.incoming_qty || 0, s.finished_qty || 0, s.ratio == null ? '' : s.ratio, s.orders_count || 0, s.public_incoming || 0].join(','));
    lines.push('', '【按月趋势】', '月份,来料入库,成品入库,产出比(%)');
    (data.monthly || []).forEach((m) => lines.push([m.month, m.incoming_qty, m.finished_qty, m.ratio == null ? '' : m.ratio].join(',')));
    lines.push('', '【按工单明细】', '工单号,产品,计划,完工,来料合计,成品入库,产出比(%)');
    (data.orders || []).forEach((r) => lines.push([r.order_code, r.product_name || '', r.qty_plan, r.qty_done, r.incoming_qty, r.finished_qty, r.ratio == null ? '' : r.ratio].join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `投入产出比_${UI.today()}.csv`;
    a.click();
    UI.toast('已导出 CSV', 'ok');
  },

  async loadTable(el) {
    const c = this.conf()[this.tab];
    el.querySelector('#tbTitle').textContent = c.name;
    const rows = await API.get(c.api);
    this.rows = rows;
    const canEdit = App.canEdit();
    const stat = el.querySelector('#tbStat');
    if (this.tab === 'stock') {
      // 预警按「物料全部批次合计」判定，避免同物料多批次时误报
      const tot = {};
      rows.forEach((r) => { tot[r.material_id] = (tot[r.material_id] || 0) + (Number(r.qty) || 0); });
      this._tot = tot;
    } else { this._tot = null; }
    if (stat) {
      if (this.tab === 'stock') {
        const seen = {};
        const matRows = rows.filter((r) => (seen[r.material_id] ? false : (seen[r.material_id] = true)));
        const low = matRows.filter((r) => this.alertOf(r, this._tot[r.material_id])[2] === 'low').length;
        const high = matRows.filter((r) => this.alertOf(r, this._tot[r.material_id])[2] === 'high').length;
        stat.innerHTML = `共 ${rows.length} 条 · <span style="color:var(--danger)">缺料 ${low}</span> · <span style="color:var(--warn)">积压 ${high}</span>`;
      } else if (this.tab === 'tx') {
        stat.textContent = `共 ${rows.length} 条流水（自动生成，只读）`;
      } else {
        stat.textContent = `共 ${rows.length} 条`;
      }
    }
    const cols = c.cols.concat((canEdit && !c.readonly) ? [{
      t: '操作', align: 'right', w: '120px',
      f: (r) => `<button class="btn btn-sm" data-edit="${r.id}">编辑</button> <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>`,
    }] : []);
    el.querySelector('#tb').innerHTML = UI.table(cols, rows);
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => this.form(b.dataset.edit));
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该记录？删除后不可恢复（关联的库存与流水会自动冲销）。'))) return;
      try { await API.del(c.api + '/' + b.dataset.del); UI.toast('已删除，库存已冲销', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  exportCsv(el) {
    const c = this.conf()[this.tab];
    const rows = this.rows || [];
    const strip = (s) => String(s).replace(/<[^>]*>/g, '');
    const headers = c.cols.map((x) => x.t);
    const lines = [headers.join(',')].concat(rows.map((r) => c.cols.map((x) => {
      let v;
      try { v = strip(x.f(r)); } catch (e) { v = ''; }
      v = String(v).replace(/\s+/g, ' ').trim();
      return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${c.name}_${UI.today()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    UI.toast('已导出 CSV', 'ok');
  },

  async form(id) {
    const c = this.conf()[this.tab];
    const rows = await API.get(c.api);
    const row = id ? rows.find((r) => r.id == id) : {};
    const M = this.meta || {};

    const body = `<div class="grid g2">` + c.fields.map((f) => {
      const v = (row[f.k] === undefined || row[f.k] === null) ? (f.def === undefined ? '' : f.def) : row[f.k];
      if (f.type === 'select') {
        const opts = typeof f.opts === 'function' ? f.opts() : f.opts;
        return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
          <select class="input" data-k="${f.k}">${UI.options(opts.map(([val, lb]) => ({ id: val, name: lb })), v, 'name')}</select>
          ${f.hint ? `<span class="small muted">${UI.esc(f.hint)}</span>` : ''}</label>`;
      }
      if (f.type === 'date') {
        return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
          <input class="input" data-k="${f.k}" type="date" value="${UI.esc(v)}" ${f.req ? 'required' : ''}></label>`;
      }
      if (f.list) {
        const src = f.list === 'supList' ? (M.suppliers || []) : (f.list === 'custList' ? (M.customers || []) : []);
        const list = src.map((s) => `<option value="${UI.esc(s.name || s)}">`).join('');
        return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
          <input class="input" data-k="${f.k}" list="${f.list}" value="${UI.esc(v)}" ${f.req ? 'required' : ''} placeholder="${f.placeholder || ''}">
          <datalist id="${f.list}">${list}</datalist></label>`;
      }
      return `<label class="field"><span class="${f.req ? 'label-req' : ''}">${UI.esc(f.t)}</span>
        <input class="input" data-k="${f.k}" type="${f.type === 'number' ? 'number' : 'text'}" value="${UI.esc(v)}" ${f.req ? 'required' : ''} ${f.type === 'number' ? 'step="0.01"' : ''}>
        ${f.hint ? `<span class="small muted">${UI.esc(f.hint)}</span>` : ''}</label>`;
    }).join('') + `</div>` + (this.tab === 'issues' ? `<div id="pickSug" style="margin-top:10px"></div>` : '');

    const bind = (mask) => {
      // 领料单：选中关联工单后按「产品单耗」计算建议领料量（计划数 × 单耗 × (1+损耗率)），点击即填入
      if (this.tab === 'issues') {
        const osel = mask.querySelector('[data-k="order_id"]');
        const sug = mask.querySelector('#pickSug');
        const loadSug = async () => {
          if (!sug) return;
          if (!osel || !osel.value) { sug.innerHTML = ''; return; }
          try {
            const [o, boms] = await Promise.all([API.get('/orders/' + osel.value), API.get('/boms')]);
            const plan = Number(o.qty_plan) || 0;
            const items = (boms || []).filter((x) => String(x.product_id) === String(o.product_id));
            if (!items.length) { sug.innerHTML = '<span class="small muted">该产品未配置产品单耗（物料档案 → 产品单耗(BOM)），无法计算建议用量。</span>'; return; }
            sug.innerHTML = '<div class="small" style="margin-bottom:4px"><b>建议领料</b>（计划 ' + plan + ' × 单耗 × (1+损耗率)，点击填入）：</div>' + items.map((x) => {
              const q = Math.round(plan * (Number(x.qty_per_unit) || 0) * (1 + (Number(x.loss_rate) || 0) / 100) * 100) / 100;
              return `<span class="chip chip-gray" style="margin:2px 6px 2px 0;cursor:pointer" data-fill="${x.material_id}" data-q="${q}">${UI.esc(x.material_name)} ≈ ${q} ${UI.esc(x.unit || '')}${Number(x.loss_rate) ? '（含损耗' + x.loss_rate + '%）' : ''}</span>`;
            }).join('');
            sug.querySelectorAll('[data-fill]').forEach((ch) => ch.onclick = () => {
              const ms = mask.querySelector('[data-k="material_id"]');
              if (ms) { ms.value = ch.dataset.fill; ms.dispatchEvent(new Event('change')); }
              const qe = mask.querySelector('[data-k="qty"]');
              if (qe) qe.value = ch.dataset.q;
            });
          } catch (e) { sug.innerHTML = ''; }
        };
        if (osel) osel.addEventListener('change', loadSug);
        loadSug();
      }
      // 选中关联工单后，自动带出产品编码/名称/规格（仅当对应字段为空时填充）
      if (this.tab === 'finished') {
        const osel = mask.querySelector('[data-k="order_id"]');
        if (osel) osel.addEventListener('change', async () => {
          const oid = osel.value;
          if (!oid) return;
          try {
            const o = await API.get('/orders/' + oid);
            const setIfEmpty = (k, val) => { const e2 = mask.querySelector(`[data-k="${k}"]`); if (e2 && !e2.value) e2.value = val || ''; };
            setIfEmpty('product_code', o.product_code);
            setIfEmpty('product_name', o.product_name);
            setIfEmpty('spec', o.spec);
            setIfEmpty('unit', o.unit || '件');
          } catch (e) { /* 忽略 */ }
        });
      }
      // 选中物料档案后，自动带出编码/名称/规格/单位/仓库
      const msel = mask.querySelector('[data-k="material_id"]');
      if (msel) msel.addEventListener('change', () => {
        const m = (M.materials || []).find((x) => String(x.id) === String(msel.value));
        if (!m) return;
        const setIfEmpty = (k, val) => { const e2 = mask.querySelector(`[data-k="${k}"]`); if (e2 && !e2.value) e2.value = val || ''; };
        setIfEmpty('material_code', m.code);
        setIfEmpty('product_code', m.code);
        setIfEmpty('material_name', m.name);
        setIfEmpty('product_name', m.name);
        setIfEmpty('material_spec', m.spec);
        setIfEmpty('spec', m.spec);
        const ue = mask.querySelector('[data-k="unit"]');
        if (ue && m.unit) ue.value = m.unit;
        const we = mask.querySelector('[data-k="warehouse_id"]');
        if (we && (!we.value || we.value === 'null') && m.warehouse_id) we.value = String(m.warehouse_id);
        const le = mask.querySelector('[data-k="location"]');
        if (le && !le.value && m.location) le.value = m.location;
      });
    };

    UI.modal({
      title: (id ? '编辑' : '新增') + c.name,
      size: 'lg',
      body,
      onMount: bind,
      onOk: async (mask) => {
        const payload = {};
        c.fields.forEach((f) => {
          const inp = mask.querySelector(`[data-k="${f.k}"]`);
          let v = inp ? inp.value : '';
          if (f.type === 'number') v = (v === '' || v === null) ? (f.k === 'safe_max' ? null : 0) : Number(v);
          if (f.k === 'order_id' || f.k === 'material_id' || f.k === 'warehouse_id') v = (v === '' || v === 'null' || v === null) ? null : Number(v);
          if (f.k === 'active') v = Number(v);
          if (f.req && (v === '' || v === null)) throw new Error('请填写「' + f.t + '」');
          payload[f.k] = v;
        });
        if ((this.tab === 'incoming' || this.tab === 'finished') && !payload.code) payload.code = (this.tab === 'incoming' ? 'LM' : 'RK') + new Date().toISOString().slice(2, 10).replace(/-/g, '') + String(Math.floor(Math.random() * 900) + 100);
        if (id) await API.put(c.api + '/' + id, payload);
        else await API.post(c.api, payload);
        UI.toast('已保存', 'ok');
        Views.warehouse.render(document.getElementById('view'));
      },
    });
  },

  /* ------------------------------ 产销报表（工单 ⇄ 仓储 闭环对账） ------------------------------ */
  /* ---------- 销售订单：接单登记 → 一键转生产工单 → 出货核销 ---------- */
  async renderSales(el) {
    const canEdit = App.canEdit();
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h"><h3>销售订单</h3>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="tbStat" class="small muted"></span>
            ${canEdit ? `<button class="btn btn-primary btn-sm" id="add">${UI.icon('plus')}新增订单</button>` : ''}
          </div>
        </div>
        <div class="card-b tight" id="tb">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    if (el.querySelector('#add')) el.querySelector('#add').onclick = () => this.salesForm();

    let list = [];
    try { list = await API.get('/sales_orders'); } catch (e) {
      el.querySelector('#tb').innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
      return;
    }
    const SL = { open: ['未交货', 'chip-warn'], partial: ['部分交货', 'chip-info'], done: ['已交货', 'chip-ok'], cancelled: ['已取消', 'chip-gray'] };
    const todayStr = UI.today();
    const open = list.filter((r) => r.status === 'open').length;
    const partial = list.filter((r) => r.status === 'partial').length;
    el.querySelector('#tbStat').textContent = `共 ${list.length} 单：未交货 ${open} · 部分交货 ${partial}`;
    const tb = el.querySelector('#tb');
    tb.innerHTML = UI.table([
      { t: '销售单号', f: (r) => `<b>${UI.esc(r.code)}</b><div class="small muted">${UI.esc(r.customer_name || '无客户')}</div>` },
      { t: '产品', f: (r) => `${UI.esc(r.product_name)}<div class="small muted">${UI.esc(r.spec || '')}</div>` },
      { t: '数量', f: (r) => {
          const p = r.qty > 0 ? Math.min(100, Math.round((r.shipped_qty || 0) / r.qty * 100)) : 0;
          return `<span class="mono">${UI.n2(r.qty)}</span> ${UI.esc(r.unit)}
            <div class="row" style="gap:6px;flex-wrap:nowrap">${UI.progress(p, p >= 100 ? 'ok' : '')}<span class="small mono muted">${p}%</span></div>`;
        } },
      { t: '单价 / 金额', f: (r) => `<span class="mono">¥${UI.n2(r.price)}</span><div class="small muted mono">¥${UI.n2(r.qty * r.price)}</div>` },
      { t: '下单 / 交期', f: (r) => `${UI.esc(r.order_date || '—')}
          <div class="small ${r.delivery_date && r.delivery_date < todayStr && ['open', 'partial'].includes(r.status) ? 'chip chip-danger' : 'muted'}">${r.delivery_date ? '交 ' + UI.esc(r.delivery_date) : '未约定交期'}</div>` },
      { t: '生产工单', f: (r) => r.produced_order_id
          ? `<span class="link" data-go="${r.produced_order_id}">${r.has_order ? '查看' : 'WO#' + r.produced_order_id}</span>`
          : '<span class="muted">未转</span>' },
      { t: '状态', f: (r) => { const m = SL[r.status] || [r.status, 'chip-gray']; return `<span class="chip ${m[1]}">${m[0]}</span>`; } },
      canEdit ? { t: '操作', align: 'right', w: '210px', f: (r) => {
          const btns = [];
          if (r.status !== 'cancelled' && r.product_id && !r.produced_order_id) btns.push(`<button class="btn btn-sm btn-primary" data-conv="${r.id}">转工单</button>`);
          if (r.status !== 'cancelled') btns.push(`<button class="btn btn-sm" data-edit="${r.id}">编辑</button>`);
          if (['open', 'partial'].includes(r.status)) btns.push(`<button class="btn btn-sm btn-danger" data-cancel="${r.id}">取消</button>`);
          if (App.isAdmin() && !(r.shipped_qty > 0)) btns.push(`<button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>`);
          return btns.join(' ') || '<span class="muted small">—</span>';
        } } : null,
    ].filter(Boolean), list, { emptyText: '暂无销售订单，点击右上角「新增订单」开始接单' });
    tb.querySelectorAll('[data-go]').forEach((a) => a.onclick = () => location.hash = '#/orders/' + a.dataset.go);
    /* 销售订单批量转工单（对标黑湖批量开工/结案）：勾选后一次转多单 */
    if (canEdit) {
      // 表头插入勾选列（必须新增 th，不能覆盖原第一列，否则表头与数据列错位）
      const headRow = tb.querySelector('table thead tr');
      if (headRow) headRow.insertAdjacentHTML('afterbegin', '<th style="width:36px"></th>');
      const cols = tb.querySelectorAll('table thead th');
      if (cols.length) cols[0].innerHTML = '<input type="checkbox" id="soAll" title="全选本页">';
      tb.querySelectorAll('table tbody tr').forEach((tr, i) => {
        const sid = list[i] && list[i].id;
        if (!sid) return;
        tr.insertAdjacentHTML('afterbegin', `<td style="width:36px"><input type="checkbox" data-so="${sid}"></td>`);
      });
      const bar = document.createElement('div');
      bar.id = 'soBatch';
      bar.style.cssText = 'display:none;gap:8px;margin:0 0 10px;flex-wrap:wrap;align-items:center';
      bar.innerHTML = `<span class="small muted">已选 <b id="soSelN">0</b> 张订单</span>
        <button class="btn btn-sm btn-primary" data-sov="batch">批量转工单</button>
        <button class="btn btn-sm btn-ghost" data-sov="clear">清空选择</button>`;
      tb.parentNode.insertBefore(bar, tb);
      const boxes = () => Array.from(tb.querySelectorAll('[data-so]'));
      const paintBar = () => {
        const n = boxes().filter((c) => c.checked).length;
        bar.style.display = n ? 'flex' : 'none';
        const lbl = bar.querySelector('#soSelN');
        if (lbl) lbl.textContent = String(n);
      };
      boxes().forEach((c) => c.onchange = () => {
        const allBox = tb.querySelector('#soAll');
        if (allBox) allBox.checked = boxes().every((x) => x.checked);
        paintBar();
      });
      const allBox = tb.querySelector('#soAll');
      if (allBox) allBox.onchange = () => { boxes().forEach((c) => { c.checked = allBox.checked; }); paintBar(); };
      bar.querySelectorAll('[data-sov]').forEach((bt) => bt.onclick = async () => {
        const ids = boxes().filter((c) => c.checked).map((c) => Number(c.dataset.so));
        if (!ids.length) return;
        if (bt.dataset.sov === 'clear') { boxes().forEach((c) => { c.checked = false; }); if (allBox) allBox.checked = false; return paintBar(); }
        if (!(await UI.confirm(`确认把 ${ids.length} 张销售订单转成生产工单？（客户与交期自动带入，可稍后在工单中调整）`))) return;
        try {
          const r = await API.post('/sales_orders/convert_batch', { ids });
          const okN = (r && r.ok_count) || 0;
          const failed = (r && r.failed) || [];
          if (failed.length) {
            UI.modal({
              title: `批量转工单完成：成功 ${okN} 单，失败 ${failed.length} 单`, size: 'lg',
              body: UI.table([
                { t: '销售单', f: (x) => `<b>${UI.esc(x.code)}</b>` },
                { t: '原因', f: (x) => `<span style="color:var(--danger)">${UI.esc(x.msg)}</span>` },
              ], failed) + `<div class="small muted" style="margin-top:10px">已成功生成 ${okN} 张工单，可在「生产管理 → 工单管理」查看并下发。</div>`,
              footer: '<button class="btn" data-close>知道了</button>',
            });
          } else UI.toast(`已生成 ${okN} 张生产工单`, 'ok');
          this.render(el);
        } catch (e) { UI.toast(e.message, 'err'); }
      });
    }
    tb.querySelectorAll('[data-conv]').forEach((b) => b.onclick = async () => {
      try {
        const r = await API.post('/sales_orders/' + b.dataset.conv + '/convert', {});
        UI.toast(r.existed ? `该订单已生成过工单 ${r.code}` : `已生成生产工单 ${r.code}（可在「工单」中下发）`, 'ok');
        this.render(el);
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    tb.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => this.salesForm(b.dataset.edit, list.find((x) => x.id == b.dataset.edit)));
    tb.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定取消该销售订单？取消后不可恢复操作（已有出货的订单不可取消）。'))) return;
      try { await API.patch('/sales_orders/' + b.dataset.cancel + '/status', { status: 'cancelled', reason: '手工取消' }); UI.toast('已取消', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
    tb.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirm('确定删除该销售订单？仅限从未出货的订单。'))) return;
      try { await API.del('/sales_orders/' + b.dataset.del); UI.toast('已删除', 'ok'); this.render(el); }
      catch (e) { UI.toast(e.message, 'err'); }
    });
  },

  async salesForm(id, row) {
    if (!this.salesMeta) { try { this.salesMeta = await API.get('/meta'); } catch (e) { this.salesMeta = { products: [], customers: [] }; } }
    const meta = this.salesMeta;
    const isEdit = !!row;
    UI.modal({
      title: isEdit ? '编辑销售订单 ' + row.code : '新增销售订单',
      body: `<div class="grid g2">
        <label class="field"><span>客户</span>
          <select class="input" id="soCust"><option value="">无</option>${UI.options(meta.customers, isEdit ? row.customer_id : '', 'name')}</select></label>
        <label class="field"><span class="label-req">产品</span>
          <select class="input" id="soProd" ${isEdit ? 'disabled' : ''}>${UI.options(meta.products, isEdit ? row.product_id : '', 'name')}</select></label>
        <label class="field"><span class="label-req">数量</span><input class="input" id="soQty" type="number" min="0.01" step="any" value="${isEdit ? row.qty : ''}"></label>
        <label class="field"><span>单价(¥)</span><input class="input" id="soPrice" type="number" min="0" step="any" value="${isEdit ? row.price : ''}"></label>
        <label class="field"><span>下单日期</span><input class="input" type="date" id="soDate" value="${isEdit ? row.order_date : UI.today()}"></label>
        <label class="field"><span>交货日期</span><input class="input" type="date" id="soDeliver" value="${isEdit ? (row.delivery_date || '') : ''}"></label>
      </div>
      <label class="field"><span>备注</span><input class="input" id="soRemark" value="${isEdit ? UI.esc(row.remark || '') : ''}"></label>
      ${isEdit ? '' : '<div class="small muted">保存后可在列表中「转工单」一键生成生产工单（自动带客户与交期）；出货时在「成品出库」填该销售单号即可自动核销。</div>'}`,
      onOk: async (mask) => {
        const g = (s) => mask.querySelector(s).value;
        const payload = {
          customer_id: g('#soCust') || null,
          qty: g('#soQty'), price: g('#soPrice'),
          order_date: g('#soDate'), delivery_date: g('#soDeliver') || null,
          remark: g('#soRemark'),
        };
        if (isEdit) await API.put('/sales_orders/' + row.id, payload);
        else { payload.product_id = g('#soProd'); await API.post('/sales_orders', payload); }
        UI.toast(isEdit ? '已保存' : '销售订单已创建', 'ok');
        this.render(document.getElementById('view'));
      },
    });
  },

  async renderProd(el) {
    el.innerHTML = `
      <div class="tabs">
        ${this.tabs.map(([k, t]) => `<div class="tab ${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</div>`).join('')}
      </div>
      <div class="card">
        <div class="card-h"><h3>产销库存报表</h3>
          <div style="display:flex;gap:10px;align-items:center">
            <span id="tbStat" class="small muted"></span>
            <label class="small muted" style="display:flex;gap:4px;align-items:center;cursor:pointer">
              <input type="checkbox" id="onlyDiff"> 仅显示有差异</label>
            <button class="btn btn-sm" id="exp">导出 CSV</button>
            ${App.canEdit() ? `<button class="btn btn-sm btn-primary" id="syncFin">同步完工入库</button>` : ''}
          </div>
        </div>
        <div class="card-b" id="tb">加载中…</div>
      </div>`;
    el.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () => { this.tab = t.dataset.tab; this.render(el); });
    el.querySelector('#exp').onclick = () => this.exportProd();
    el.querySelector('#onlyDiff').onchange = () => this.paintProd(el);
    const syncBtn = el.querySelector('#syncFin');
    if (syncBtn) syncBtn.onclick = () => this.syncFinished(el);
    try {
      this.prod = await API.get('/stats/production-stock');
    } catch (e) {
      el.querySelector('#tb').innerHTML = `<div class="empty">${UI.icon('warn')}<div>${UI.esc(e.message)}</div></div>`;
      return;
    }
    this.paintProd(el);
  },

  // 同步完工入库：按各工单「末道完工量 − 自动入库量」差额补生成成品入库单（幂等，可反复执行）
  async syncFinished(el) {
    if (!confirm('将按各工单「末道完工量 − 已自动入库量」的差额补生成成品入库单。\n可反复执行（幂等），用于把历史报工未入库的完工量补进成品库。是否继续？')) return;
    try {
      const r = await API.post('/warehouse/sync_finished', {});
      UI.toast(`已补齐 ${r.created} 张入库单 / ${r.qty} 件（重算 ${r.removed} 张）`, 'ok');
      await this.render(el);
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  prodAlert(r) {
    const q = Number(r.stock) || 0;
    const mn = r.safe_min == null ? null : Number(r.safe_min);
    const mx = r.safe_max == null ? null : Number(r.safe_max);
    if (mn !== null && q < mn) return '<span class="chip chip-danger">缺料预警</span>';
    if (mx !== null && mx > 0 && q > mx) return '<span class="chip chip-warn">库存积压</span>';
    return '<span class="chip chip-ok">正常</span>';
  },
  prodAlertText(r) {
    const q = Number(r.stock) || 0;
    const mn = r.safe_min == null ? null : Number(r.safe_min);
    const mx = r.safe_max == null ? null : Number(r.safe_max);
    if (mn !== null && q < mn) return '缺料预警';
    if (mx !== null && mx > 0 && q > mx) return '库存积压';
    return '正常';
  },

  paintProd(el) {
    const data = this.prod || { summary: {}, rows: [] };
    const s = data.summary || {};
    const onlyDiff = el.querySelector('#onlyDiff').checked;
    const rows = (data.rows || []).filter((r) => !onlyDiff || (Number(r.diff) || 0) !== 0);

    const stat = el.querySelector('#tbStat');
    if (stat) stat.innerHTML = `共 ${rows.length} 个产品 · 待入库合计 <b style="color:${ (Number(s.diff) || 0) !== 0 ? 'var(--danger)' : 'var(--ok)'}">${UI.n2(s.diff || 0)}</b>`;

    const cards = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="stat"><div class="stat-l">产品数</div><div class="stat-v">${rows.length}</div><div class="stat-s">项</div></div>
        <div class="stat"><div class="stat-l">工单计划合计</div><div class="stat-v">${UI.n2(s.plan || 0)}</div><div class="stat-s">件</div></div>
        <div class="stat"><div class="stat-l">末道完工合计</div><div class="stat-v" style="color:var(--ok)">${UI.n2(s.done || 0)}</div><div class="stat-s">件</div></div>
        <div class="stat"><div class="stat-l">工单入库合计</div><div class="stat-v" style="color:var(--primary)">${UI.n2(s.inQty || 0)}</div><div class="stat-s">件</div></div>
        <div class="stat"><div class="stat-l">当前成品库存</div><div class="stat-v"><b>${UI.n2(s.stock || 0)}</b></div><div class="stat-s">件</div></div>
        <div class="stat"><div class="stat-l">待入库差额</div><div class="stat-v" style="color:${ (Number(s.diff) || 0) !== 0 ? 'var(--danger)' : 'var(--ok)'}">${UI.n2(s.diff || 0)}</div><div class="stat-s">完工 − 入库</div></div>
      </div>`;

    const head = `<table class="table"><thead><tr>
      <th style="width:28px"></th>
      <th>产品编码</th><th>产品名称</th><th>单位</th>
      <th class="r">工单计划</th><th class="r">末道完工</th><th class="r">工单入库</th>
      <th class="r">当前库存</th><th class="r">待入库</th><th>库存预警</th>
    </tr></thead><tbody>`;

    const body = rows.map((r) => {
      const d = Number(r.diff) || 0;
      return `<tr class="prod-row" data-code="${UI.esc(r.product_code)}" style="cursor:pointer">
        <td class="chev">▸</td>
        <td><b>${UI.esc(r.product_code)}</b></td>
        <td>${UI.esc(r.product_name)}${r.spec ? ` <span class="small muted">${UI.esc(r.spec)}</span>` : ''}</td>
        <td>${UI.esc(r.unit || '')}</td>
        <td class="r"><span class="mono">${UI.n2(r.plan)}</span></td>
        <td class="r"><span class="mono" style="color:var(--ok)">${UI.n2(r.done)}</span></td>
        <td class="r"><span class="mono" style="color:var(--primary)">${UI.n2(r.inQty)}</span></td>
        <td class="r"><b class="mono">${UI.n2(r.stock)}</b></td>
        <td class="r"><span class="mono" style="color:${d !== 0 ? 'var(--danger)' : 'var(--text3)'}">${d > 0 ? '+' : ''}${UI.n2(d)}</span></td>
        <td>${this.prodAlert(r)}</td>
      </tr>
      <tr class="prod-detail" data-detail="${UI.esc(r.product_code)}" style="display:none">
        <td colspan="10"><div style="padding:6px 4px">${this.prodOrdersHtml(r.orders)}</div></td>
      </tr>`;
    }).join('');

    const table = head + (body || `<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">暂无产品数据</td></tr>`) + '</tbody></table>';

    el.querySelector('#tb').innerHTML = cards + `<div class="table-wrap">${table}</div>`;

    el.querySelectorAll('.prod-row').forEach((tr) => {
      tr.onclick = () => {
        const code = tr.dataset.code;
        const det = el.querySelector('.prod-detail[data-detail="' + CSS.escape(code) + '"]');
        if (!det) return;
        const open = det.style.display === 'none';
        det.style.display = open ? 'table-row' : 'none';
        tr.querySelector('.chev').textContent = open ? '▾' : '▸';
      };
    });
  },

  prodOrdersHtml(orders) {
    if (!orders || !orders.length) return '<span class="muted">该产品暂无工单</span>';
    const head = `<table class="table" style="margin:0"><thead><tr>
      <th>工单号</th><th>状态</th><th class="r">计划</th><th class="r">末道完工</th>
      <th class="r">工单入库</th><th class="r">差额</th></tr></thead><tbody>`;
    const body = orders.map((o) => {
      const d = Number(o.diff) || 0;
      return `<tr>
        <td><b>${UI.esc(o.code)}</b></td>
        <td>${UI.badge(o.status)}</td>
        <td class="r"><span class="mono">${UI.n2(o.plan)}</span></td>
        <td class="r"><span class="mono" style="color:var(--ok)">${UI.n2(o.done)}</span></td>
        <td class="r"><span class="mono" style="color:var(--primary)">${UI.n2(o.inQty)}</span></td>
        <td class="r"><span class="mono" style="color:${d !== 0 ? 'var(--danger)' : 'var(--text3)'}">${d > 0 ? '+' : ''}${UI.n2(d)}</span></td>
      </tr>`;
    }).join('');
    return head + body + '</tbody></table>';
  },

  exportProd() {
    const data = this.prod || { summary: {}, rows: [] };
    const s = data.summary || {};
    const lines = ['【产销库存报表】 生成时间 ' + new Date().toLocaleString()];
    lines.push('产品数,工单计划合计,末道完工合计,工单入库合计,当前成品库存,待入库差额');
    lines.push([s.product_count || 0, s.plan || 0, s.done || 0, s.inQty || 0, s.stock || 0, s.diff || 0].join(','));
    lines.push('', '【产品汇总】', '产品编码,产品名称,规格,单位,工单计划,末道完工,工单入库,当前库存,待入库,库存预警');
    (data.rows || []).forEach((r) => lines.push([
      r.product_code, r.product_name, r.spec || '', r.unit || '',
      r.plan, r.done, r.inQty, r.stock, r.diff, this.prodAlertText(r),
    ].join(',')));
    lines.push('', '【工单明细】', '产品编码,工单号,状态,计划,末道完工,工单入库,差额');
    (data.rows || []).forEach((r) => (r.orders || []).forEach((o) => lines.push([
      r.product_code, o.code, o.status, o.plan, o.done, o.inQty, o.diff,
    ].join(','))));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `产销库存报表_${UI.today()}.csv`;
    a.click();
    UI.toast('已导出 CSV', 'ok');
  },
};
