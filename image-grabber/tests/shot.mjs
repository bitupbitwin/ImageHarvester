import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extPath = join(__dirname, '..');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ig-')), {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  viewport: { width: 1200, height: 820 },
  colorScheme: 'light',
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];

// 用彩色 SVG data URI 当作缩略图，画面更好看
function svg(w, h, c, label) {
  const s = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='${c}'/><text x='50%' y='50%' fill='#fff' font-size='${Math.round(h/6)}' text-anchor='middle' dominant-baseline='middle' font-family='sans-serif'>${label}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
}
const colors = ['#3f6cff', '#e5484d', '#12b76a', '#f79009', '#6352ff', '#0ea5e9', '#d946ef', '#14b8a6'];
const images = colors.map((c, i) => ({
  url: svg(400 + i * 40, 300 + i * 20, c, (400 + i * 40) + '×' + (300 + i * 20)),
  width: 400 + i * 40, height: 300 + i * 20, alt: 'demo ' + i, source: 'img',
}));
const session = { sessionId: 'sess_shot', pageUrl: 'https://demo.example.com/gallery', pageTitle: '示例相册', createdAt: Date.now(), images };
await sw.evaluate((s) => chrome.storage.local.set({ [s.sessionId]: s }), session);

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/grabber.html?session=sess_shot`, { waitUntil: 'load' });
await page.waitForSelector('.card');
await page.waitForTimeout(600);
// 选中前几张展示选中态
await page.click('.card:nth-child(1)');
await page.click('.card:nth-child(3)');
await page.click('.card:nth-child(5)');
await page.waitForTimeout(300);
await page.screenshot({ path: join(__dirname, 'ui-preview.png'), fullPage: false });
await ctx.close();
console.log('screenshot saved: tests/ui-preview.png');
