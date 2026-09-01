# Objektvision Scraper V3

Ett automatiserat verktyg för att scrapa företagsdata, kontaktuppgifter och objektlistningar från [Objektvision.se](https://objektvision.se), med export till Google Sheets och HubSpot.

## Funktioner

- Scrapar lediga lokaler från valda regioner (Norrland, Dalarna, Värmland)
- Hämtar korrekt totalt antal objekt per annonsör via `/Annonsörer/`-sidan
- Hämtar dolda kontaktuppgifter (e-post + telefon) via Objektvisions interna API
- Spårar förändringar mellan körningar (nya/borttagna objekt per annonsör)
- Exporterar till Google Sheets-kompatibla CSV-filer
- Exporterar till HubSpot-kompatibla CSV-filer
- Inbyggda anti-block-skydd (slumpmässiga pauser, User-Agent rotation, kontext-rotation)

---

## Krav

- Node.js 18+
- Yarn
- En vanlig webbläsare med tillägget [Cookie-Editor](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
- Ubuntu/Debian-server (eller annan Linux-miljö)

---

## Installation

```bash
# Klona repot
git clone https://github.com/DITT-ANVÄNDARNAMN/objektvision-scraper.git
cd objektvision-scraper

# Installera dependencies
yarn install

# Installera Chromium (Playwright)
npx playwright install chromium
```

---

## Konfiguration

Öppna `scrape.ts` och justera `CONFIG`-objektet längst upp:

```typescript
const CONFIG = {
  maxPages:    1,    // Antal sidor per region. 0 = alla sidor (full körning)
  outputDir:   './output',
  sessionFile: './session/storage.json',
  stateFile:   './output/state.json',
  pageTimeout: 60000,
};
```

Regioner konfigureras i `REGIONS`-arrayen. Kommentera bort de regioner du inte vill scrapa.

---

## Användning

### Steg 1 – Förnya session (krävs varje 24–48h)

Cloudflare skyddar Objektvision och kräver en giltig webbläsarsession.

**1a.** Öppna din vanliga webbläsare och gå till:
```
https://objektvision.se/lediga_lokaler/gavleborgs-lan
```
Vänta tills objektlistan laddas (lös eventuellt CAPTCHA).

**1b.** Klicka på Cookie-Editor-ikonen → **Export** → **Export as JSON** → kopiera all text.

**1c.** På servern – klistra in cookies:
```bash
mkdir -p session
nano session/cookies_raw.json
# Klistra in JSON-texten, spara med Ctrl+X → Y → Enter
```

**1d.** Konvertera till Playwright-format:
```bash
node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('./session/cookies_raw.json', 'utf8'));
const fix = v => { const l=(v||'').toLowerCase(); if(l==='strict') return 'Strict'; if(l==='none'||l==='no_restriction') return 'None'; return 'Lax'; };
const storage = { cookies: raw.map(c => ({ name:c.name, value:c.value, domain:c.domain.startsWith('.')?c.domain:'.'+c.domain, path:c.path||'/', expires:c.expirationDate??c.expires??-1, httpOnly:c.httpOnly||false, secure:c.secure||false, sameSite:fix(c.sameSite) })), origins:[] };
fs.mkdirSync('./session',{recursive:true});
fs.writeFileSync('./session/storage.json', JSON.stringify(storage,null,2));
console.log('✅ ' + raw.length + ' cookies konverterade');
"
```

**1e.** Verifiera att sessionen fungerar (ska INTE visa `/clearance`):
```bash
yarn sniff
```

---

### Steg 2 – Testköra (rekommenderas)

Kontrollera att allt fungerar med 1 sida från 1 region innan full körning.

I `scrape.ts`, sätt `maxPages: 1` och kommentera bort alla regioner utom en:
```typescript
const REGIONS = [
  { name: 'Värmlands län', url: 'https://objektvision.se/lediga_lokaler/v%C3%A4rmlands-l%C3%A4n' },
  // övriga kommenterade
];
```

```bash
yarn scrape
```

Kolla att output-filerna innehåller rimlig data:
```bash
cat output/gs_annonsorer.csv | head -5
```

---

### Steg 3 – Full körning

Återställ `maxPages: 0` och avkommentera alla regioner, sedan:

```bash
yarn scrape
```

Körningen tar tid beroende på antal objekt. Slumpmässiga pauser är inbyggda för att undvika blockering. Ungefärlig tid: ~2–4 sekunder per objekt.

---

## Output-filer

Alla filer sparas i `output/`-mappen.

### Google Sheets (rekommenderat)
| Fil | Innehåll |
|-----|----------|
| `gs_annonsorer.csv` | Ett företag per rad – namn, adress, telefon, hemsida, totalt antal objekt |
| `gs_kontaktpersoner.csv` | En kontaktperson per rad kopplad till företag |
| `gs_objekt.csv` | Varje enskild annons med all data |
| `gs_forandringar.csv` | Förändringar sedan senaste körning (skapas vid körning 2+) |

### HubSpot
| Fil | Innehåll |
|-----|----------|
| `hubspot_companies.csv` | Companies-import |
| `hubspot_contacts.csv` | Contacts-import med association till Companies |

### Övrigt
| Fil | Innehåll |
|-----|----------|
| `leads.json` | All rådata som JSON |
| `state.json` | Tillstånd för diff-jämförelse mellan körningar |
| `changes.json` | Förändringar i JSON-format |
| `leads_partial.json` | Automatisk backup var 25:e objekt under körning |

---

## Importera till Google Sheets

1. Gå till [Google Sheets](https://sheets.google.com) och skapa ett nytt dokument
2. **Arkiv → Importera** → ladda upp `gs_annonsorer.csv`
   - Välj: *Infoga ny flik*, Avgränsare: *Komma*, Konvertera: *Ja*
3. Upprepa för `gs_kontaktpersoner.csv` och `gs_objekt.csv` (en flik per fil)
4. Döp flikarna till *Annonsörer*, *Kontakter*, *Objekt*

---

## Importera till HubSpot

### Engångsinställning – skapa custom properties

**Company properties** (Settings → Properties → Company → Create):
- `Objektvision Agent ID` (Single-line text)
- `Objektvision profil` (URL)
- `Antal annonser OV` (Number)

**Contact properties** (Settings → Properties → Contact → Create):
- `Objektvision objekt URL` (URL)
- `Antal annonser OV` (Number)

### Import

1. **Companies först**: Contacts → Import → One file → Companies → `hubspot_companies.csv`
2. **Contacts sedan**: Contacts → Import → One file → Contacts → `hubspot_contacts.csv`
   - Mappa *Associated Company* → Company name (HubSpot matchar automatiskt)

---

## Förändringsnotiser

Vid varje körning jämförs data mot `output/state.json` från föregående körning.

Om en annonsör har lagt till eller tagit bort objekt visas det i terminalen:
```
🔔 FÖRÄNDRINGAR (2 st):
   [objects_added]   Fastighets AB har lagt till 3 objekt (nu 11 totalt)
   [objects_removed] Lokalmäklarna tog bort 1 objekt (nu 4 totalt)
```

Förändringarna sparas även i `output/gs_forandringar.csv` för import till Google Sheets.

---

## Scripts

| Kommando | Beskrivning |
|----------|-------------|
| `yarn scrape` | Kör huvudscrapers |
| `yarn sniff` | Verifiera att sessionen fungerar |
| `yarn hubspot-export` | Generera HubSpot-CSV från befintlig leads.json |
| `yarn inspect` | Analysera DOM-struktur (felsökning) |
| `yarn inspect2` | Djupanalys av objekt-kort och Beskriv-sida |
| `yarn inspect3` | Spåra Visa-knappars AJAX-anrop |
| `yarn sniff2` | Djupanalys av nätverksanrop |
| `yarn login` | Öppna synlig webbläsare för manuell inloggning (kräver skärm) |

---

## Anti-block-skydd

Följande åtgärder är inbyggda för att minimera risken för blockering:

- **Slumpmässiga pauser** – 2–5s mellan objekt, 4–8s mellan listsidor, 10–20s mellan regioner
- **Kafferaster** – 15–35s paus var 20:e objekt
- **User-Agent rotation** – växlar mellan 5 olika webbläsar-identiteter
- **Kontext-rotation** – ny browser-fingerprint var 50:e objekt
- **Human-scroll** – simulerar mänsklig scrollning på varje sida
- **Exponentiell backoff** – väntar 5s, 15s, 45s vid fel innan retry
- **Lång paus vid upprepade fel** – 2 minuters paus vid 5 fel i rad

> **Tips:** Använd VPN och byt IP-adress mellan körningar för ytterligare skydd.

---

## Projektstruktur

```
objektvision-scraper/
├── scrape.ts              # Huvudscript – scrapar och exporterar
├── hubspot-export.ts      # Genererar HubSpot-CSV från leads.json
├── login.ts               # Öppnar synlig webbläsare (kräver skärm)
├── convert-cookies.ts     # Konverterar Cookie-Editor-export till Playwright
├── sniff.ts               # API-sniffare för sessionverifiering
├── sniff2.ts              # Djupanalys av nätverksanrop
├── inspect.ts             # DOM-strukturanalys
├── inspect2.ts            # Objekt-kort och Beskriv-sidanalys
├── inspect3.ts            # Spårning av Visa-knappar
├── package.json
├── tsconfig.json
├── session/               # Gitignorerad – innehåller cookies
│   ├── cookies_raw.json
│   └── storage.json
└── output/                # Gitignorerad – genererade filer
    ├── leads.json
    ├── state.json
    ├── changes.json
    ├── gs_annonsorer.csv
    ├── gs_kontaktpersoner.csv
    ├── gs_objekt.csv
    └── gs_forandringar.csv
```

---

## .gitignore

```
node_modules/
session/
output/
*.partial.json
```

> **Viktigt:** `session/` och `output/` ska aldrig checkas in i Git då de innehåller känsliga cookies och personuppgifter.

---

## Vanliga problem

### "0 objekt" på alla sidor
Sessionen har gått ut. Förnya cookies enligt Steg 1 ovan.

### TypeScript-fel med `window` / `document`
Kontrollera att `tsconfig.json` innehåller `"lib": ["ES2020", "DOM"]`.

### `Cannot find module 'arg'`
Använd projektets lokala ts-node istället för den systeminstallerade:
```bash
./node_modules/.bin/ts-node scrape.ts
```

### Rate limit / blockering
Öka pauserna i `ANTI_BLOCK`-objektet i `scrape.ts`, eller använd VPN.
