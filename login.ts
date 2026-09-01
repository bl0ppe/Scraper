/**
 * login.ts – Kör LOKALT på din egen dator (Windows/Mac/Linux med skärm)
 *
 * 1. Kopiera hela scraper-mappen till din lokala dator
 * 2. yarn install && yarn login
 * 3. Lös CAPTCHA i webbläsaren som öppnas
 * 4. Tryck ENTER i terminalen
 * 5. Kopiera session/-mappen till servern:
 *    scp -r session/ pontus@SERVER_IP:/home/pontus/scraper/session/
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

chromium.use(StealthPlugin());

const SESSION_DIR  = './session';
const STORAGE_FILE = path.join(SESSION_DIR, 'storage.json');
const TARGET_URL   = 'https://objektvision.se/lediga_lokaler/stockholms-l%C3%A4n?p=1';

function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Objektvision – Session Login');
  console.log('  ⚠️  Kör detta LOKALT på din dator, inte på servern');
  console.log('═══════════════════════════════════════════════════\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'sv-SE',
    extraHTTPHeaders: { 'Accept-Language': 'sv-SE,sv;q=0.9' },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['sv-SE','sv','en'] });
  });

  console.log(`🌐 Öppnar webbläsare → ${TARGET_URL}\n`);
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch {
    // Timeout är ok – sidan laddas ändå
  }

  console.log('─────────────────────────────────────────────────────');
  console.log('👉 GÖR SÅ HÄR:');
  console.log('   1. Titta på webbläsarfönstret som öppnades');
  console.log('   2. Lös Cloudflare CAPTCHA om den dyker upp');
  console.log('   3. Vänta tills objektlistan syns på sidan');
  console.log('   4. Kom tillbaka hit och tryck ENTER');
  console.log('─────────────────────────────────────────────────────\n');

  await waitForEnter('Tryck ENTER när objektlistan är synlig i webbläsaren... ');

  // Spara session
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  const storage = await context.storageState();
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(storage, null, 2));
  const cookies = storage.cookies;
  console.log(`\n✅ ${cookies.length} cookies sparade → ${STORAGE_FILE}`);

  await browser.close();

  console.log('\n─────────────────────────────────────────────────────');
  console.log('📋 NÄSTA STEG – kopiera session till servern:');
  console.log('\n   scp -r session/ pontus@DIN_SERVER_IP:/home/pontus/scraper/session/');
  console.log('\nSedan på servern:');
  console.log('   yarn sniff');
  console.log('   yarn scrape');
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
