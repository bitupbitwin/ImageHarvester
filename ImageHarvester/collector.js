/**
 * collector.js
 * 通过 chrome.scripting.executeScript 注入到目标页面执行。
 * 尽可能全面地收集当前页面的图片地址，返回一个数组交给后台。
 *
 * 收集来源：
 *  1. <img> 的 src / currentSrc / srcset（取最大分辨率）
 *  2. <img> 常见懒加载属性：data-src / data-original / data-lazy-src / data-srcset 等
 *  3. <picture><source srcset>
 *  4. 任意元素的 CSS background-image（含伪元素）
 *  5. <a href> 指向图片文件的链接（常见大图直链）
 *  6. <video poster> 视频封面
 *  7. <svg> 内嵌图（序列化为 data URI）
 *
 * 该函数作为注入函数的函数体运行，返回值即为注入结果。
 */
(function collectImages() {
  const results = new Map(); // url -> { url, width, height, source, alt }

  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)(\?|#|$)/i;

  function absUrl(u) {
    if (!u) return null;
    u = u.trim();
    if (!u || u === 'about:blank') return null;
    // 过滤掉 1x1 占位、纯 data:image/gif 极小占位符由后续尺寸过滤处理
    try {
      // data: / blob: 直接返回；其它相对地址转绝对
      if (/^(data:|blob:)/i.test(u)) return u;
      return new URL(u, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  function add(url, info) {
    const abs = absUrl(url);
    if (!abs) return;
    if (/^javascript:/i.test(abs)) return;
    if (results.has(abs)) {
      // 合并更可靠的尺寸信息
      const prev = results.get(abs);
      if (info) {
        if (info.width && info.width > (prev.width || 0)) prev.width = info.width;
        if (info.height && info.height > (prev.height || 0)) prev.height = info.height;
        if (info.alt && !prev.alt) prev.alt = info.alt;
      }
      return;
    }
    results.set(abs, Object.assign({ url: abs, width: 0, height: 0, source: 'img', alt: '' }, info));
  }

  // 从 srcset 字符串中挑出分辨率最高的那个
  function pickFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestScore = -1;
    srcset.split(',').forEach((part) => {
      const seg = part.trim().split(/\s+/);
      const u = seg[0];
      if (!u) return;
      let score = 1;
      if (seg[1]) {
        const m = seg[1].match(/([\d.]+)(w|x)/);
        if (m) score = parseFloat(m[1]);
      }
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    });
    return best;
  }

  // 1 & 2. <img>
  document.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt') || '';
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    add(img.currentSrc || img.src, { width: w, height: h, alt, source: 'img' });
    add(img.getAttribute('src'), { width: w, height: h, alt, source: 'img' });

    const ss = pickFromSrcset(img.getAttribute('srcset'));
    if (ss) add(ss, { alt, source: 'srcset' });

    // 常见懒加载属性
    const lazyAttrs = [
      'data-src', 'data-original', 'data-lazy-src', 'data-lazy',
      'data-actualsrc', 'data-echo', 'data-img', 'data-url', 'data-hi-res-src',
    ];
    lazyAttrs.forEach((a) => {
      const v = img.getAttribute(a);
      if (v) add(v, { alt, source: 'lazy' });
    });
    const dss = pickFromSrcset(img.getAttribute('data-srcset'));
    if (dss) add(dss, { alt, source: 'lazy' });
  });

  // 3. <picture><source>
  document.querySelectorAll('picture source, source[srcset]').forEach((s) => {
    const ss = pickFromSrcset(s.getAttribute('srcset'));
    if (ss) add(ss, { source: 'picture' });
  });

  // 4. CSS background-image
  function extractBg(el, pseudo) {
    let bg;
    try {
      bg = getComputedStyle(el, pseudo || null).backgroundImage;
    } catch (e) {
      return;
    }
    if (!bg || bg === 'none') return;
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) {
      const u = m[2];
      if (u) add(u, { source: 'background' });
    }
  }
  // 只遍历可见 / 存在的元素，避免过慢；上限保护
  const allEls = document.querySelectorAll('*');
  const MAX_BG_SCAN = 8000;
  for (let i = 0; i < allEls.length && i < MAX_BG_SCAN; i++) {
    extractBg(allEls[i]);
    extractBg(allEls[i], '::before');
    extractBg(allEls[i], '::after');
  }

  // 5. <a href> 指向图片
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href && IMG_EXT.test(href)) add(href, { source: 'link' });
  });

  // 6. <video poster>
  document.querySelectorAll('video[poster]').forEach((v) => {
    add(v.getAttribute('poster'), { source: 'poster' });
  });

  // 7. 内嵌 <svg>
  document.querySelectorAll('svg').forEach((svg) => {
    try {
      const rect = svg.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return; // 忽略图标级小 svg
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute('xmlns')) {
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
      const xml = new XMLSerializer().serializeToString(clone);
      const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      add(dataUri, {
        source: 'svg',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    } catch (e) { /* 忽略 */ }
  });

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    images: Array.from(results.values()),
  };
})();
