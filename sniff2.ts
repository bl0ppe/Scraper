import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';

chromium.use(StealthPlugin());

const STORAGE_FILE = './session/storage.json';
const OUTPUT_DIR   = './output';
const TARGET_URL   = 'https://objektvision.se/lediga_lokaler/stockholms-l%C3%A4n?p=1';

async function main() {
  console.log('🔬 Djupanalys av Objektvision endpoints\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'sv-SE',
    storageState: STORAGE_FILE,
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const captured: any[] = [];

  page.on('request', req => {
    const u = req.url();
    if (!u.includes('objektvision.se')) return;
    const body = req.postData();
    console.log(`\n→ ${req.method()} ${u}`);
    if (body) console.log(`  BODY: ${body.substring(0, 500)}`);
  });

  page.on('response', async res => {
    const u = res.url();
    if (!u.includes('objektvision.se')) return;
    try {
      const text = await res.text();
      const ct = res.headers()['content-type'] || '';
      console.log(`\n← ${res.status()} ${u}`);
      console.log(`  Content-Type: ${ct}`);
      console.log(`  Size: ${text.length} bytes`);
      console.log(`  Preview: ${text.substring(0, 600)}`);
      captured.push({
        url: u,
        method: res.request().method(),
        requestBody: res.request().postData(),
        status: res.status(),
        contentType: ct,
        responseSize: text.length,
        response: text.length < 100000 ? text : text.substring(0, 100000),
      });
    } catch { /* ignore */ }
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('\n⏳ Väntar 10s...');
    await page.waitForTimeout(10000);
  } catch { /* ignore timeout */ }

  await browser.close();

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const fname = `output/deep_${Date.now()}.json`;
  fs.writeFileSync(fname, JSON.stringify(captured, null, 2));
  console.log(`\n✅ Sparade ${captured.length} objektvision-requests → ${fname}`);
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
