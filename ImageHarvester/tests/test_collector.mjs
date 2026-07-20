import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const collectorSrc = readFileSync(join(__dirname, '..', 'collector.js'), 'utf8');
const pageUrl = 'file://' + join(__dirname, 'testpage.html');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pageUrl, { waitUntil: 'load' });

const result = await page.evaluate(collectorSrc);
await browser.close();

const urls = result.images.map((i) => i.url);
const has = (frag) => urls.some((u) => u.includes(frag));

const checks = [
  ['普通 img a.jpg', has('a.jpg')],
  ['srcset 取最大 w1280', has('w1280.jpg')],
  ['懒加载 data-src', has('lazy1.webp')],
  ['懒加载 data-original', has('lazy2.png')],
  ['picture source 2x', has('pic-2x.avif')],
  ['背景图 bg-hero', has('bg-hero.jpg')],
  ['伪元素背景 pseudo-before', has('pseudo-before.png')],
  ['图片直链 full-size.png', has('full-size.png')],
  ['非图片链接被忽略', !has('not-an-image.html')],
  ['video poster', has('poster.jpg')],
  ['内嵌 svg -> data uri', urls.some((u) => u.startsWith('data:image/svg+xml'))],
  ['data:image gif 收录', urls.some((u) => u.startsWith('data:image/gif'))],
];

let pass = 0;
console.log('共采集到', urls.length, '个图片地址\n');
for (const [name, ok] of checks) {
  console.log((ok ? '✅' : '❌') + ' ' + name);
  if (ok) pass++;
}
console.log('\n通过 ' + pass + '/' + checks.length);
process.exit(pass === checks.length ? 0 : 1);
