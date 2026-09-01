/**
 * inspect3.ts – Spåra exakt vad "Visa e-post/telefon" gör
 * Kör: yarn inspect3
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';

chromium.use(StealthPlugin());

const STORAGE_FILE = './session/storage.json';
// Använder agent 26167 som vi vet har dold kontaktdata
const TEST_URL = 'https://objektvision.se/Beskriv/268021603';

async function main() {
  console.log('🔬 Spårar Visa-knapparnas beteende...\n');

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

  // Fånga ALLA requests och responses
  const log: any[] = [];

  page.on('request', req => {
    if (req.url().includes('objektvision.se')) {
      log.push({ type: 'request', method: req.method(), url: req.url(), body: req.postData() });
    }
  });

  page.on('response', async res => {
    if (!res.url().includes('objektvision.se')) return;
    try {
      const text = await res.text();
      log.push({ type: 'response', status: res.status(), url: res.url(), body: text.substring(0, 500) });
    } catch {}
  });

  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Logga nätverket INNAN klick
  const beforeClick = log.length;
  console.log(`Nätverksanrop vid sidladdning: ${beforeClick}`);

  // Hitta och logga alla knappar på sidan
  const buttons = await page.evaluate(() => {
    const btns: any[] = [];
    document.querySelectorAll('button, [role="button"], .btn').forEach(function(el) {
      const text = (el.textContent || '').trim();
      const cls  = (el as HTMLElement).className || '';
      const id   = el.id || '';
      const onclick = el.getAttribute('onclick') || '';
      const dataAttrs: any = {};
      Array.from(el.attributes).forEach(function(attr) {
        if (attr.name.startsWith('data-')) dataAttrs[attr.name] = attr.value;
      });
      if (text.toLowerCase().includes('visa') || cls.toLowerCase().includes('contact') ||
          cls.toLowerCase().includes('phone') || cls.toLowerCase().includes('email') ||
          cls.toLowerCase().includes('reveal') || cls.toLowerCase().includes('show')) {
        btns.push({ text, cls: cls.substring(0,80), id, onclick: onclick.substring(0,100), dataAttrs });
      }
    });
    return btns;
  });

  console.log('\n🔘 Relevanta knappar på sidan:');
  buttons.forEach((b, i) => {
    console.log(`\n  Knapp ${i+1}: "${b.text}"`);
    console.log(`    class: ${b.cls}`);
    console.log(`    id: ${b.id}`);
    console.log(`    onclick: ${b.onclick}`);
    console.log(`    data-attrs: ${JSON.stringify(b.dataAttrs)}`);
  });

  // Hitta HTML runt kontaktsektionen INNAN klick
  const beforeHTML = await page.evaluate(() => {
    const el = document.querySelector('.desc-contact-info, [class*="contact-info"], [class*="contact-email"], [class*="contact-phone"]');
    return el ? el.parentElement?.innerHTML?.substring(0, 3000) : 'Element ej hittat';
  });
  console.log('\n📄 HTML runt kontakt INNAN klick:\n' + beforeHTML);
  fs.writeFileSync('./output/before_click.html', beforeHTML || '');

  // Klicka på första Visa-knappen
  console.log('\n\n🖱️  Klickar på Visa e-post...');
  try {
    // Prova med text-matchning
    const visaEmail = page.getByText('Visa e-post', { exact: false });
    if (await visaEmail.count() > 0) {
      await visaEmail.first().click();
      console.log('  ✅ Klickade via text');
    } else {
      // Prova alla knappar
      const allBtns = page.locator('button');
      const count = await allBtns.count();
      for (let i = 0; i < count; i++) {
        const txt = await allBtns.nth(i).textContent();
        if ((txt || '').toLowerCase().includes('visa')) {
          await allBtns.nth(i).click();
          console.log(`  ✅ Klickade knapp: "${txt?.trim()}"`);
          break;
        }
      }
    }
  } catch (err: any) {
    console.log('  ❌ Kunde inte klicka:', err.message);
  }

  await page.waitForTimeout(2000);

  // Logga nya nätverksanrop efter klick
  const afterClick = log.slice(beforeClick);
  console.log(`\n📡 Nätverksanrop EFTER klick (${afterClick.length} st):`);
  afterClick.forEach(entry => {
    console.log(`\n  [${entry.type}] ${entry.method || ''} ${entry.url}`);
    if (entry.body) console.log(`  Body: ${entry.body.substring(0,300)}`);
  });

  // HTML efter klick
  const afterHTML = await page.evaluate(() => {
    const el = document.querySelector('.desc-contact-info, [class*="contact-info"], [class*="contact-email"], [class*="contact-phone"]');
    return el ? el.parentElement?.innerHTML?.substring(0, 3000) : '';
  });
  console.log('\n📄 HTML runt kontakt EFTER klick:\n' + afterHTML);
  fs.writeFileSync('./output/after_click.html', afterHTML || '');

  // Spara full log
  fs.writeFileSync('./output/click_log.json', JSON.stringify(log, null, 2));
  console.log('\n💾 Fullständig logg → output/click_log.json');

  await browser.close();
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
