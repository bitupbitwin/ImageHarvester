/* grabber.js —— 抓取结果页逻辑 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const grid = $('#grid');
  const emptyState = $('#emptyState');
  const emptyText = $('#emptyText');

  /** 全部图片记录： { url, width, height, alt, source, el, selected, loaded, broken, fmt } */
  let items = [];
  let session = null;

  // ---------- 工具函数 ----------
  function getFormat(url) {
    if (/^data:image\/([a-z0-9+.-]+)/i.test(url)) {
      return RegExp.$1.replace('svg+xml', 'svg').toLowerCase();
    }
    const clean = url.split('?')[0].split('#')[0];
    const m = clean.match(/\.([a-z0-9]{2,5})$/i);
    if (m) {
      let e = m[1].toLowerCase();
      if (e === 'jpeg') e = 'jpg';
      if (['png', 'jpg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff'].includes(e)) {
        return e;
      }
    }
    return 'other';
  }

  function baseName(url) {
    if (/^data:/i.test(url)) return 'image';
    try {
      const u = new URL(url);
      let n = decodeURIComponent(u.pathname.split('/').pop() || '');
      n = n.split('?')[0];
      return n || u.hostname;
    } catch (e) {
      return 'image';
    }
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|\n\r\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  // 单个图片的文件名（不含子文件夹前缀）
  function entryName(item, index) {
    let name = baseName(item.url);
    const fmt = item.fmt === 'other' ? '' : item.fmt;
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      name = name + (fmt ? '.' + (fmt === 'svg' ? 'svg' : fmt) : '');
    }
    if (!name || name === '.' + fmt) {
      name = 'image_' + (index + 1) + (fmt ? '.' + fmt : '');
    }
    return sanitize(name);
  }

  function filenameFor(item, index) {
    const name = entryName(item, index);
    const folder = sanitize($('#folderName').value || '');
    return folder ? folder + '/' + name : name;
  }

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  // ---------- 双滑块范围组件 ----------
  // 左手柄=下限、右手柄=上限；右手柄贴在最右端时视为"不设上限"，
  // 这样后续图片加载出更大尺寸时不会被旧上限误过滤。
  function createDualSlider(rootId, labelId, onChange) {
    const root = $('#' + rootId);
    const lo = root.querySelector('.range-min');
    const hi = root.querySelector('.range-max');
    const fill = root.querySelector('.fill');
    const label = $('#' + labelId);

    function render() {
      const max = Math.max(10, +lo.max);
      const l = +lo.value;
      const h = +hi.value;
      fill.style.left = (l / max * 100) + '%';
      fill.style.width = (Math.max(0, h - l) / max * 100) + '%';
      label.textContent = l + ' – ' + h;
      // 两手柄挤在同一端时，把"还能动"的那只放到上层
      const bothHigh = l > max * 0.66 && h > max * 0.66;
      lo.style.zIndex = bothHigh ? 4 : 3;
      hi.style.zIndex = bothHigh ? 3 : 4;
    }

    function setMax(m) {
      m = Math.max(10, Math.ceil(m / 10) * 10);
      if (+lo.max === m) return;
      const hiWasAtMax = +hi.value >= +hi.max;
      lo.max = m;
      hi.max = m;
      if (hiWasAtMax) hi.value = m; // 保持"不设上限"
      if (+lo.value > m) lo.value = m;
      render();
    }

    function values() {
      return { lo: +lo.value, hi: +hi.value, noCap: +hi.value >= +hi.max };
    }

    lo.addEventListener('input', () => {
      if (+lo.value > +hi.value) lo.value = hi.value;
      render();
      onChange();
    });
    hi.addEventListener('input', () => {
      if (+hi.value < +lo.value) hi.value = lo.value;
      render();
      onChange();
    });

    render();
    return { setMax, values };
  }

  let widthSlider = null;
  let heightSlider = null;

  // 根据当前已知的图片尺寸更新滑块量程
  function updateSliderBounds() {
    if (!widthSlider) return;
    let mw = 0;
    let mh = 0;
    items.forEach((it) => {
      if (it.width > mw) mw = it.width;
      if (it.height > mh) mh = it.height;
    });
    widthSlider.setMax(mw || 1000);
    heightSlider.setMax(mh || 1000);
  }

  // ---------- 加载会话数据 ----------
  async function init() {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    if (!sessionId) {
      showEmpty('缺少会话参数。');
      return;
    }
    const store = await chrome.storage.local.get(sessionId);
    session = store[sessionId];
    if (!session) {
      showEmpty('会话数据已过期，请重新点击插件图标抓取。');
      return;
    }

    if (session.info) {
      renderInfo(session.title, session.message);
      return;
    }

    $('#pageInfo').textContent = (session.pageTitle ? session.pageTitle + ' — ' : '') + (session.pageUrl || '');
    document.title = '图片抓取器 · ' + (session.images.length) + ' 张图片';

    items = (session.images || []).map((im) => ({
      url: im.url,
      width: im.width || 0,
      height: im.height || 0,
      alt: im.alt || '',
      source: im.source || 'img',
      fmt: getFormat(im.url),
      selected: false,
      loaded: false,
      broken: false,
      el: null,
      order: 0,
    }));
    items.forEach((it, i) => (it.order = i));

    if (!items.length) {
      showEmpty('未在该页面找到图片。');
      updateCounts();
      return;
    }

    const refilterDebounced = debounce(applyFilters, 150);
    widthSlider = createDualSlider('widthRange', 'widthValue', refilterDebounced);
    heightSlider = createDualSlider('heightRange', 'heightValue', refilterDebounced);
    updateSliderBounds();

    buildFormatOptions();
    renderGrid();
    bindToolbar();
    updateCounts();
  }

  function showEmpty(text) {
    emptyText.textContent = text;
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
  }

  function renderInfo(title, message) {
    document.title = '图片抓取器 · ' + (title || '提示');
    $('#toolbar').classList.add('hidden');
    $('#pageInfo').textContent = '';
    showEmpty('');
    emptyState.innerHTML =
      '<div class="empty-icon">⚠️</div>' +
      '<h2 style="margin:0 0 8px;font-size:18px;">' + escapeHtml(title || '提示') + '</h2>' +
      '<p style="max-width:460px;margin:0 auto;line-height:1.6;">' + escapeHtml(message || '') + '</p>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- 构建格式下拉 ----------
  function buildFormatOptions() {
    const sel = $('#formatFilter');
    const fmts = Array.from(new Set(items.map((i) => i.fmt))).sort();
    fmts.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.toUpperCase();
      sel.appendChild(opt);
    });
  }

  // ---------- 渲染卡片 ----------
  function renderGrid() {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.idx = idx;

      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = it.url;
      img.alt = it.alt || '';
      img.addEventListener('load', () => {
        it.loaded = true;
        if (img.naturalWidth) it.width = Math.max(it.width, img.naturalWidth);
        if (img.naturalHeight) it.height = Math.max(it.height, img.naturalHeight);
        updateBadge(card, it);
        refilterSoon();
      });
      img.addEventListener('error', () => {
        it.broken = true;
        card.classList.add('broken');
        refilterSoon();
      });
      wrap.appendChild(img);

      const check = document.createElement('div');
      check.className = 'check';
      check.textContent = '';
      wrap.appendChild(check);

      const fmtBadge = document.createElement('div');
      fmtBadge.className = 'fmt-badge';
      fmtBadge.textContent = it.fmt === 'other' ? '?' : it.fmt;
      wrap.appendChild(fmtBadge);

      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = dimText(it);
      wrap.appendChild(badge);

      card.appendChild(wrap);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.title = it.url;
      nameSpan.textContent = baseName(it.url);
      const open = document.createElement('a');
      open.className = 'open';
      open.href = it.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = '原图';
      open.addEventListener('click', (e) => e.stopPropagation());
      meta.appendChild(nameSpan);
      meta.appendChild(open);
      card.appendChild(meta);

      card.addEventListener('click', () => toggleSelect(idx));

      it.el = card;
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }

  function dimText(it) {
    if (it.width && it.height) return it.width + '×' + it.height;
    return '加载中…';
  }
  function updateBadge(card, it) {
    const b = card.querySelector('.badge');
    if (b) b.textContent = dimText(it);
  }

  // ---------- 选择 ----------
  function toggleSelect(idx) {
    const it = items[idx];
    if (it.el.classList.contains('filtered-out')) return;
    it.selected = !it.selected;
    it.el.classList.toggle('selected', it.selected);
    it.el.querySelector('.check').textContent = it.selected ? '✓' : '';
    updateCounts();
  }

  function setSelectAllVisible(state) {
    items.forEach((it) => {
      if (it._visible) {
        it.selected = state;
        it.el.classList.toggle('selected', state);
        it.el.querySelector('.check').textContent = state ? '✓' : '';
      }
    });
    updateCounts();
  }

  function updateCounts() {
    const sel = items.filter((i) => i.selected && i._visible);
    $('#selectedCount').textContent = sel.length;
    const visible = items.filter((i) => i._visible).length;
    $('#totalCount').textContent = visible;
    const btn = $('#downloadBtn');
    btn.textContent = '下载选中 (' + sel.length + ')';
    btn.disabled = sel.length === 0;
  }

  // ---------- 筛选 & 排序 ----------
  function applyFilters() {
    updateSliderBounds();
    const wr = widthSlider ? widthSlider.values() : { lo: 0, hi: Infinity, noCap: true };
    const hr = heightSlider ? heightSlider.values() : { lo: 0, hi: Infinity, noCap: true };
    const fmt = $('#formatFilter').value;
    const kw = ($('#keyword').value || '').trim().toLowerCase();
    const hideBroken = $('#hideBroken').checked;

    items.forEach((it) => {
      let ok = true;
      // 尺寸范围：未知尺寸（未加载完）暂时视为通过，加载后会再次触发筛选
      if (it.width) {
        if (it.width < wr.lo) ok = false;
        if (!wr.noCap && it.width > wr.hi) ok = false;
      }
      if (it.height) {
        if (it.height < hr.lo) ok = false;
        if (!hr.noCap && it.height > hr.hi) ok = false;
      }
      if (fmt && it.fmt !== fmt) ok = false;
      if (kw && it.url.toLowerCase().indexOf(kw) === -1) ok = false;
      if (hideBroken) {
        if (it.broken) ok = false;
        // 超小图（已加载且尺寸 < 16）过滤
        if (it.loaded && it.width && it.height && it.width < 16 && it.height < 16) ok = false;
      }
      it._visible = ok;
      if (it.el) {
        it.el.classList.toggle('hidden', !ok);
        it.el.classList.toggle('filtered-out', !ok);
        if (!ok && it.selected) {
          it.selected = false;
          it.el.classList.remove('selected');
          it.el.querySelector('.check').textContent = '';
        }
      }
    });

    applySort();
    const anyVisible = items.some((i) => i._visible);
    emptyState.classList.toggle('hidden', anyVisible);
    grid.classList.toggle('hidden', !anyVisible);
    if (!anyVisible) emptyText.textContent = '没有符合筛选条件的图片。';
    updateCounts();
  }

  function applySort() {
    const by = $('#sortBy').value;
    const vis = items.filter((i) => i._visible);
    vis.sort((a, b) => {
      if (by === 'area-desc') return (b.width * b.height) - (a.width * a.height);
      if (by === 'area-asc') return (a.width * a.height) - (b.width * b.height);
      if (by === 'name') return baseName(a.url).localeCompare(baseName(b.url));
      return a.order - b.order;
    });
    // 依据排序结果重排 DOM（仅移动可见项）
    vis.forEach((it) => grid.appendChild(it.el));
  }

  // ---------- 工具栏事件 ----------
  let selAllState = false;
  function bindToolbar() {
    $('#keyword').addEventListener('input', debounce(applyFilters, 200));
    $('#formatFilter').addEventListener('change', applyFilters);
    $('#hideBroken').addEventListener('change', applyFilters);
    $('#sortBy').addEventListener('change', () => { applySort(); });

    $('#selectAll').addEventListener('click', () => {
      selAllState = !selAllState;
      setSelectAllVisible(selAllState);
      $('#selectAll').textContent = selAllState ? '取消全选' : '全选';
    });
    $('#invertSel').addEventListener('click', () => {
      items.forEach((it) => {
        if (!it._visible) return;
        it.selected = !it.selected;
        it.el.classList.toggle('selected', it.selected);
        it.el.querySelector('.check').textContent = it.selected ? '✓' : '';
      });
      updateCounts();
    });

    $('#zoomIn').addEventListener('click', () => changeThumb(30));
    $('#zoomOut').addEventListener('click', () => changeThumb(-30));

    $('#downloadBtn').addEventListener('click', doDownload);

    // 初次筛选（应用默认排序）
    applyFilters();
  }

  function changeThumb(delta) {
    const root = document.documentElement;
    const cur = parseInt(getComputedStyle(root).getPropertyValue('--thumb'), 10) || 180;
    const next = Math.min(360, Math.max(90, cur + delta));
    root.style.setProperty('--thumb', next + 'px');
  }

  // 图片陆续加载完成时，合并短时间内的多次刷新，避免频繁重排卡顿
  const refilterSoon = (function () {
    let t = null;
    return function () {
      if (t) return;
      t = setTimeout(() => { t = null; applyFilters(); }, 250);
    };
  })();

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // ---------- 下载 ----------
  async function doDownload() {
    const sel = items.filter((i) => i.selected && i._visible);
    if (!sel.length) return;

    const btn = $('#downloadBtn');
    btn.disabled = true;

    try {
      if ($('#zipMode').checked) {
        await downloadAsZip(sel);
      } else {
        await downloadSeparately(sel);
      }
    } catch (e) {
      toast('下载出错：' + (e && e.message ? e.message : e), 4200);
    } finally {
      btn.disabled = false;
      updateCounts();
    }
  }

  async function downloadSeparately(sel) {
    $('#downloadBtn').textContent = '下载中…';
    const payload = sel.map((it) => ({
      url: it.url,
      filename: filenameFor(it, it.order),
    }));
    const resp = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_IMAGES',
      items: payload,
      saveAs: false,
    });
    const results = (resp && resp.results) || [];
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    if (failCount === 0) {
      toast('已开始下载 ' + okCount + ' 张图片');
    } else {
      toast('成功 ' + okCount + ' 张，失败 ' + failCount + ' 张（可能受网站防盗链限制）', 4200);
    }
  }

  // ---------- ZIP 打包下载（纯前端实现，store 无压缩：图片本身已压缩） ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** files: [{ name, data: Uint8Array }] → 完整 zip 的 Uint8Array */
  function buildZip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); // local file header
      h.setUint16(4, 20, true);         // version needed
      h.setUint16(6, 0x0800, true);     // UTF-8 文件名
      h.setUint16(8, 0, true);          // store
      h.setUint16(10, dosTime, true);
      h.setUint16(12, dosDate, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, f.data.length, true);
      h.setUint32(22, f.data.length, true);
      h.setUint16(26, nameBytes.length, true);
      h.setUint16(28, 0, true);
      chunks.push(new Uint8Array(h.buffer), nameBytes, f.data);
      central.push({ nameBytes, crc, size: f.data.length, offset });
      offset += 30 + nameBytes.length + f.data.length;
    }

    const cdStart = offset;
    for (const c of central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true); // central directory header
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, dosTime, true);
      h.setUint16(14, dosDate, true);
      h.setUint32(16, c.crc, true);
      h.setUint32(20, c.size, true);
      h.setUint32(24, c.size, true);
      h.setUint16(28, c.nameBytes.length, true);
      h.setUint32(42, c.offset, true);
      chunks.push(new Uint8Array(h.buffer), c.nameBytes);
      offset += 46 + c.nameBytes.length;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    chunks.push(new Uint8Array(eocd.buffer));

    let total = 0;
    chunks.forEach((c) => { total += c.length; });
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  async function downloadAsZip(sel) {
    const btn = $('#downloadBtn');
    const files = [];
    const used = new Set();
    let done = 0;
    let failed = 0;
    const queue = sel.slice();

    const workers = Array.from({ length: 5 }, async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          const resp = await fetch(it.url, { credentials: 'omit' });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = new Uint8Array(await resp.arrayBuffer());
          let name = entryName(it, it.order);
          if (used.has(name)) {
            const dot = name.lastIndexOf('.');
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let n = 2;
            while (used.has(stem + '_' + n + ext)) n++;
            name = stem + '_' + n + ext;
          }
          used.add(name);
          files.push({ name, data });
        } catch (e) {
          failed++;
        }
        done++;
        btn.textContent = '打包中 ' + done + '/' + sel.length + '…';
      }
    });
    await Promise.all(workers);

    if (!files.length) {
      toast('图片抓取全部失败（可能受网站防盗链限制），可试试取消打包逐张下载', 4600);
      return;
    }

    btn.textContent = '生成 ZIP…';
    const blob = new Blob([buildZip(files)], { type: 'application/zip' });
    const blobUrl = URL.createObjectURL(blob);

    let zipName = sanitize($('#folderName').value || '');
    if (!zipName) {
      try { zipName = new URL(session.pageUrl).hostname + '_images'; } catch (e) { zipName = 'images'; }
    }

    await new Promise((resolve) => {
      chrome.downloads.download(
        { url: blobUrl, filename: zipName + '.zip', conflictAction: 'uniquify' },
        () => resolve()
      );
    });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

    toast(failed
      ? '已打包 ' + files.length + ' 张为 ZIP，另有 ' + failed + ' 张抓取失败'
      : '已打包 ' + files.length + ' 张图片为 ZIP', 4200);
  }

  // ---------- 启动 ----------
  init();
})();
