/**
 * inspect.ts – Dumpa HTML och hitta rätt selektorer
 * Kör: yarn inspect
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';

chromium.use(StealthPlugin());

const STORAGE_FILE = './session/storage.json';
const TARGET_URL   = 'https://objektvision.se/lediga_lokaler/stockholms-l%C3%A4n?p=1';

async function main() {
  console.log('🔬 Inspekterar HTML-struktur...\n');

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

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Spara full HTML
  const html = await page.content();
  fs.writeFileSync('./output/page.html', html);
  console.log(`✅ HTML sparad (${html.length} bytes) → output/page.html`);

  // Analysera strukturen i DOM
  const analysis = await page.evaluate(() => {
    const results: any = { selectors: {}, objectLinks: [], textSamples: [] };

    // Testa vanliga selektorer och räkna träffar
    const tests: Record<string, string> = {
      'li.object-item':         'li.object-item',
      'article':                'article',
      '.object-list li':        '.object-list li',
      '[class*="object"]':      '[class*="object"]',
      '[class*="estate"]':      '[class*="estate"]',
      '[class*="listing"]':     '[class*="listing"]',
      '[class*="search-result"]':'[class*="search-result"]',
      '[class*="ad-"]':         '[class*="ad-"]',
      '[class*="item"]':        '[class*="item"]',
      'ul.list li':             'ul.list li',
      '.result-list li':        '.result-list li',
      '[data-id]':              '[data-id]',
      '[data-object-id]':       '[data-object-id]',
    };

    for (const [name, sel] of Object.entries(tests)) {
      const found = document.querySelectorAll(sel);
      results.selectors[name] = found.length;
    }

    // Hitta alla interna länkar som ser ut som objekt
    const links = document.querySelectorAll('a[href]');
    const objectLinks: string[] = [];
    links.forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href.match(/\/(objekt|lokal|fastighet|annons|item)\/\d/i)) {
        objectLinks.push(href);
      }
    });
    results.objectLinks = [...new Set(objectLinks)].slice(0, 20);

    // Hitta element med telefonnummer och e-postadresser
    const allText = document.body.innerText;
    const phones = allText.match(/\b(0[0-9\s-]{7,14})\b/g) || [];
    const emails = allText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    results.phonesFound = [...new Set(phones)].slice(0, 10);
    results.emailsFound = [...new Set(emails)].slice(0, 10);

    // Titta på body-klasserna och data-attribut
    const body = document.body;
    results.bodyClasses = body.className;

    // Hitta de mest frekventa class-namnen i dokumentet
    const classCounts: Record<string, number> = {};
    document.querySelectorAll('*').forEach(el => {
      el.classList.forEach(c => {
        classCounts[c] = (classCounts[c] || 0) + 1;
      });
    });
    // Sortera och ta topp 30
    results.topClasses = Object.entries(classCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([cls, count]) => `${cls}: ${count}`);

    // Hitta alla unika href-mönster
    const hrefPatterns: Record<string, number> = {};
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const parts = href.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const pattern = '/' + parts.slice(0, 2).join('/');
        hrefPatterns[pattern] = (hrefPatterns[pattern] || 0) + 1;
      }
    });
    results.hrefPatterns = Object.entries(hrefPatterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([p, c]) => `${p}: ${c}`);

    return results;
  });

  console.log('\n📊 SELEKTOR-ANALYS (antal matchande element):');
  for (const [sel, count] of Object.entries(analysis.selectors)) {
    const mark = (count as number) > 5 ? '✅' : (count as number) > 0 ? '⚠️ ' : '❌';
    console.log(`  ${mark} ${sel}: ${count}`);
  }

  console.log('\n🔗 OBJEKT-LÄNKAR (href-mönster med objekt/lokal/fastighet):');
  if (analysis.objectLinks.length > 0) {
    analysis.objectLinks.forEach((l: string) => console.log(`  ${l}`));
  } else {
    console.log('  Inga direktlänkar hittade – kollar href-mönster:');
    analysis.hrefPatterns.forEach((p: string) => console.log(`  ${p}`));
  }

  console.log('\n📧 E-POST HITTADE:');
  console.log(' ', analysis.emailsFound.join(', ') || 'Inga');

  console.log('\n📞 TELEFON HITTADE:');
  console.log(' ', analysis.phonesFound.slice(0, 5).join(', ') || 'Inga');

  console.log('\n🏷️  TOPP 30 CSS-KLASSER:');
  analysis.topClasses.forEach((c: string) => console.log(`  ${c}`));

  console.log('\n💾 Full HTML sparad → output/page.html');
  console.log('   Kör: grep -o \'class="[^"]*"\' output/page.html | sort | uniq -c | sort -rn | head -40');

  await browser.close();
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
