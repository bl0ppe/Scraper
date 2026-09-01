/**
 * hubspot-export.ts
 *
 * Läser output/leads.json och skapar:
 *   1. hubspot_companies.csv  – importeras som Companies i HubSpot
 *   2. hubspot_contacts.csv   – importeras som Contacts i HubSpot
 *
 * Kör: yarn hubspot-export
 */

import * as fs from 'fs';
import * as path from 'path';

const OUTPUT_DIR = './output';

interface Lead {
  objectId:      string;
  address:       string;
  area:          string;
  size:          string;
  rent:          string;
  availability:  string;
  agentId:       string;
  companyName:   string;
  contactPerson: string;
  contactTitle:  string;
  email:         string;
  phone:         string;
  objectUrl:     string;
  scrapedAt:     string;
}

const esc = (s: any) => `"${String(s || '').replace(/"/g, '""')}"`;

function formatPhone(phone: string): string {
  if (!phone) return '';
  let p = phone.replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('0') && !p.startsWith('+')) p = '+46' + p.slice(1);
  return p;
}

function extractDomain(email: string): string {
  if (!email || !email.includes('@')) return '';
  return email.split('@')[1].toLowerCase().trim();
}

function getCity(area: string): string {
  const parts = area.split(',').map(s => s.trim());
  return parts[parts.length - 1] || area;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function main() {
  const leadsPath = path.join(OUTPUT_DIR, 'leads.json');
  if (!fs.existsSync(leadsPath)) {
    console.error('❌ output/leads.json saknas – kör yarn scrape först');
    process.exit(1);
  }

  const leads: Lead[] = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
  console.log(`✅ Läste ${leads.length} leads\n`);

  // Räkna annonser per annonsör
  const agentCount: Record<string, number> = {};
  leads.forEach(l => { agentCount[l.agentId] = (agentCount[l.agentId] || 0) + 1; });

  // ── Companies ─────────────────────────────────────────────────────────────
  const companyHeaders = [
    'Company name',
    'City',
    'Company Domain Name',
    'Objektvision Agent ID',
    'Objektvision profil',
    'Antal annonser OV',
    'Lead Source',
  ];

  // En rad per unikt agentId – välj lead med bäst data
  const companyMap = new Map<string, Lead>();
  leads.forEach(l => {
    if (!l.agentId) return;
    const existing = companyMap.get(l.agentId);
    if (!existing || (l.companyName.length > (existing.companyName?.length || 0))) {
      companyMap.set(l.agentId, l);
    }
  });

  const companyRows: string[] = [companyHeaders.map(esc).join(',')];
  companyMap.forEach((lead, agentId) => {
    companyRows.push([
      lead.companyName || `Annonsör ${agentId}`,
      getCity(lead.area),
      extractDomain(lead.email),
      agentId,
      `https://objektvision.se/Annonsörer/${agentId}`,
      agentCount[agentId] || 1,
      'Objektvision',
    ].map(esc).join(','));
  });

  // ── Contacts ──────────────────────────────────────────────────────────────
  const contactHeaders = [
    'First Name',
    'Last Name',
    'Email',
    'Phone Number',
    'Job Title',
    'Associated Company',
    'Objektvision objekt URL',
    'Antal annonser OV',
    'Lead Source',
  ];

  const contactKey = new Set<string>();
  const contactRows: string[] = [contactHeaders.map(esc).join(',')];

  leads.forEach(l => {
    if (!l.contactPerson && !l.email) return;
    const key = `${l.agentId}::${l.email || l.contactPerson}`;
    if (contactKey.has(key)) return;
    contactKey.add(key);

    const { firstName, lastName } = splitName(l.contactPerson);
    contactRows.push([
      firstName,
      lastName,
      l.email,
      formatPhone(l.phone),
      l.contactTitle,
      l.companyName || `Annonsör ${l.agentId}`,
      l.objectUrl,
      agentCount[l.agentId] || 1,
      'Objektvision',
    ].map(esc).join(','));
  });

  // ── Spara ─────────────────────────────────────────────────────────────────
  const companyCsvPath = path.join(OUTPUT_DIR, 'hubspot_companies.csv');
  const contactCsvPath = path.join(OUTPUT_DIR, 'hubspot_contacts.csv');
  fs.writeFileSync(companyCsvPath, '\uFEFF' + companyRows.join('\n'));
  fs.writeFileSync(contactCsvPath, '\uFEFF' + contactRows.join('\n'));

  const nCompanies = companyRows.length - 1;
  const nContacts  = contactRows.length - 1;

  console.log('═══════════════════════════════════════════════════');
  console.log('  HubSpot Export klar');
  console.log('═══════════════════════════════════════════════════');
  console.log(`\n📁 output/hubspot_companies.csv  (${nCompanies} företag)`);
  console.log(`📁 output/hubspot_contacts.csv   (${nContacts} kontakter)`);
  console.log(`\n📈 Täckning:`);
  console.log(`   Leads totalt:    ${leads.length}`);
  console.log(`   Med e-post:      ${leads.filter(l => l.email).length}`);
  console.log(`   Med telefon:     ${leads.filter(l => l.phone).length}`);
  console.log(`   Unika företag:   ${nCompanies}`);
  console.log(`   Unika kontakter: ${nContacts}`);
  console.log('\n─────────────────────────────────────────────────────');
  console.log('📋 IMPORT I HUBSPOT (gör en gång):');
  console.log('');
  console.log('  1. Skapa custom properties');
  console.log('     Settings → Properties → Company properties → Create property:');
  console.log('       "Objektvision Agent ID"  (Single-line text)');
  console.log('       "Objektvision profil"    (URL)');
  console.log('       "Antal annonser OV"      (Number)');
  console.log('');
  console.log('     Settings → Properties → Contact properties → Create property:');
  console.log('       "Objektvision objekt URL" (URL)');
  console.log('       "Antal annonser OV"       (Number)');
  console.log('');
  console.log('  2. Importera Companies');
  console.log('     Contacts → Import → One file → Companies');
  console.log('     Ladda upp: hubspot_companies.csv');
  console.log('');
  console.log('  3. Importera Contacts (kopplas till Companies automatiskt)');
  console.log('     Contacts → Import → One file → Contacts');
  console.log('     Ladda upp: hubspot_contacts.csv');
  console.log('     OBS: "Associated Company" måste matcha "Company name" exakt');
  console.log('─────────────────────────────────────────────────────\n');
}

main();
