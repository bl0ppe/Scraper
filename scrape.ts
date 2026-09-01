/**
 * scrape.ts – Objektvision Lead Scraper (v7)
 *
 * Nytt i v7:
 *  - Besöker /Annonsörer/{agentId} för korrekt totalt antal objekt
 *  - Hämtar företagsinfo (adress, tel, hemsida) från annonsörssidan
 *  - Genererar Google Sheets-kompatibel CSV
 *  - Behåller alla anti-block-skydd från v6
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Page, BrowserContext, Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

chromium.use(StealthPlugin());

// ─── REGIONER ────────────────────────────────────────────────────────────────
const REGIONS = [
  { name: 'Gävleborgs län',      url: 'https://objektvision.se/lediga_lokaler/g%C3%A4vleborgs-l%C3%A4n' },
  { name: 'Västernorrlands län', url: 'https://objektvision.se/lediga_lokaler/v%C3%A4sternorrlands-l%C3%A4n' },
  { name: 'Jämtlands län',       url: 'https://objektvision.se/lediga_lokaler/j%C3%A4mtlands-l%C3%A4n' },
  { name: 'Västerbottens län',   url: 'https://objektvision.se/lediga_lokaler/v%C3%A4sterbottens-l%C3%A4n' },
  { name: 'Norrbottens län',     url: 'https://objektvision.se/lediga_lokaler/norrbottens-l%C3%A4n' },
  { name: 'Dalarnas län',        url: 'https://objektvision.se/lediga_lokaler/dalarnas-l%C3%A4n' },
  { name: 'Värmlands län',       url: 'https://objektvision.se/lediga_lokaler/v%C3%A4rmlands-l%C3%A4n' },
];

// ─── ANTI-BLOCK ───────────────────────────────────────────────────────────────
const AB = {
  itemDelayMin:        2000,
  itemDelayMax:        5000,
  longBreakEvery:      20,
  longBreakMin:        15000,
  longBreakMax:        35000,
  pageDelayMin:        4000,
  pageDelayMax:        8000,
  regionDelayMin:      10000,
  regionDelayMax:      20000,
  rotateContextEvery:  50,
  retryDelays:         [5000, 15000, 45000] as number[],
  maxConsecutiveFails: 5,
  consecutiveFailPause:120000,
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  ],
};

const CONFIG = {
  maxPages:    1,   // TEST: 1 sida per region. Sätt 0 för alla sidor.
  outputDir:   './output',
  sessionFile: './session/storage.json',
  stateFile:   './output/state.json',
  pageTimeout: 60000,
};

// ─── TYPER ───────────────────────────────────────────────────────────────────
interface Lead {
  objectId:          string;
  address:           string;
  area:              string;
  region:            string;
  size:              string;
  rent:              string;
  availability:      string;
  agentId:           string;
  companyName:       string;
  companyAddress:    string;
  companyPhone:      string;
  companyWebsite:    string;
  companyOvUrl:      string;
  totalObjectCount:  number;   // Hämtat från /Annonsörer/
  contactPerson:     string;
  contactTitle:      string;
  email:             string;
  phone:             string;
  objectUrl:         string;
  scrapedAt:         string;
}

interface AgentState {
  agentId:          string;
  companyName:      string;
  totalObjectCount: number;
  objectIds:        string[];
  lastSeen:         string;
}

interface Change {
  agentId:     string;
  companyName: string;
  type:        'new_agent' | 'objects_added' | 'objects_removed';
  message:     string;
  before?:     number;
  after?:      number;
  addedIds?:   string[];
  removedIds?: string[];
  timestamp:   string;
}

// ─── HJÄLP ───────────────────────────────────────────────────────────────────
const randInt  = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep    = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const randSleep= (min: number, max: number) => sleep(randInt(min, max));
const randUA   = () => AB.userAgents[randInt(0, AB.userAgents.length - 1)];

function formatPhone(p: string): string {
  if (!p) return '';
  let s = p.replace(/[\s\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('0') && !s.startsWith('+')) s = '+46' + s.slice(1);
  return s;
}

function extractDomain(email: string): string {
  if (!email?.includes('@')) return '';
  return email.split('@')[1].toLowerCase().trim();
}

function getCity(area: string): string {
  const parts = area.split(',').map(s => s.trim());
  return parts[parts.length - 1] || area;
}

function splitName(name: string) {
  const parts = (name || '').trim().split(/\s+/);
  return parts.length <= 1
    ? { firstName: parts[0] || '', lastName: '' }
    : { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function loadState(): Record<string, AgentState> {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')); } catch { return {}; }
}
function saveState(s: Record<string, AgentState>) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(s, null, 2));
}

async function newContext(browser: Browser) {
  return browser.newContext({
    userAgent:   randUA(),
    viewport:    { width: randInt(1200, 1440), height: randInt(800, 960) },
    locale:      'sv-SE',
    timezoneId:  'Europe/Stockholm',
    storageState: CONFIG.sessionFile,
    extraHTTPHeaders: {
      'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });
}

async function initPage(context: BrowserContext) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages',  { get: () => ['sv-SE','sv','en'] });
    (window as any).chrome = { runtime: {} };
  });
  return page;
}

async function humanScroll(page: Page) {
  try {
    await page.evaluate(() => new Promise<void>(resolve => {
      let pos = 0;
      const step = () => {
        pos += Math.floor(Math.random() * 120 + 40);
        window.scrollTo(0, pos);
        if (pos < document.body.scrollHeight * 0.6) setTimeout(step, Math.random() * 150 + 50);
        else resolve();
      };
      step();
    }));
  } catch { /* ignore */ }
}

// ─── API: HÄMTA E-POST/TEL ───────────────────────────────────────────────────
async function fetchContact(
  context: BrowserContext,
  endpoint: 'GetEmailAddress' | 'GetPhoneNumber',
  objectId: string,
  contactId: string
): Promise<string> {
  for (const delay of [0, ...AB.retryDelays]) {
    if (delay) await sleep(delay);
    try {
      const res = await context.request.post(
        `https://objektvision.se/Description/${endpoint}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `https://objektvision.se/Beskriv/${objectId}`,
          },
          data: `objectId=${objectId}&contactId=${contactId}`,
          timeout: 15000,
        }
      );
      if (res.status() === 429) continue;
      return (await res.text()).trim();
    } catch { /* retry */ }
  }
  return '';
}

// ─── LISTSIDA ────────────────────────────────────────────────────────────────
async function scrapeListPage(page: Page, url: string, region: string): Promise<Partial<Lead>[]> {
  for (const delay of [0, ...AB.retryDelays]) {
    if (delay) { console.warn(`   ⚠️  Retry om ${delay/1000}s`); await sleep(delay); }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
      await sleep(randInt(1500, 3000));
      if (Math.random() > 0.3) await humanScroll(page);
      await sleep(randInt(500, 1200));

      return await page.evaluate((reg: string) => {
        const out: any[] = [];
        document.querySelectorAll('a.ov--list-item[data-object-id]').forEach(function(el) {
          const a = el as HTMLAnchorElement;
          const title = (a.getAttribute('title') || '').replace('Ledig lokal, ', '');
          const parts = title.split(', ');
          out.push({
            objectId:  a.getAttribute('data-object-id') || '',
            agentId:   a.getAttribute('data-agent-id')  || '',
            address:   parts[0] || '',
            area:      parts.slice(1).join(', '),
            objectUrl: a.getAttribute('href') || '',
            region:    reg,
          });
        });
        return out;
      }, region);
    } catch (err: any) {
      if (delay === AB.retryDelays[AB.retryDelays.length - 1]) {
        console.error(`   ❌ Gav upp: ${err.message?.substring(0, 60)}`);
        return [];
      }
    }
  }
  return [];
}

// ─── ANNONSÖRSSIDA: korrekt totalt antal + företagsinfo ──────────────────────
interface AgentInfo {
  totalObjectCount: number;
  companyName:      string;
  companyAddress:   string;
  companyPhone:     string;
  companyWebsite:   string;
  allObjectIds:     string[];
}

async function scrapeAgentPage(page: Page, agentId: string): Promise<AgentInfo> {
  const url = `https://objektvision.se/Annons%C3%B6rer/${agentId}`;
  for (const delay of [0, ...AB.retryDelays]) {
    if (delay) await sleep(delay);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
      await sleep(randInt(1000, 2500));

      return await page.evaluate(() => {
        // Antal annonser – "8 annonser" i texten
        let totalObjectCount = 0;
        const bodyText = document.body.innerText;
        const countMatch = bodyText.match(/(\d+)\s+annonser?/i);
        if (countMatch) totalObjectCount = parseInt(countMatch[1]);

        // Alternativt: räkna faktiska kort
        const cards = document.querySelectorAll('a[href*="/Beskriv/"]');
        if (!totalObjectCount && cards.length) totalObjectCount = cards.length;

        // Samla alla objekt-ID:n
        const allObjectIds: string[] = [];
        cards.forEach(function(a) {
          const href  = a.getAttribute('href') || '';
          const match = href.match(/\/Beskriv\/(\d+)/);
          if (match && !allObjectIds.includes(match[1])) allObjectIds.push(match[1]);
        });

        // Företagsinfo
        const h1 = document.querySelector('h1');
        const companyName = h1 ? (h1.textContent || '').trim() : '';

        // Adress + telefon + hemsida finns i texten under h1
        const infoEl = document.querySelector('.agent-info, [class*="contact"], address')
          || h1?.nextElementSibling;
        const infoText = infoEl ? (infoEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

        const phoneLink = document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null;
        const webLink   = document.querySelector('a[href^="http"]:not([href*="objektvision"])') as HTMLAnchorElement | null;

        // Adress: texten mellan h1 och "annonser"-raden
        let companyAddress = '';
        const allText = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        const h1Idx = allText.findIndex(l => l === companyName);
        if (h1Idx >= 0) {
          // Ta raderna direkt efter h1 fram till "annonser"
          for (let i = h1Idx + 1; i < Math.min(h1Idx + 5, allText.length); i++) {
            if (allText[i].match(/annonser?/i)) break;
            if (!allText[i].match(/^(Tel:|www\.|http)/i)) companyAddress += allText[i] + ' ';
          }
        }

        return {
          totalObjectCount,
          companyName,
          companyAddress: companyAddress.trim(),
          companyPhone:   phoneLink ? (phoneLink.getAttribute('href') || '').replace('tel:', '') : '',
          companyWebsite: webLink   ? (webLink.getAttribute('href') || '') : '',
          allObjectIds,
        };
      });
    } catch (err: any) {
      if (delay === AB.retryDelays[AB.retryDelays.length - 1]) {
        return { totalObjectCount: 0, companyName: '', companyAddress: '', companyPhone: '', companyWebsite: '', allObjectIds: [] };
      }
    }
  }
  return { totalObjectCount: 0, companyName: '', companyAddress: '', companyPhone: '', companyWebsite: '', allObjectIds: [] };
}

// ─── BESKRIV-SIDA ────────────────────────────────────────────────────────────
async function scrapeBeskriv(page: Page, context: BrowserContext, objectId: string): Promise<Partial<Lead>> {
  for (const delay of [0, ...AB.retryDelays]) {
    if (delay) await sleep(delay);
    try {
      await page.goto(`https://objektvision.se/Beskriv/${objectId}`, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
      await sleep(randInt(800, 2000));
      if (Math.random() > 0.4) await humanScroll(page);

      const dom = await page.evaluate(() => {
        const contacts: any[] = [];
        document.querySelectorAll('[data-contactid]').forEach(function(el) {
          const cid = el.getAttribute('data-contactid') || '';
          if (!cid) return;
          const parent = el.closest('.desc-contact-info') || el.parentElement?.parentElement?.parentElement;
          const nameEl  = parent?.querySelector('.text-ov-blue, .font-weight-bold');
          const titleEl = parent?.querySelector('.desc-contact-title');
          contacts.push({
            contactId: cid,
            name:      nameEl  ? (nameEl.textContent  || '').trim() : '',
            title:     titleEl ? (titleEl.textContent || '').trim() : '',
            isEmail:   el.className.includes('email'),
            isPhone:   el.className.includes('phone'),
          });
        });

        let size = '', rent = '', availability = '';
        document.querySelectorAll('h2').forEach(function(h2) {
          const label = (h2.textContent || '').trim();
          const val   = (h2.nextElementSibling?.textContent || '').replace(/\s+/g, ' ').trim();
          if (label === 'Yta')       size         = val;
          if (label === 'Hyra')      rent         = val;
          if (label === 'Tillträde') availability = val;
        });

        return { contacts, size, rent, availability };
      });

      let email = '', phone = '', contactPerson = '', contactTitle = '';
      const first = dom.contacts[0];
      if (first) {
        contactPerson = first.name;
        contactTitle  = first.title;
        const emailC  = dom.contacts.find((c: any) => c.isEmail) || first;
        const phoneC  = dom.contacts.find((c: any) => c.isPhone) || first;

        email = await fetchContact(context, 'GetEmailAddress', objectId, emailC.contactId);
        if (!email.includes('@')) email = '';
        await sleep(randInt(300, 700));
        phone = await fetchContact(context, 'GetPhoneNumber', objectId, phoneC.contactId);
        if (phone.length < 5) phone = '';
      }

      return { ...dom, email, phone, contactPerson, contactTitle };
    } catch (err: any) {
      if (delay === AB.retryDelays[AB.retryDelays.length - 1]) throw err;
    }
  }
  return {};
}

// ─── DIFF ────────────────────────────────────────────────────────────────────
function computeChanges(prev: Record<string, AgentState>, leads: Lead[]) {
  const changes: Change[] = [];
  const now = new Date().toISOString();
  const current: Record<string, { ids: Set<string>; lead: Lead }> = {};

  for (const lead of leads) {
    if (!lead.agentId) continue;
    if (!current[lead.agentId]) current[lead.agentId] = { ids: new Set(), lead };
    current[lead.agentId].ids.add(lead.objectId);
  }

  const newState: Record<string, AgentState> = {};
  for (const [agentId, { ids, lead }] of Object.entries(current)) {
    const currentIds   = Array.from(ids);
    const currentCount = lead.totalObjectCount || currentIds.length;
    const p = prev[agentId];

    newState[agentId] = { agentId, companyName: lead.companyName, totalObjectCount: currentCount, objectIds: currentIds, lastSeen: now };

    if (!p) {
      changes.push({ agentId, companyName: lead.companyName, type: 'new_agent',
        message: `Ny annonsör: ${lead.companyName} med ${currentCount} objekt totalt`, after: currentCount, timestamp: now });
    } else {
      const prevIds    = new Set(p.objectIds);
      const addedIds   = currentIds.filter(id => !prevIds.has(id));
      const removedIds = p.objectIds.filter(id => !ids.has(id));
      if (addedIds.length)   changes.push({ agentId, companyName: lead.companyName, type: 'objects_added',
        message: `${lead.companyName} lade till ${addedIds.length} objekt (nu ${currentCount} totalt)`,
        before: p.totalObjectCount, after: currentCount, addedIds, timestamp: now });
      if (removedIds.length) changes.push({ agentId, companyName: lead.companyName, type: 'objects_removed',
        message: `${lead.companyName} tog bort ${removedIds.length} objekt (nu ${currentCount} totalt)`,
        before: p.totalObjectCount, after: currentCount, removedIds, timestamp: now });
    }
  }
  return { changes, newState };
}

// ─── GOOGLE SHEETS CSV ───────────────────────────────────────────────────────
const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`;

function exportGoogleSheets(leads: Lead[]) {
  // ── Blad 1: Annonsörer ──────────────────────────────────────────────────
  const agentMap = new Map<string, Lead>();
  leads.forEach(l => {
    const ex = agentMap.get(l.agentId);
    if (!ex || l.companyName.length > (ex.companyName?.length || 0)) agentMap.set(l.agentId, l);
  });

  const agentHeaders = [
    'Annonsör-ID', 'Företagsnamn', 'Adress', 'Stad', 'Telefon', 'Hemsida',
    'E-post (kontakt)', 'Antal objekt (totalt)', 'Region', 'Objektvision-profil', 'Senast hämtad',
  ];
  const agentRows = [agentHeaders.map(esc).join(',')];
  agentMap.forEach((l, aid) => {
    agentRows.push([
      aid,
      l.companyName,
      l.companyAddress,
      getCity(l.area),
      formatPhone(l.companyPhone || l.phone),
      l.companyWebsite,
      l.email,
      l.totalObjectCount,
      l.region,
      `https://objektvision.se/Annons%C3%B6rer/${aid}`,
      new Date().toLocaleDateString('sv-SE'),
    ].map(esc).join(','));
  });

  // ── Blad 2: Kontaktpersoner ─────────────────────────────────────────────
  const contactHeaders = [
    'Förnamn', 'Efternamn', 'Titel', 'E-post', 'Telefon',
    'Företag', 'Annonsör-ID', 'Antal objekt (totalt)',
  ];
  const seen = new Set<string>();
  const contactRows = [contactHeaders.map(esc).join(',')];
  leads.forEach(l => {
    if (!l.contactPerson && !l.email) return;
    const key = `${l.agentId}::${l.email || l.contactPerson}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { firstName, lastName } = splitName(l.contactPerson);
    contactRows.push([
      firstName, lastName, l.contactTitle, l.email,
      formatPhone(l.phone), l.companyName, l.agentId, l.totalObjectCount,
    ].map(esc).join(','));
  });

  // ── Blad 3: Alla objekt ─────────────────────────────────────────────────
  const objectHeaders = [
    'Objekt-ID', 'Adress', 'Område', 'Stad', 'Region',
    'Yta', 'Hyra', 'Tillträde', 'Företag', 'Annonsör-ID',
    'Kontaktperson', 'E-post', 'Telefon', 'URL', 'Hämtad',
  ];
  const objectRows = [objectHeaders.map(esc).join(',')];
  leads.forEach(l => {
    objectRows.push([
      l.objectId, l.address, l.area, getCity(l.area), l.region,
      l.size, l.rent, l.availability, l.companyName, l.agentId,
      l.contactPerson, l.email, formatPhone(l.phone), l.objectUrl,
      new Date(l.scrapedAt).toLocaleDateString('sv-SE'),
    ].map(esc).join(','));
  });

  // ── Förändrings-logg ────────────────────────────────────────────────────
  // (Läses in separat om changes.json finns)

  const p = CONFIG.outputDir;
  fs.writeFileSync(path.join(p, 'gs_annonsorer.csv'),    '\uFEFF' + agentRows.join('\n'));
  fs.writeFileSync(path.join(p, 'gs_kontaktpersoner.csv'),'\uFEFF' + contactRows.join('\n'));
  fs.writeFileSync(path.join(p, 'gs_objekt.csv'),         '\uFEFF' + objectRows.join('\n'));

  return { agents: agentRows.length - 1, contacts: contactRows.length - 1, objects: objectRows.length - 1 };
}

// ─── HUVUD ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Objektvision Scraper v7');
  console.log('  Norrland + Dalarna + Värmland');
  console.log('═══════════════════════════════════════════════════════\n');

  if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  if (!fs.existsSync(CONFIG.sessionFile)) { console.error('❌ Kör cookie-export + konvertering'); process.exit(1); }

  const prevState  = loadState();
  const isFirstRun = Object.keys(prevState).length === 0;
  console.log(isFirstRun ? 'ℹ️  Första körningen\n' : `ℹ️  Jämför mot ${Object.keys(prevState).length} kända annonsörer\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--disable-blink-features=AutomationControlled'],
  });

  let ctx  = await newContext(browser);
  let page = await initPage(ctx);

  // ── Steg 1: Samla objekt från listsidor ──────────────────────────────────
  const allItems: Partial<Lead>[] = [];
  const maxP = CONFIG.maxPages > 0 ? CONFIG.maxPages : 999;

  for (let ri = 0; ri < REGIONS.length; ri++) {
    const reg = REGIONS[ri];
    console.log(`\n🗺️  ${reg.name}`);
    let regionCount = 0;

    for (let p = 1; p <= maxP; p++) {
      process.stdout.write(`  Sida ${p}... `);
      const items = await scrapeListPage(page, `${reg.url}?p=${p}`, reg.name);
      process.stdout.write(`${items.length} objekt\n`);
      if (items.length === 0) break;
      allItems.push(...items);
      regionCount += items.length;
      await randSleep(AB.pageDelayMin, AB.pageDelayMax);
    }
    console.log(`  ✅ ${regionCount} objekt`);
    if (ri < REGIONS.length - 1) {
      const ms = randInt(AB.regionDelayMin, AB.regionDelayMax);
      console.log(`  ⏸️  ${(ms/1000).toFixed(0)}s regionpaus...`);
      await sleep(ms);
    }
  }

  console.log(`\n✅ ${allItems.length} objekt totalt\n`);

  // ── Steg 2: Hämta annonsörssidor (en per unik agentId) ───────────────────
  const uniqueAgentIds = [...new Set(allItems.map(i => i.agentId).filter(Boolean))] as string[];
  console.log(`🏢 Hämtar ${uniqueAgentIds.length} annonsörssidor för korrekta objektantal...\n`);

  const agentInfoCache: Record<string, AgentInfo> = {};
  for (let i = 0; i < uniqueAgentIds.length; i++) {
    const aid = uniqueAgentIds[i];
    process.stdout.write(`  [${i+1}/${uniqueAgentIds.length}] Annonsör ${aid} ... `);
    const info = await scrapeAgentPage(page, aid);
    agentInfoCache[aid] = info;
    console.log(`${info.companyName || '?'} – ${info.totalObjectCount} objekt totalt`);
    await randSleep(AB.itemDelayMin, AB.itemDelayMax);
  }

  // ── Steg 3: Beskriv-sidor med kontaktdata ────────────────────────────────
  console.log(`\n📞 Hämtar kontaktdata från ${allItems.length} annonser...\n`);
  console.log('─'.repeat(60));

  const leads: Lead[]  = [];
  let consecutive = 0;
  let ctxCount    = 0;

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const id   = item.objectId!;

    if (ctxCount >= AB.rotateContextEvery) {
      console.log('\n  🔄 Roterar kontext...');
      await ctx.close();
      ctx  = await newContext(browser);
      page = await initPage(ctx);
      ctxCount = 0;
      await sleep(randInt(3000, 6000));
    }

    if (i > 0 && i % AB.longBreakEvery === 0) {
      const ms = randInt(AB.longBreakMin, AB.longBreakMax);
      console.log(`\n  ☕ Paus ${(ms/1000).toFixed(0)}s (${i}/${allItems.length})...`);
      await sleep(ms);
    }

    process.stdout.write(`[${String(i+1).padStart(4)}/${allItems.length}] ${id} ... `);

    try {
      const detail   = await scrapeBeskriv(page, ctx, id);
      const agentInfo = agentInfoCache[item.agentId!] || {} as AgentInfo;

      leads.push({
        objectId:         id,
        address:          item.address          || '',
        area:             item.area             || '',
        region:           item.region           || '',
        agentId:          item.agentId          || '',
        size:             detail.size           || '',
        rent:             detail.rent           || '',
        availability:     detail.availability   || '',
        companyName:      agentInfo.companyName || detail.companyName || '',
        companyAddress:   agentInfo.companyAddress || '',
        companyPhone:     agentInfo.companyPhone   || '',
        companyWebsite:   agentInfo.companyWebsite || '',
        companyOvUrl:     `https://objektvision.se/Annons%C3%B6rer/${item.agentId}`,
        totalObjectCount: agentInfo.totalObjectCount || 0,
        contactPerson:    detail.contactPerson  || '',
        contactTitle:     detail.contactTitle   || '',
        email:            detail.email          || '',
        phone:            detail.phone          || '',
        objectUrl:        `https://objektvision.se${item.objectUrl || '/Beskriv/'+id}`,
        scrapedAt:        new Date().toISOString(),
      });

      console.log([
        agentInfo.companyName ? `🏢 ${agentInfo.companyName}` : '⚠️  ?',
        `📦 ${agentInfo.totalObjectCount} obj`,
        detail.email  ? `📧 ${detail.email}`  : '📧 -',
        detail.phone  ? `📞 ${detail.phone}`  : '📞 -',
      ].join('  '));

      consecutive = 0;
      ctxCount++;

    } catch (err: any) {
      consecutive++;
      console.log(`❌ ${err.message?.substring(0,60)}`);
      if (consecutive >= AB.maxConsecutiveFails) {
        console.log(`\n⛔ ${consecutive} fel – pausar ${AB.consecutiveFailPause/1000}s...`);
        await sleep(AB.consecutiveFailPause);
        consecutive = 0;
        await ctx.close();
        ctx  = await newContext(browser);
        page = await initPage(ctx);
        ctxCount = 0;
      }
    }

    if (leads.length > 0 && leads.length % 25 === 0) {
      fs.writeFileSync(path.join(CONFIG.outputDir, 'leads_partial.json'), JSON.stringify(leads, null, 2));
    }
    if (i < allItems.length - 1) await randSleep(AB.itemDelayMin, AB.itemDelayMax);
  }

  await ctx.close();
  await browser.close();

  // ── Steg 4: Diff + spara ─────────────────────────────────────────────────
  const { changes, newState } = computeChanges(prevState, leads);
  saveState(newState);

  fs.writeFileSync(path.join(CONFIG.outputDir, 'leads.json'),   JSON.stringify(leads, null, 2));
  fs.writeFileSync(path.join(CONFIG.outputDir, 'changes.json'), JSON.stringify(changes, null, 2));

  // Förändrings-CSV för Google Sheets
  if (changes.length > 0) {
    const changeHeaders = ['Tidpunkt','Typ','Annonsör-ID','Företag','Förut','Nu','Meddelande'];
    const changeRows = [changeHeaders.map(esc).join(','),
      ...changes.map(c => [
        new Date(c.timestamp).toLocaleString('sv-SE'),
        c.type, c.agentId, c.companyName,
        c.before ?? '', c.after ?? '', c.message,
      ].map(esc).join(','))];
    fs.writeFileSync(path.join(CONFIG.outputDir, 'gs_forandringar.csv'), '\uFEFF' + changeRows.join('\n'));
  }

  const { agents, contacts, objects } = exportGoogleSheets(leads);

  // ── Rapport ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`✅ Klar! ${leads.length} annonser scrapad`);
  console.log('\n📁 Google Sheets-filer:');
  console.log(`   gs_annonsorer.csv      (${agents} företag)`);
  console.log(`   gs_kontaktpersoner.csv (${contacts} kontakter)`);
  console.log(`   gs_objekt.csv          (${objects} annonser)`);
  if (changes.length > 0) console.log(`   gs_forandringar.csv    (${changes.length} förändringar)`);
  console.log('\n📁 Övrigt:');
  console.log('   leads.json  |  changes.json  |  state.json');

  if (changes.length > 0 && !isFirstRun) {
    console.log(`\n🔔 FÖRÄNDRINGAR (${changes.length} st):`);
    changes.forEach(c => console.log(`   [${c.type}] ${c.message}`));
  } else if (!isFirstRun) {
    console.log('\n✅ Inga förändringar sedan senaste körning');
  } else {
    console.log('\nℹ️  Baslinje sparad i state.json');
  }

  console.log(`\n📈 Med e-post:  ${leads.filter(l=>l.email).length}/${leads.length}`);
  console.log(`   Med telefon: ${leads.filter(l=>l.phone).length}/${leads.length}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('💥', err); process.exit(1); });
