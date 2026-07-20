import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extPath = join(__dirname, '..');
const userDir = mkdtempSync(join(tmpdir(), 'ig-'));

const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
  ],
});

function fail(msg) { console.log('❌ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✅ ' + msg); }

// 1. 等待 service worker 注册（说明 manifest 加载无误）
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
if (!sw) { fail('service worker 未注册（manifest/background 可能有误）'); await ctx.close(); process.exit(1); }
ok('service worker 已注册: ' + sw.url());

const extId = sw.url().split('/')[2];

// 2. 通过 SW 写入一个模拟会话到 storage
const session = {
  sessionId: 'sess_test',
  pageUrl: 'https://demo.test/page',
  pageTitle: '演示页',
  createdAt: Date.now(),
  images: [
    { url: 'https://demo.test/big.jpg', width: 1200, height: 800, alt: '大图', source: 'img' },
    { url: 'https://demo.test/small.png', width: 40, height: 40, alt: '小图', source: 'img' },
    { url: 'https://demo.test/photo.webp', width: 640, height: 480, alt: '', source: 'lazy' },
  ],
};
await sw.evaluate((s) => chrome.storage.local.set({ [s.sessionId]: s }), session);
ok('已写入模拟会话到 storage');

// 3. 打开 grabber 结果页
const page = await ctx.newPage();
// 拦截图片请求，返回 1x1 像素，保证 load 事件触发
const onePx = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
await page.route('**/*', (route) => {
  if (/\.(jpg|png|webp|gif)/i.test(route.request().url())) {
    return route.fulfill({ status: 200, contentType: 'image/gif', body: onePx });
  }
  return route.continue();
});

await page.goto(`chrome-extension://${extId}/grabber.html?session=sess_test`, { waitUntil: 'load' });
await page.waitForSelector('.card', { timeout: 5000 });

const cardCount = await page.locator('.card').count();
if (cardCount === 3) ok('渲染出 3 张图片卡片'); else fail('卡片数量应为 3，实际 ' + cardCount);

const total = await page.locator('#totalCount').textContent();
ok('可见计数 totalCount = ' + total);

// 4. 滑块量程应根据最大图片尺寸自动扩展（big.jpg 宽 1200）
const wMax = await page.evaluate(() => +document.querySelector('#widthRange .range-max').max);
if (wMax === 1200) ok('宽度滑块量程自动扩展到 1200'); else fail('宽度滑块 max 应为 1200，实际 ' + wMax);

// 5. 全选 → 选中数应为可见数
await page.click('#selectAll');
await page.waitForTimeout(200);
const selCount = await page.locator('#selectedCount').textContent();
if (parseInt(selCount) === parseInt(total)) ok('全选生效，选中 ' + selCount);
else fail('全选后选中数(' + selCount + ') 应等于可见数(' + total + ')');

const dlDisabled = await page.locator('#downloadBtn').isDisabled();
if (!dlDisabled) ok('下载按钮已启用'); else fail('全选后下载按钮仍禁用');

// 6. 左滑块拖到 1000 → 只剩宽度 ≥1000 的 big.jpg
function setSlider(page, rootSel, which, value) {
  return page.evaluate(([rootSel, which, value]) => {
    const el = document.querySelector(rootSel + ' .range-' + which);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [rootSel, which, value]);
}
await setSlider(page, '#widthRange', 'min', 1000);
await page.waitForTimeout(400);
let vis = await page.locator('.card:not(.hidden)').count();
if (vis === 1) ok('宽度下限=1000 筛选后剩 1 张'); else fail('宽度下限筛选后应剩 1 张，实际 ' + vis);

// 7. 右滑块设为 700（区间 [0,700]）→ 剩 small(40) 与 photo(640) 两张
await setSlider(page, '#widthRange', 'min', 0);
await setSlider(page, '#widthRange', 'max', 700);
await page.waitForTimeout(400);
vis = await page.locator('.card:not(.hidden)').count();
if (vis === 2) ok('宽度区间 [0,700] 筛选后剩 2 张'); else fail('区间筛选后应剩 2 张，实际 ' + vis);
const rangeLabel = await page.locator('#widthValue').textContent();
if (rangeLabel.trim() === '0 – 700') ok('区间标签显示 "0 – 700"'); else fail('区间标签异常: ' + rangeLabel);

// 恢复不设上限
await setSlider(page, '#widthRange', 'max', 1200);
await page.waitForTimeout(400);

// 8. 逐张下载：拦截 SW 的 downloads.download，验证文件名与子文件夹
await sw.evaluate(() => {
  globalThis.__dl = [];
  chrome.downloads.download = (opts, cb) => { globalThis.__dl.push(opts); cb && cb(Math.floor(Math.random() * 1000)); };
});
// 筛选会清空被隐藏项的选中态，这里重置再全选
await page.click('#selectAll');
await page.waitForTimeout(150);
const selNow = await page.locator('#selectedCount').textContent();
if (parseInt(selNow) === 0) await page.click('#selectAll');
await page.fill('#folderName', 'my-pics');
await page.waitForTimeout(200);
await page.click('#downloadBtn');
await page.waitForTimeout(600);
const dl = await sw.evaluate(() => globalThis.__dl || []);
if (dl.length >= 1) ok('逐张下载触发 ' + dl.length + ' 个，示例文件名: ' + dl[0].filename);
else fail('未触发任何下载');
if (dl.some((d) => d.filename && d.filename.startsWith('my-pics/'))) ok('子文件夹前缀生效');
else fail('文件名未包含子文件夹前缀，实际: ' + JSON.stringify(dl.map(d => d.filename)));

// 9. ZIP 打包下载：拦截结果页上下文的 downloads.download
await page.evaluate(() => {
  window.__zipDl = [];
  chrome.downloads.download = (opts, cb) => { window.__zipDl.push(opts); cb && cb(1); };
});
await page.check('#zipMode');
await page.click('#downloadBtn');
await page.waitForFunction(() => window.__zipDl && window.__zipDl.length > 0, null, { timeout: 8000 });
const zipDl = await page.evaluate(() => window.__zipDl);
if (zipDl.length === 1) ok('ZIP 模式只触发 1 个下载'); else fail('ZIP 模式应只有 1 个下载，实际 ' + zipDl.length);
if (zipDl[0].filename === 'my-pics.zip') ok('ZIP 文件名: ' + zipDl[0].filename);
else fail('ZIP 文件名应为 my-pics.zip，实际 ' + zipDl[0].filename);

// 校验 zip 内容：魔数 PK\x03\x04，且能列出条目
const zipInfo = await page.evaluate(async (url) => {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const sigOk = buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 3 && buf[3] === 4;
  // 数一下 local file header 出现次数
  let entries = 0;
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 3 && buf[i+3] === 4) entries++;
  }
  return { sigOk, entries, size: buf.length };
}, zipDl[0].url);
if (zipInfo.sigOk) ok('ZIP 魔数正确 (PK..)，大小 ' + zipInfo.size + ' 字节'); else fail('ZIP 魔数错误');
if (zipInfo.entries === 3) ok('ZIP 内含 3 个文件条目'); else fail('ZIP 条目数应为 3，实际 ' + zipInfo.entries);

await ctx.close();
console.log('\nE2E 完成' + (process.exitCode ? '（有失败）' : '（全部通过）'));
