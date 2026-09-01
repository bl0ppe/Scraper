import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';

chromium.use(StealthPlugin());

const STORAGE_FILE = './session/storage.json';
const LIST_URL     = 'https://objektvision.se/lediga_lokaler/stockholms-l%C3%A4n?p=1';

async function main() {
  console.log('🔬 Analyserar objekt-kort och Beskriv-sida...\n');

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

  // ── STEG 1: Listsida ────────────────────────────────────────────────────────
  console.log('📋 Steg 1: Hämtar listsida...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const listData = await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-object-id]');
    const results: any[] = [];

    cards.forEach(function(card, i) {
      if (i > 2) return;
      const objectId = card.getAttribute('data-object-id');
      const outerHtml = card.outerHTML.substring(0, 2000);
      const allText: string[] = [];
      card.querySelectorAll('*').forEach(function(el) {
        const t = (el.textContent || '').trim();
        if (t && t.length > 2 && t.length < 200) allText.push(t);
      });
      const linkEl = card.querySelector('a[href*="Beskriv"]') as HTMLAnchorElement | null;
      const link = linkEl ? linkEl.getAttribute('href') : '';
      results.push({ objectId, link, outerHtml, texts: allText.slice(0, 15) });
    });

    return results;
  });

  console.log('\n✅ Objekt-kort på listsidan:');
  listData.forEach(function(item: any, i: number) {
    console.log(`\n── Kort ${i + 1} (id: ${item.objectId}) ──`);
    console.log(`  Länk: ${item.link}`);
    console.log(`  Texter: ${item.texts.join(' | ')}`);
    console.log(`\n  HTML:\n${item.outerHtml}`);
  });

  fs.writeFileSync('./output/list_cards.json', JSON.stringify(listData, null, 2));

  // ── STEG 2: Beskriv-sida ────────────────────────────────────────────────────
  const firstId = listData[0]?.objectId;
  if (!firstId) { console.log('❌ Ingen object-id'); await browser.close(); return; }

  const beskrivUrl = `https://objektvision.se/Beskriv/${firstId}`;
  console.log(`\n\n📄 Steg 2: Besöker ${beskrivUrl}`);
  await page.goto(beskrivUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const beskrivData = await page.evaluate(() => {
    const emailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
      .map(function(a) { return (a.getAttribute('href') || '').replace('mailto:', ''); });
    const phoneLinks = Array.from(document.querySelectorAll('a[href^="tel:"]'))
      .map(function(a) { return (a.getAttribute('href') || '').replace('tel:', ''); });
    const h2s = Array.from(document.querySelectorAll('h2'))
      .map(function(h) { return (h.textContent || '').trim(); }).slice(0, 6);

    const emailText = (document.body.innerText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []);
    const phoneText = (document.body.innerText.match(/(\+46|0)[0-9\s\-().]{6,16}/g) || []);

    const relevantEls: string[] = [];
    document.querySelectorAll('*').forEach(function(el) {
      const cls = (el as HTMLElement).className || '';
      if (typeof cls === 'string' && cls.match(/contact|broker|company|agent|firm|kontakt|mäkl/i)) {
        const text = (el.textContent || '').trim().substring(0, 150);
        if (text.length > 3) relevantEls.push('[' + cls.substring(0, 60) + ']: ' + text.substring(0, 100));
      }
    });

    return {
      title: document.title,
      h1: (document.querySelector('h1') || { textContent: '' }).textContent!.trim(),
      h2s,
      emailLinks,
      phoneLinks,
      emailText: emailText.filter(function(v: string, i: number, a: string[]) { return a.indexOf(v) === i; }),
      phoneText: phoneText.filter(function(v: string, i: number, a: string[]) { return a.indexOf(v) === i; }).slice(0, 10),
      relevantElements: relevantEls.filter(function(v: string, i: number, a: string[]) { return a.indexOf(v) === i; }).slice(0, 25),
    };
  });

  console.log(`\nTitel: ${beskrivData.title}`);
  console.log(`H1: ${beskrivData.h1}`);
  console.log(`H2: ${beskrivData.h2s.join(' | ')}`);
  console.log(`\nE-post (href): ${beskrivData.emailLinks.join(', ') || 'Inga'}`);
  console.log(`Telefon (href): ${beskrivData.phoneLinks.join(', ') || 'Inga'}`);
  console.log(`E-post (text): ${beskrivData.emailText.join(', ') || 'Inga'}`);
  console.log(`Telefon (text): ${beskrivData.phoneText.join(', ') || 'Inga'}`);
  console.log('\nRelevanta element (contact/broker/company):');
  beskrivData.relevantElements.forEach(function(e: string) { console.log('  ' + e); });

  const beskrivHtml = await page.content();
  fs.writeFileSync('./output/beskriv.html', beskrivHtml);
  fs.writeFileSync('./output/beskriv_data.json', JSON.stringify(beskrivData, null, 2));
  console.log('\n💾 output/beskriv.html + output/beskriv_data.json sparade');

  await browser.close();
}

main().catch(function(err) { console.error('💥', err.message); process.exit(1); });
