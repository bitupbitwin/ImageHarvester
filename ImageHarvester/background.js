/**
 * background.js —— 后台 service worker (Manifest V3)
 *
 * 职责：
 *  1. 点击工具栏图标时，把 collector.js 注入到当前标签页的所有 frame，
 *     汇总所有图片地址。
 *  2. 将结果写入 chrome.storage.local，并打开抓取结果页 grabber.html。
 *  3. 为结果页提供批量下载能力（downloads API）。
 */

// ---------- 点击图标：采集并打开结果页 ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  // 部分受限页面（chrome://、Web Store 等）无法注入脚本
  const url = tab.url || '';
  if (/^(chrome|edge|about|chrome-extension|https:\/\/chrome\.google\.com\/webstore)/i.test(url)
      && !url.startsWith('chrome-extension://' + chrome.runtime.id)) {
    if (/^(chrome|edge|about):/i.test(url) || /chrome\.google\.com\/webstore/i.test(url)) {
      await openInfoPage('无法在该页面抓取', '浏览器内置页面（如 chrome://、扩展商店）出于安全限制不允许注入脚本，请在普通网页上使用本插件。');
      return;
    }
  }

  let frameResults = [];
  try {
    frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['collector.js'],
    });
  } catch (e) {
    // 退回到只抓主 frame
    try {
      frameResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['collector.js'],
      });
    } catch (e2) {
      await openInfoPage('抓取失败', '无法在此页面注入脚本：' + (e2 && e2.message ? e2.message : e2));
      return;
    }
  }

  // 汇总所有 frame 的结果并去重
  const map = new Map();
  let pageUrl = tab.url || '';
  let pageTitle = tab.title || '';
  for (const fr of frameResults) {
    const r = fr && fr.result;
    if (!r || !Array.isArray(r.images)) continue;
    if (r.pageUrl && fr.frameId === 0) {
      pageUrl = r.pageUrl;
      pageTitle = r.pageTitle || pageTitle;
    }
    for (const img of r.images) {
      if (!img || !img.url) continue;
      const prev = map.get(img.url);
      if (prev) {
        if ((img.width || 0) > (prev.width || 0)) prev.width = img.width;
        if ((img.height || 0) > (prev.height || 0)) prev.height = img.height;
        if (img.alt && !prev.alt) prev.alt = img.alt;
      } else {
        map.set(img.url, img);
      }
    }
  }

  const images = Array.from(map.values());
  const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const payload = {
    sessionId,
    pageUrl,
    pageTitle,
    createdAt: Date.now(),
    images,
  };

  await chrome.storage.local.set({ [sessionId]: payload });
  await cleanupOldSessions(sessionId);

  const grabberUrl = chrome.runtime.getURL('grabber.html') + '?session=' + encodeURIComponent(sessionId);
  chrome.tabs.create({ url: grabberUrl });
});

// 打开一个简单的信息提示页（复用 grabber.html 的容器不方便，直接用 data 提示）
async function openInfoPage(title, message) {
  const sessionId = 'info_' + Date.now();
  await chrome.storage.local.set({
    [sessionId]: {
      sessionId,
      info: true,
      title,
      message,
      images: [],
      createdAt: Date.now(),
    },
  });
  const grabberUrl = chrome.runtime.getURL('grabber.html') + '?session=' + encodeURIComponent(sessionId);
  chrome.tabs.create({ url: grabberUrl });
}

// 仅保留最近若干个会话，避免 storage 膨胀
async function cleanupOldSessions(keepId) {
  try {
    const all = await chrome.storage.local.get(null);
    const sessions = Object.keys(all)
      .filter((k) => k.startsWith('sess_') || k.startsWith('info_'))
      .map((k) => ({ k, t: (all[k] && all[k].createdAt) || 0 }))
      .sort((a, b) => b.t - a.t);
    const KEEP = 6;
    const toRemove = sessions.slice(KEEP).map((s) => s.k).filter((k) => k !== keepId);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch (e) { /* 忽略 */ }
}

// ---------- 处理来自结果页的下载请求 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'DOWNLOAD_IMAGES') return;

  (async () => {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const results = [];
    for (const it of items) {
      try {
        const id = await downloadOne(it.url, it.filename, msg.saveAs === true && items.length === 1);
        results.push({ url: it.url, ok: true, id });
      } catch (e) {
        results.push({ url: it.url, ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    }
    sendResponse({ results });
  })();

  return true; // 异步 sendResponse
});

function downloadOne(url, filename, saveAs) {
  return new Promise((resolve, reject) => {
    const opts = { url, conflictAction: 'uniquify' };
    if (filename) opts.filename = filename;
    if (saveAs) opts.saveAs = true;
    chrome.downloads.download(opts, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });
}
