import * as fs from 'fs';

const INPUT  = './session/cookies_raw.json';
const OUTPUT = './session/storage.json';

interface RawCookie {
  name: string; value: string; domain: string; path: string;
  secure?: boolean; httpOnly?: boolean; sameSite?: string;
  expirationDate?: number; expires?: number;
}

function normalizeSameSite(val: string | undefined): 'Strict' | 'Lax' | 'None' {
  const v = (val || '').toLowerCase();
  if (v === 'strict')                          return 'Strict';
  if (v === 'none' || v === 'no_restriction')  return 'None';
  return 'Lax'; // default – täcker 'lax', 'unspecified', undefined, allt annat
}

const raw: RawCookie[] = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

const storage = {
  cookies: raw.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
    path:     c.path || '/',
    expires:  c.expirationDate ?? c.expires ?? -1,
    httpOnly: c.httpOnly || false,
    secure:   c.secure   || false,
    sameSite: normalizeSameSite(c.sameSite),
  })),
  origins: [] as any[],
};

if (!fs.existsSync('./session')) fs.mkdirSync('./session');
fs.writeFileSync(OUTPUT, JSON.stringify(storage, null, 2));
console.log(`✅ ${raw.length} cookies konverterade → ${OUTPUT}`);
console.log('Kör nu: yarn sniff');
