/* 通用 UI 工具：转义、提示、弹窗、表格、自绘 SVG 图表（不依赖任何 CDN） */
window.UI = (function () {

  /* ---------- 基础 ---------- */
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const n2 = (n) => Number(n || 0).toLocaleString('zh-CN');
  const f1 = (n) => (Math.round(Number(n || 0) * 10) / 10).toFixed(1);
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const md = (s) => (s ? String(s).slice(5).replace('-', '/') : '');
  const hours = (min) => f1((min || 0) / 60) + ' h';

  const STATUS = {
    created: ['待下发', 'b-created'], released: ['已下发', 'b-released'],
    running: ['生产中', 'b-running'], paused: ['已暂停', 'b-paused'],
    done: ['已完成', 'b-done'], closed: ['已关闭', 'b-closed'],
    pending: ['待生产', 'b-pending'],
  };
  const badge = (s) => {
    const m = STATUS[s] || [s, 'b-created'];
    return `<span class="badge ${m[1]}">${m[0]}</span>`;
  };
  const PRIORITY = { 1: ['高', 'chip-danger'], 2: ['中', 'chip-warn'], 3: ['低', 'chip-gray'] };
  const prioChip = (p) => {
    const m = PRIORITY[p] || PRIORITY[2];
    return `<span class="chip ${m[1]}">${m[0]}</span>`;
  };
  const WC_STATUS = { idle: ['空闲', 'chip-gray'], running: ['运转', 'chip-ok'], fault: ['故障', 'chip-danger'], maintain: ['保养', 'chip-warn'] };

  const ICONS = {
    dash: '<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>',
    orders: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    report: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    basic: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    stats: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    log: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    empty: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
  };
  const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;

  /* ---------- 提示 ---------- */
  function toast(msg, type) {
    const root = document.getElementById('toastRoot');
    const d = document.createElement('div');
    d.className = 'toast ' + (type || '');
    d.textContent = msg;
    root.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = '.3s'; }, 2000);
    setTimeout(() => d.remove(), 2400);
  }

  /* ---------- 弹窗 ---------- */
  function modal(opt) {
    const root = document.getElementById('modalRoot');
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="modal ${opt.size === 'xl' ? 'modal-xl' : opt.size === 'lg' ? 'modal-lg' : ''}">
        <div class="modal-h"><h3>${esc(opt.title || '')}</h3>
          <button class="icon-btn" data-close>${icon('close')}</button></div>
        <div class="modal-b">${opt.body || ''}</div>
        ${opt.footer === null ? '' : `<div class="modal-f">${opt.footer !== undefined ? opt.footer :
        `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>确定</button>`}</div>`}
      </div>`;
    root.appendChild(mask);
    const close = () => mask.remove();
    mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-close]')) close(); });
    const okBtn = mask.querySelector('[data-ok]');
    if (okBtn && opt.onOk) okBtn.onclick = async () => {
      okBtn.disabled = true;
      try { if (await opt.onOk(mask) !== false) close(); } catch (err) { toast(err.message, 'err'); }
      finally { okBtn.disabled = false; }
    };
    if (opt.onMount) opt.onMount(mask, close);
    mask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && okBtn) okBtn.click(); });
    const firstInput = mask.querySelector('input,select,textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 60);
    return { el: mask, close, body: mask.querySelector('.modal-b') };
  }

  function confirm(msg, title) {
    return new Promise((resolve) => {
      const m = modal({
        title: title || '确认操作',
        body: `<p style="line-height:1.7">${esc(msg)}</p>`,
        footer: `<button class="btn" data-close>取消</button>
                 <button class="btn btn-danger" data-ok>确定</button>`,
        onOk: () => { resolve(true); },
      });
      m.el.addEventListener('click', (e) => { if (e.target === m.el) resolve(false); });
      m.el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
    });
  }

  /* ---------- 二维码弹窗（扫码报工） ---------- */
  function qrModal(title, p) {
    const m = modal({
      title: title || '扫码报工',
      size: 'lg',
      body: `
        <div class="qr-wrap">
          <div class="qr-box">${p.svg || `<div class="qr-ph">静态版暂未生成二维码图片<br><small>请复制下方链接在微信中打开</small></div>`}</div>
          <p class="qr-sub">${esc(p.subtitle || '用微信「扫一扫」即可打开报工页')}</p>
          <label class="field" style="margin-top:12px"><span>报工链接（也可直接发给员工，在微信中打开）</span>
            <input class="input" id="qrUrl" readonly value="${esc(p.url)}"></label>
          <div class="row" style="gap:10px;margin-top:8px">
            <button class="btn btn-primary" id="qrCopy">复制链接</button>
            <button class="btn" id="qrPng">下载二维码图片</button>
          </div>
        </div>`,
      footer: `<button class="btn" data-close>关闭</button>`,
      onMount: (mask) => {
        mask.querySelector('#qrCopy').onclick = () => {
          const inp = mask.querySelector('#qrUrl');
          inp.select();
          try {
            if (navigator.clipboard) navigator.clipboard.writeText(inp.value);
            else document.execCommand('copy');
          } catch (e) { try { document.execCommand('copy'); } catch (e2) {} }
          toast('链接已复制', 'ok');
        };
        mask.querySelector('#qrPng').onclick = () => {
          const svg = mask.querySelector('.qr-box svg');
          if (!svg) { toast('静态版未生成二维码图片，请复制链接', 'err'); return; }
          const xml = new XMLSerializer().serializeToString(svg);
          const img = new Image();
          img.onload = () => {
            const w = Number(svg.getAttribute('width')) || 200;
            const h = Number(svg.getAttribute('height')) || 200;
            const scale = 4;
            const c = document.createElement('canvas');
            c.width = w * scale; c.height = h * scale;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(img, 0, 0, c.width, c.height);
            const a = document.createElement('a');
            a.download = (p.fileName || 'qrcode') + '.png';
            a.href = c.toDataURL('image/png');
            a.click();
          };
          img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
        };
      },
    });
    return m;
  }

  /* ---------- 表格 ---------- */
  function table(cols, rows, opt = {}) {
    if (!rows.length) {
      return `<div class="empty">${icon('empty')}<div>${esc(opt.emptyText || '暂无数据')}</div></div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr>${cols.map((c) => `<th style="${c.w ? 'width:' + c.w : ''}${c.align ? ';text-align:' + c.align : ''}">${esc(c.t)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr${opt.onRow ? ` data-row="${i}" style="cursor:pointer"` : ''}>${cols.map((c) =>
        `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${c.f ? c.f(r, i) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  }

  const options = (list, val, labelKey = 'name', valKey = 'id') =>
    list.map((x) => `<option value="${esc(x[valKey])}"${String(x[valKey]) === String(val) ? ' selected' : ''}>${esc(x[labelKey])}</option>`).join('');

  /* ---------- 图表（纯 SVG） ---------- */
  /* 说明：全局样式里有 svg{fill:none;stroke:currentColor;stroke-width:1.9}，
     而 stroke/fill 是可继承属性 —— 图表里的 <text> 会继承到 currentColor 描边，
     字被描一圈边所以发虚。已在 app.css 用 .chart text{stroke:none} 统一关掉。 */

  // 图表容器：点击可放大；title 用于放大弹窗标题
  const chartBox = (svgHtml, title, legendHtml) =>
    `<div class="chart-box" data-zoom data-title="${esc(title || '图表')}" title="点击放大">${svgHtml}${legendHtml || ''}</div>`;

  function lineChart(rows, series, opt = {}) {
    const W = opt.w || 640, H = opt.h || 230, PL = 52, PR = 18, PT = 16, PB = 30;
    if (!rows.length) return `<div class="empty">${icon('empty')}<div>暂无数据</div></div>`;
    let max = 0;
    rows.forEach((r) => series.forEach((s) => { max = Math.max(max, Number(r[s.key]) || 0); }));
    max = Math.max(1, Math.ceil(max / 4) * 4);
    const iw = W - PL - PR, ih = H - PT - PB;
    const X = (i) => PL + (rows.length === 1 ? iw / 2 : (i * iw) / (rows.length - 1));
    const Y = (v) => PT + ih - (v / max) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const y = PT + (ih * i) / 4;
      g += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#e6eaf0" stroke-width="1"/>
            <text x="${PL - 8}" y="${y + 5}" font-size="13" font-weight="500" fill="#5b6673" text-anchor="end">${n2(max - (max * i) / 4)}</text>`;
    }
    let paths = '', dots = '';
    series.forEach((s) => {
      const d = rows.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(Number(r[s.key]) || 0).toFixed(1)}`).join(' ');
      if (s.area !== false) {
        paths += `<path d="${d} L${X(rows.length - 1).toFixed(1)},${PT + ih} L${X(0).toFixed(1)},${PT + ih} Z" fill="${s.color}" opacity=".08"/>`;
      }
      paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (rows.length <= 31) {
        rows.forEach((r, i) => {
          dots += `<circle cx="${X(i).toFixed(1)}" cy="${Y(Number(r[s.key]) || 0).toFixed(1)}" r="${rows.length > 15 ? 2.5 : 3.5}" fill="#fff" stroke="${s.color}" stroke-width="1.8"/>`;
        });
      }
    });
    // X 轴标签：按可用宽度估算间隔，避免标签互相重叠
    const perLabel = 62;
    const maxTicks = Math.max(2, Math.floor(iw / perLabel));
    const step = Math.max(1, Math.ceil(rows.length / maxTicks));
    let xlab = '';
    rows.forEach((r, i) => {
      if (i % step === 0 || i === rows.length - 1) {
        xlab += `<text x="${X(i).toFixed(1)}" y="${H - 9}" font-size="12.5" font-weight="500" fill="#5b6673" text-anchor="middle">${esc(md(r.d || r.name))}</text>`;
      }
    });
    const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}${paths}${dots}${xlab}</svg>`;
    const legend = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
    return chartBox(svg, opt.title || '趋势图', legend);
  }

  function barChart(rows, opt = {}) {
    const color = opt.color || '#1d4ed8';
    if (!rows.length) return `<div class="empty">${icon('empty')}<div>暂无数据</div></div>`;
    const max = Math.max(1, ...rows.map((r) => Number(r.qty || r.value || 0)));
    const rowH = 36, W = 640, padL = Math.min(130, opt.labelW || 96);
    const H = rows.length * rowH + 10;
    const bw = W - padL - 60;
    const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${rows.map((r, i) => {
      const v = Number(r.qty || r.value || 0);
      const w = Math.max(2, (v / max) * bw);
      const y = i * rowH + 8;
      return `<text x="${padL - 10}" y="${y + 15}" font-size="14.5" font-weight="500" fill="#39414d" text-anchor="end">${esc(r.name)}</text>
        <rect x="${padL}" y="${y + 2}" width="${w.toFixed(1)}" height="19" rx="5" fill="${color}" opacity="${0.92 - i * 0.06}"/>
        <text x="${padL + w + 9}" y="${y + 16}" font-size="14.5" fill="#141b24" font-weight="700">${n2(v)}${esc(r.unit || '')}</text>`;
    }).join('')}</svg>`;
    return chartBox(svg, opt.title || '排行图');
  }

  /* ---------- 图表点击放大 ---------- */
  // 用事件委托：看板每 30 秒整块重绘，委托到 document 才能一直生效
  let _zoomBound = false;
  function bindChartZoom() {
    if (_zoomBound) return;
    _zoomBound = true;
    document.addEventListener('click', (e) => {
      if (!e.target || !e.target.closest) return;
      const box = e.target.closest('.chart-box[data-zoom]');
      if (box) chartZoom(box);
    });
  }

  function chartZoom(box) {
    if (!box.querySelector('svg')) return;
    modal({
      title: box.dataset.title || '图表',
      size: 'xl',
      body: '<div class="chart-zoom"></div>',
      footer: '<button class="btn" data-close>关闭</button>',
      onMount: (mask) => {
        const holder = mask.querySelector('.chart-zoom');
        if (!holder) return;
        // 整块复制（含图例），避免只放大图形却丢了标注
        const copy = document.createElement('div');
        copy.className = 'chart-zoom-inner';
        copy.innerHTML = box.innerHTML;
        const sv = copy.querySelector('svg');
        if (sv) sv.classList.add('chart-zoom-svg');
        holder.appendChild(copy);
        const onKey = (ev) => {
          if (ev.key === 'Escape') {
            document.removeEventListener('keydown', onKey);
            mask.remove();
          }
        };
        document.addEventListener('keydown', onKey);
      },
    });
  }
  bindChartZoom();

  function ring(p, opt = {}) {
    const size = opt.size || 118, sw = opt.sw || 11, r = (size - sw) / 2, c = 2 * Math.PI * r;
    p = Math.max(0, Math.min(100, p || 0));
    const color = opt.color || (p >= 100 ? '#0f9d58' : p >= 60 ? '#1d4ed8' : p >= 30 ? '#e08a00' : '#d93b3b');
    return `<div class="ring" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#eef1f5" stroke-width="${sw}"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
          stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${(c * (1 - p / 100)).toFixed(1)}"
          transform="rotate(-90 ${size / 2} ${size / 2})"/>
      </svg>
      <div class="ring-b"><b>${f1(p)}%</b><span>${esc(opt.label || '达成率')}</span></div></div>`;
  }

  const progress = (p, cls) => `<div class="bar ${cls || ''}"><i style="width:${Math.min(100, Math.max(0, p || 0))}%"></i></div>`;

  return {
    esc, n2, f1, pct, today, md, hours, badge, prioChip, STATUS, WC_STATUS, ICONS, icon,
    toast, modal, confirm, qrModal, table, options, lineChart, barChart, chartZoom, ring, progress,
  };
})();
