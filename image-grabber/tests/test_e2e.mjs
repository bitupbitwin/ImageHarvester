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

// 4. 全选 → 选中数应为可见数
await page.click('#selectAll');
await page.waitForTimeout(200);
const selCount = await page.locator('#selectedCount').textContent();
if (parseInt(selCount) === parseInt(total)) ok('全选生效，选中 ' + selCount);
else fail('全选后选中数(' + selCount + ') 应等于可见数(' + total + ')');

const dlDisabled = await page.locator('#downloadBtn').isDisabled();
if (!dlDisabled) ok('下载按钮已启用'); else fail('全选后下载按钮仍禁用');

// 5. 最小宽度筛选 = 1000，应只剩 1 张（big.jpg 1200 宽）
await page.fill('#minWidth', '1000');
await page.waitForTimeout(400);
const visAfter = await page.locator('.card:not(.hidden)').count();
if (visAfter === 1) ok('最小宽度=1000 筛选后剩 1 张'); else fail('筛选后应剩 1 张，实际 ' + visAfter);

// 6. 拦截 downloads.download，验证下载消息与文件名生成
await sw.evaluate(() => {
  globalThis.__dl = [];
  chrome.downloads.download = (opts, cb) => { globalThis.__dl.push(opts); cb && cb(Math.floor(Math.random() * 1000)); };
});
await page.fill('#minWidth', '0');
await page.waitForTimeout(300);
await page.click('#selectAll'); // 取消全选（此前是全选状态）
// 可能变为取消全选后再全选，确保为全选
const label = await page.locator('#selectAll').textContent();
if (label.includes('全选')) { await page.click('#selectAll'); }
await page.fill('#folderName', 'my-pics');
await page.waitForTimeout(200);
await page.click('#downloadBtn');
await page.waitForTimeout(600);
const dl = await sw.evaluate(() => globalThis.__dl || []);
if (dl.length >= 1) ok('触发下载 ' + dl.length + ' 个，示例文件名: ' + dl[0].filename);
else fail('未触发任何下载');
if (dl.some((d) => d.filename && d.filename.startsWith('my-pics/'))) ok('子文件夹前缀生效');
else fail('文件名未包含子文件夹前缀，实际: ' + JSON.stringify(dl.map(d => d.filename)));

await ctx.close();
console.log('\nE2E 完成' + (process.exitCode ? '（有失败）' : '（全部通过）'));
