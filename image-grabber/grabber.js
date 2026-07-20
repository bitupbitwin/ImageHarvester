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

  function filenameFor(item, index) {
    let name = baseName(item.url);
    const fmt = item.fmt === 'other' ? '' : item.fmt;
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      name = name + (fmt ? '.' + (fmt === 'svg' ? 'svg' : fmt) : '');
    }
    if (!name || name === '.' + fmt) {
      name = 'image_' + (index + 1) + (fmt ? '.' + fmt : '');
    }
    name = sanitize(name);
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
    const minW = parseInt($('#minWidth').value, 10) || 0;
    const minH = parseInt($('#minHeight').value, 10) || 0;
    const fmt = $('#formatFilter').value;
    const kw = ($('#keyword').value || '').trim().toLowerCase();
    const hideBroken = $('#hideBroken').checked;

    items.forEach((it) => {
      let ok = true;
      // 尺寸：未知尺寸（未加载完）暂时视为通过，加载后会再次触发
      if (minW && it.width && it.width < minW) ok = false;
      if (minH && it.height && it.height < minH) ok = false;
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
    ['minWidth', 'minHeight', 'keyword'].forEach((id) => {
      $('#' + id).addEventListener('input', debounce(applyFilters, 200));
    });
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

    const payload = sel.map((it, i) => ({
      url: it.url,
      filename: filenameFor(it, it.order),
    }));

    const btn = $('#downloadBtn');
    btn.disabled = true;
    btn.textContent = '下载中…';

    try {
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
    } catch (e) {
      toast('下载出错：' + (e && e.message ? e.message : e), 4200);
    } finally {
      btn.disabled = false;
      updateCounts();
    }
  }

  // ---------- 启动 ----------
  init();
})();
