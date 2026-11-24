#!/usr/bin/env node
/**
 * Daily vacancy update for skilllondon.com
 *
 * Run by .github/workflows/update-vacancies.yml every day at 06:00 UTC.
 * Pulls live listings from two official GOV.UK services and rewrites
 * vacancies.json, which skilllondon.com/vacancies reads.
 *
 *   1. Find an Apprenticeship – Route 9 (Engineering and Manufacturing)
 *   2. Teaching Vacancies – every job at FE colleges (all subjects and roles)
 *
 * If a source fails, the vacancies already saved for that source are kept.
 * If both sources return nothing, the script exits with an error and leaves
 * the file untouched, so the site never shows an empty list.
 *
 * Run locally:  node scripts/update-vacancies.js
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.resolve(__dirname, '../vacancies.json');

const APPRENTICESHIP_URL = 'https://www.findapprenticeship.service.gov.uk/apprenticeships?routeIds=9&distance=10&routePath=Location';
const APPRENTICESHIP_PAGES = 5; // 10 per page

const TEACHING_BASE = 'https://teaching-vacancies.service.gov.uk';
const TEACHING_FE_URL = TEACHING_BASE + '/jobs?organisation_types%5B%5D=FE+Colleges&sort_by=expires_at_non_default';
const TEACHING_PAGES = 50; // 10 per page; about 340 FE college jobs in Nov 2026

const APPRENTICESHIP_CATEGORY = 'Apprenticeship';
const FE_CATEGORY = 'FE College & Teaching';

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'SkillLondonVacancyBot/1.0 (+https://skilllondon.com/vacancies)',
      'Accept': 'text/html',
      'Accept-Language': 'en-GB,en;q=0.9'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseGovUkDate(str) {
  const m = (str || '').match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  const month = m && MONTHS[m[2].toLowerCase()];
  return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
}

function clean(str) {
  return (str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#xA3;|&pound;/gi, '£')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function levelFor(course, title) {
  const t = `${course} ${title}`.toLowerCase();
  if (t.includes('level 2')) return ['Level 2 (Intermediate)', 'Level 2'];
  if (t.includes('level 4')) return ['Level 4 (Higher / HNC)', 'Level 4'];
  if (/level 5|level 6|level 7|degree/.test(t)) return ['Degree Apprenticeship (Level 6+)', 'Degree'];
  return ['Level 3 (Advanced / EPA)', 'Level 3'];
}

function apprenticeshipDiscipline(title, course) {
  if (/machining|cnc|turner|miller/i.test(title) || /machining/i.test(course)) return 'Machining';
  if (/electronic|electrical/i.test(title) || /electrical/i.test(course)) return 'Electrical';
  if (/maintenance|mechatronic/i.test(title) || /maintenance/i.test(course)) return 'Maintenance';
  if (/design|cad/i.test(title) || /design/i.test(course)) return 'Design & CAD';
  if (/rail/i.test(title)) return 'Rail & Transport';
  if (/aerospace/i.test(title)) return 'Aerospace & Defence';
  return 'Manufacturing & Production';
}

/** 1. GOV.UK Find an Apprenticeship – Route 9 */
async function fetchApprenticeships() {
  const out = [];
  for (let page = 1; page <= APPRENTICESHIP_PAGES; page++) {
    const html = await getHtml(`${APPRENTICESHIP_URL}&pageNumber=${page}`);
    const items = html.split('<li class="das-search-results__list-item').slice(1);
    if (items.length === 0) break;

    for (const block of items) {
      const link = block.match(/href="(\/apprenticeship\/(VAC\d+))"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
      if (!link) continue;
      const [, vacPath, id, rawTitle] = link;
      const title = clean(rawTitle);

      const employer = clean((block.match(/<p class="govuk-body govuk-!-margin-bottom-0">([\s\S]*?)<\/p>/i) || [])[1]) || 'UK Engineering Employer';
      const location = clean((block.match(/<p class="govuk-body das-!-color-dark-grey">([\s\S]*?)<\/p>/i) || [])[1]) || 'United Kingdom';
      const course = clean((block.match(/<b>Training course<\/b>\s*([^<]+)<\/p>/i) || [])[1]) || 'Engineering and Manufacturing (Route 9)';
      const wage = clean((block.match(/<b>Wage<\/b>\s*([^<]+)<\/p>/i) || [])[1]) || 'See advert';
      const closingDate = parseGovUkDate((block.match(/Closes[^\n<]+/i) || [])[0]);
      const postedDate = parseGovUkDate((block.match(/Posted\s+([^\n<]+)/i) || [])[1]) || today();
      const [level, levelCode] = levelFor(course, title);

      out.push({
        id,
        title,
        employer,
        location,
        borough: location,
        category: APPRENTICESHIP_CATEGORY,
        level,
        levelCode,
        discipline: apprenticeshipDiscipline(title, course),
        salary: wage,
        closingDate,
        postedDate,
        epaStandard: course,
        applicationUrl: `https://www.findapprenticeship.service.gov.uk${vacPath}`,
        description: `Official vacancy from the GOV.UK Find an Apprenticeship service. Training course: ${course}.`,
        requirements: 'See the full advert on GOV.UK for entry requirements.',
        source: 'GOV.UK Find an Apprenticeship (Route 9)'
      });
    }
    await sleep(500);
  }
  return out;
}

/** Sort a GOV.UK FE college job title into a subject area and a role type. */
const FE_DISCIPLINE_RULES = [
  ['Electrical', /electric|electrotechnical/],
  ['Engineering & Manufacturing', /engineer|mechanical|fabricat|welding|manufactur|motor vehicle|automotive|aerospace|cnc|machining|marine|mechatronic|\brail\b|\bhgv\b|\bstem\b/],
  ['Construction & Trades', /construct|carpentry|joinery|plumb|brick|plaster|painting|decorat|building services|built environment|\bgas\b|hvac|refrigerat|multi-?trade|trowel|roofing|civil/],
  ['Computing & Digital', /computing|digital|\bit\b|\bict\b|software|cyber|data science|programming|\bai\b|developer/],
  ['Maths & English', /\bmaths?\b|mathematic|english|functional skills|esol|essential skills|literacy|numeracy|celta|\bgcse\b/],
  ['Science', /science|physics|chemistry|biology/],
  ['Health, Care & Early Years', /health|\bcare\b|caring|nursing|early years|childcare|childhood|nursery|social|dental|pharmac|counsell/],
  ['Land-based & Animal Care', /equine|animal|countryside|habitat|horticult|agricult|land-?based|floristry|forestry|veterinary|groom|butcher|zoo/],
  ['Business, Law & Tourism', /business|accounting|\blaw\b|legal|travel|tourism|aviation|enterprise|retail/],
  ['Creative Arts & Media', /\bart\b|\barts\b|design|media|music|performing|drama|dance|photograph|fashion|games|creative|film|theatre|radio|podcast|violin|guitar|piano|\bband\b|vocal/],
  ['Languages & Teacher Training', /mandarin|chinese|french|spanish|german|arabic|language|teacher training|teacher education|\bpgce\b|professional development|advanced practitioner|learning & development|learning and development/],
  ['Humanities & A Levels', /geograph|history|psycholog|sociolog|philosoph|politic|religio|criminolog|a levels?\b|humanities/],
  ['Sport & Public Services', /sport|public services|uniformed|fitness|protective|adventure/],
  ['Hair, Beauty & Hospitality', /hair|barber|beauty|catering|hospitality|\bchef\b|culinary|bakery|patisserie|\bspa\b/],
  ['Learning Support & SEND', /learning support|\bsend\b|\bsen\b|senco|sendco|inclusive|educational support|pathways|\bspld\b|inclusion|mentor|pastoral|foundation|high needs|supported|supporting teaching|teaching assistant|transition|\bea?hcp\b|interpret|sign language|access/],
  ['College Support Staff', /clean|caretak|estates|admin|reception|finance|funding|compliance|payroll|\bhr\b|human resources|people|organisational|marketing|it support|exams?\b|careers|safeguarding|librar|learning resource|security|service assistant|facilities|data|\bmis\b|recruitment|student services|welfare|attendance|placement|employ|engagement|enrichment|clerk|officer|coordinator|technician|groom|supervisor|operations/]
];

function feDiscipline(title) {
  const t = title.toLowerCase();
  for (const [name, re] of FE_DISCIPLINE_RULES) if (re.test(t)) return name;
  return 'Other FE Roles';
}

function feRole(title) {
  const t = title.toLowerCase();
  if (/\b(head|director|principal|manager|leader|leadership)\b|\bcm\b/.test(t) && !/head chef/.test(t)) return 'FE College Leadership & Management';
  if (/assessor|skills coach|trainer|\biqa\b|verifier|work-?based/.test(t)) return 'FE College Assessor / Trainer';
  if (/lecturer|teacher|tutor|instructor|teaching|practitioner/.test(t) && !/assistant|support tutor|pastoral/.test(t)) return 'FE College Lecturer / Teacher';
  return 'FE College Support Staff';
}

/** 2. GOV.UK Teaching Vacancies – FE colleges */
async function fetchFeCollegeJobs() {
  const listings = [];
  const seenPaths = new Set();
  for (let page = 1; page <= TEACHING_PAGES; page++) {
    const html = await getHtml(`${TEACHING_FE_URL}&page=${page}`);
    const blocks = html.split('<div class="search-results__item"').slice(1);
    if (blocks.length === 0) break;

    let newOnPage = 0;
    for (const block of blocks) {
      const link = block.match(/href="(\/jobs\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link || seenPaths.has(link[1])) continue;
      seenPaths.add(link[1]);
      newOnPage++;
      const paras = [...block.matchAll(/<p class="govuk-body[^"]*">([\s\S]*?)<\/p>/gi)].map(m => clean(m[1]));
      listings.push({
        jobPath: link[1],
        title: clean(link[2]),
        address: clean((block.match(/<p class="govuk-body address[^"]*">([\s\S]*?)<\/p>/i) || [])[1]) || 'FE College, UK',
        salary: (paras.find(p => /salary|£/i.test(p)) || 'See advert').replace(/^(Full time equivalent salary|Salary)\s*/i, ''),
        pattern: paras.find(p => /full time|part time|ages/i.test(p)) || 'See advert'
      });
    }
    // Past the last page GOV.UK repeats the final page, so stop when nothing is new.
    if (blocks.length < 10 || newOnPage === 0) break;
    await sleep(500);
  }

  // The list page no longer shows closing dates, so read them from each job page.
  const out = [];
  for (const job of listings) {
    let closingDate = null;
    let postedDate = today();
    try {
      const detail = await getHtml(TEACHING_BASE + job.jobPath);
      const valid = detail.match(/"validThrough"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
      const posted = detail.match(/"datePosted"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
      if (valid) closingDate = valid[1];
      if (posted) postedDate = posted[1];
    } catch (err) {
      console.warn(`  Could not read ${job.jobPath}: ${err.message}`);
    }
    await sleep(300);

    out.push({
      id: `fe-govuk-${job.jobPath.replace('/jobs/', '')}`,
      title: job.title,
      employer: job.address.split(',')[0].trim(),
      location: job.address,
      borough: job.address,
      category: FE_CATEGORY,
      level: feRole(job.title),
      levelCode: 'FE College',
      discipline: feDiscipline(job.title),
      salary: job.salary,
      closingDate,
      postedDate,
      epaStandard: `Further Education College (${job.pattern})`,
      applicationUrl: TEACHING_BASE + job.jobPath,
      description: `Official Further Education vacancy from GOV.UK Teaching Vacancies at ${job.address}. ${job.pattern}.`,
      requirements: 'See the full advert on GOV.UK for qualifications and experience required.',
      source: 'GOV.UK Teaching & FE Vacancies'
    });
  }
  return out;
}

function loadSaved() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { meta: {}, vacancies: [] };
  }
}

/** Use fresh results for a source; if that source failed, keep what was saved for it. */
async function freshOrSaved(name, category, fetcher, saved, log) {
  try {
    const fresh = await fetcher();
    if (fresh.length > 0) {
      log.push(`${name}: ${fresh.length} live vacancies fetched.`);
      return fresh;
    }
    log.push(`${name}: no results returned, kept previous listings.`);
  } catch (err) {
    log.push(`${name}: fetch failed (${err.message}), kept previous listings.`);
  }
  return saved.filter(v => v.category === category);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(v => {
    const key = `${v.title}|${v.employer}|${v.location}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const saved = loadSaved();
  const savedList = saved.vacancies || [];
  const log = [];

  const apprenticeships = await freshOrSaved('Apprenticeships', APPRENTICESHIP_CATEGORY, fetchApprenticeships, savedList, log);
  const feJobs = await freshOrSaved('FE college jobs', FE_CATEGORY, fetchFeCollegeJobs, savedList, log);

  const t = today();
  const vacancies = dedupe([...feJobs, ...apprenticeships])
    .filter(v => !v.closingDate || v.closingDate >= t);

  log.forEach(line => console.log(line));

  if (vacancies.length === 0) {
    console.error('No vacancies found from either source. Leaving vacancies.json unchanged.');
    process.exit(1);
  }

  const now = new Date();
  const formatted = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    + ' at ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

  const data = {
    meta: {
      lastUpdated: now.toISOString(),
      lastUpdatedFormatted: formatted,
      sourceName: 'GOV.UK Find an Apprenticeship & Teaching Vacancies in FE Colleges',
      sourceUrl: APPRENTICESHIP_URL,
      schedule: 'Daily at 06:00 UTC (GitHub Actions)',
      totalActive: vacancies.length,
      status: 'active',
      syncLog: log
    },
    vacancies
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`Saved ${vacancies.length} vacancies to vacancies.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
