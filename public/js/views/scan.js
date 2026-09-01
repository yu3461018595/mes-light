/* 扫码报单：为工单 / 员工生成微信可扫的报工二维码（管理员 / 班组长） */
window.Views = window.Views || {};
Views.scan = {
  title: '扫码报单',
  icon: 'scan',

  async render(el) {
    if (!App.canEdit()) {
      el.innerHTML = `<div class="empty">${UI.icon('warn')}<div>仅管理员 / 班组长可生成报工二维码</div></div>`;
      return;
    }
    const [meta, orders] = await Promise.all([
      API.get('/meta'),
      API.get('/orders?status=released,running,paused'),
    ]);
    const workers = meta.workers;

    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>使用说明</h3></div>
        <div class="card-b" style="line-height:1.9">
          <p>① 在下方为 <b>工单</b> 或 <b>员工</b> 生成报工二维码；<br>
          ② 将二维码打印张贴到机台，或保存图片后通过微信发给员工；<br>
          ③ 员工用微信 <b>「扫一扫」</b> 打开报工页，免登录即可填报产量。</p>
          <p class="small muted">工单码：谁扫都能报（适合机台公共码）；员工码：绑定本人，仅该员工可报（适合个人报工）。</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>工单报工码</h3><span class="small muted">${orders.length} 张在制工单</span></div>
        <div class="card-b tight">
          ${orders.length ? orders.map((o) => `
            <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line2)">
              <div>
                <b>${UI.esc(o.code)}</b> <span class="small muted">${UI.esc(o.product_name)} · 计划 ${UI.n2(o.qty_plan)}</span>
                <div class="small muted">完工 ${UI.n2(o.qty_done)} ${UI.badge(o.status)}</div>
              </div>
              <button class="btn btn-sm btn-primary" data-oq="${o.id}">${UI.icon('scan')}生成二维码</button>
            </div>`).join('') : `<div class="empty">${UI.icon('empty')}<div>暂无在制工单</div></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>员工报工码</h3><span class="small muted">${workers.length} 人</span></div>
        <div class="card-b tight">
          ${workers.length ? workers.map((w) => `
            <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line2)">
              <div>
                <b>${UI.esc(w.name)}</b> <span class="small muted">${UI.esc(w.team || '')} · ${UI.esc(w.username)}</span>
              </div>
              <button class="btn btn-sm btn-primary" data-wq="${w.id}">${UI.icon('scan')}生成二维码</button>
            </div>`).join('') : `<div class="empty">${UI.icon('empty')}<div>暂无人员</div></div>`}
        </div>
      </div>`;

    el.querySelectorAll('[data-oq]').forEach((b) => b.onclick = async () => {
      try {
        const d = await API.get('/qr/order/' + b.dataset.oq);
        UI.qrModal('工单报工码 · ' + d.order.code, {
          svg: d.svg, url: d.url, subtitle: d.order.product_name + ' · 微信扫一扫即可报工', fileName: '工单_' + d.order.code,
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    el.querySelectorAll('[data-wq]').forEach((b) => b.onclick = async () => {
      try {
        const d = await API.get('/qr/worker/' + b.dataset.wq);
        UI.qrModal('员工报工码 · ' + d.worker.name, {
          svg: d.svg, url: d.url,
          subtitle: (d.worker.team ? d.worker.team + ' · ' : '') + '微信扫一扫即可报工',
          fileName: '员工_' + d.worker.name,
        });
      } catch (e) { UI.toast(e.message, 'err'); }
    });
  },
};
