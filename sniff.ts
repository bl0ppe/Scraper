/**
 * sniff.ts – Identifiera Objektvisions API-endpoints
 * Kör: yarn sniff  (efter yarn login)
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

chromium.use(StealthPlugin());

const TARGET_URL = 'https://objektvision.se/lediga_lokaler/stockholms-l%C3%A4n?p=1';
const SESSION_DIR = './session';
const STORAGE_FILE = path.join(SESSION_DIR, 'storage.json');

interface CapturedCall {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  responsePreview?: string;
}

async function sniff() {
  console.log('🔍 Startar API-sniffare (stealth-läge)...\n');

  const hasSession = fs.existsSync(STORAGE_FILE);
  if (!hasSession) {
    console.log('⚠️  Ingen sparad session hittad.');
    console.log('   Kör FÖRST: yarn login\n');
  } else {
    console.log('✅ Sparad session hittad – laddar cookies...\n');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'sv-SE',
    extraHTTPHeaders: { 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8' },
    storageState: hasSession ? STORAGE_FILE : undefined,
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['sv-SE', 'sv', 'en'] });
  });

  const captured: CapturedCall[] = [];

  page.on('request', (req) => {
    const type = req.resourceType();
    if (['fetch', 'xhr', 'document'].includes(type)) {
      const url = req.url();
      if (!url.includes('.woff') && !url.includes('google') && !url.includes('analytics') && !url.includes('cookiebot')) {
        console.log(`→ [${type.toUpperCase()}] ${url.substring(0, 120)}`);
      }
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('cookiebot') || url.includes('cloudflare') || url.includes('analytics')) return;

    const type = res.request().resourceType();
    const contentType = res.headers()['content-type'] || '';

    if (['fetch', 'xhr'].includes(type) || contentType.includes('json')) {
      const entry: CapturedCall = {
        url, method: res.request().method(),
        resourceType: type, status: res.status(), contentType,
      };
      try {
        const text = await res.text();
        if (text && text.length > 10 && text.length < 500000) {
          entry.responsePreview = text.substring(0, 2000);
          console.log(`\n✅ JSON RESPONSE: ${url.substring(0, 100)}`);
          console.log(`   Status: ${res.status()} | ${text.length} bytes`);
          console.log(`   Preview: ${text.substring(0, 300)}\n`);
        }
      } catch { /* ignore */ }
      captured.push(entry);
    }
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('⏳ Väntar 10s på API-anrop...');
    await page.waitForTimeout(10000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
  } catch (err: any) {
    console.warn('⚠️  Timeout/fel:', err.message);
  }

  if (!fs.existsSync('./output')) fs.mkdirSync('./output');
  fs.writeFileSync('./output/api_map.json', JSON.stringify(captured, null, 2));

  const jsonCalls = captured.filter(c => c.contentType?.includes('json'));
  console.log(`\n📊 Totalt ${captured.length} anrop, ${jsonCalls.length} JSON-endpoints:`);
  jsonCalls.forEach(c => console.log(`   ${c.method} ${c.url.substring(0, 120)}`));
  console.log('\n💾 Fullständig logg: output/api_map.json');

  await browser.close();
}

sniff();
