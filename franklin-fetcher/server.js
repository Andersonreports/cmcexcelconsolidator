/**
 * Franklin + ClinVar Fetcher – Local Server
 * ------------------------------------------
 * HTTP server on localhost:3001 with two capabilities:
 *
 *  POST /batch          – Franklin classification via Playwright (real browser)
 *  POST /clinvar-batch  – ClinVar lookup:
 *                          1. local clinvar_chr.vcf.gz via tabix (by coordinates)
 *                          2. Ensembl VEP  (server-side, no CORS) → get coordinates → tabix
 *                          3. NCBI eutils  (fallback for anything not in the local VCF)
 *  GET  /status         – health-check
 *
 * Start:  double-click  start-server.bat
 */

'use strict';

const http     = require('http');
const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const { chromium } = require('playwright');

const PORT          = 3001;
const FRANKLIN_HOME = 'https://franklin.genoox.com/clinical-db/home';

// ClinVar VCF lives one directory above this script (repo root)
const VCF_PATH = path.join(__dirname, '..', 'clinvar_chr.vcf.gz');
const TBI_PATH = path.join(__dirname, '..', 'clinvar_chr.vcf.gz.tbi');

// ── HTTPS utility ────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'CMC-Consolidator/2.0 (Node.js)',
      },
    }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode === 429 || res.statusCode === 503) {
          return reject(new Error('rate-limited'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(new Error('timeout')); });
  });
}

// ── ClinVar significance helpers ─────────────────────────────────────────────

function parseClinSig(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/_/g, ' ').toLowerCase().trim();
  if (s === 'pathogenic')                            return 'P';
  if (s === 'likely pathogenic')                     return 'LP';
  if (s === 'pathogenic/likely pathogenic' ||
      s === 'likely pathogenic/pathogenic')          return 'LP';
  if (s.includes('uncertain significance'))          return 'VUS';
  if (s === 'likely benign')                         return 'LB';
  if (s === 'benign/likely benign' ||
      s === 'likely benign/benign')                  return 'LB';
  if (s === 'benign')                                return 'B';
  if (s.includes('conflicting'))                     return 'Conflicting';
  // For anything else return a cleaned-up version so the cell still has a value
  return String(raw).replace(/_/g, ' ');
}

// ── Local ClinVar VCF (tabix) ─────────────────────────────────────────────────

let vcfReader   = null;
let vcfReady    = null; // null=unknown, true/false

async function initVcf() {
  if (vcfReady === false) return null;
  if (vcfReader)          return vcfReader;
  if (!fs.existsSync(VCF_PATH) || !fs.existsSync(TBI_PATH)) {
    vcfReady = false;
    console.log('  ClinVar VCF not found at ' + VCF_PATH + ' – will use NCBI eutils fallback.');
    return null;
  }
  try {
    const { TabixIndexedFile } = require('@gmod/tabix');
    const { LocalFile }        = require('generic-filehandle');
    vcfReader = new TabixIndexedFile({
      filehandle:    new LocalFile(VCF_PATH),
      tbiFilehandle: new LocalFile(TBI_PATH),
    });
    vcfReady = true;
    console.log('  ClinVar VCF ready ✓  (' + VCF_PATH + ')');
    return vcfReader;
  } catch (err) {
    vcfReady = false;
    console.error('  ClinVar VCF init error:', err.message);
    return null;
  }
}

function parseVcfInfo(infoStr) {
  const out = {};
  infoStr.split(';').forEach(function (part) {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  });
  return out;
}

// Query the local VCF by genomic coordinates (chr may or may not have "chr" prefix).
async function lookupVcfByCoords(chrRaw, posRaw, ref, alt) {
  const reader = await initVcf();
  if (!reader) return null;

  // ClinVar chr-prefixed VCF: ensure 'chr' prefix
  const chr   = String(chrRaw).startsWith('chr') ? String(chrRaw) : 'chr' + String(chrRaw);
  const pos   = parseInt(posRaw, 10);
  if (!chr || isNaN(pos) || !ref || !alt) return null;

  try {
    const lines = [];
    // getLines(refName, start0based, end0based) – half-open interval
    await reader.getLines(chr, pos - 1, pos + String(ref).length, function (line) {
      if (!line.startsWith('#')) lines.push(line);
    });

    for (const line of lines) {
      const f = line.split('\t');
      if (f.length < 8) continue;
      if (parseInt(f[1], 10) !== pos) continue;
      if (f[3].toUpperCase() !== String(ref).toUpperCase()) continue;
      // Multi-allelic ALTs are comma-separated
      const alts = f[4].split(',');
      if (!alts.some(function (a) { return a.toUpperCase() === String(alt).toUpperCase(); })) continue;

      const info = parseVcfInfo(f[7]);
      const sig  = parseClinSig(info.CLNSIG);
      const id   = f[2]; // ClinVar variation ID is in the ID column
      return {
        id:           id,
        significance: sig,
        url:          'https://www.ncbi.nlm.nih.gov/clinvar/variation/' + id + '/',
      };
    }
    return null;
  } catch (err) {
    console.error('  VCF lookup error [' + chr + ':' + pos + ']:', err.message);
    return null;
  }
}

// ── Ensembl VEP (server-side, no CORS) ───────────────────────────────────────

async function vepGetCoords(gene, variant) {
  if (!gene || !variant) return null;
  const hgvs = encodeURIComponent(gene + ':' + variant);
  const url  = 'https://rest.ensembl.org/vep/human/hgvs/' + hgvs +
               '?content-type=application/json&canonical=1';
  try {
    const data = await httpsGet(url);
    if (!Array.isArray(data) || !data[0]) return null;
    const hit    = data[0];
    const alleles = String(hit.allele_string || '').split('/');
    return {
      chr: hit.seq_region_name,
      pos: hit.start,
      ref: alleles[0] || '',
      alt: alleles[1] || '',
    };
  } catch {
    return null;
  }
}

// ── NCBI eutils ClinVar (fallback) ───────────────────────────────────────────

async function ncbiClinVarLookup(gene, variant) {
  if (!gene || !variant) return null;
  // Also try normalised form: c.649delC → c.649del
  const norm  = variant.replace(/del[ACGT]+$/i, 'del').replace(/ins[ACGT]+$/i, 'ins');
  const termA = '(' + gene + '[gene] AND "' + variant + '"[All Fields])';
  const termB = norm !== variant
    ? ' OR (' + gene + '[gene] AND "' + norm + '"[All Fields])'
    : '';
  const searchUrl =
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi' +
    '?db=clinvar&term=' + encodeURIComponent(termA + termB) +
    '&retmax=3&retmode=json';
  try {
    const searchData = await httpsGet(searchUrl);
    const ids = (searchData.esearchresult && searchData.esearchresult.idlist) || [];
    if (!ids.length) return null;

    const uid = ids[0];
    const summaryUrl =
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi' +
      '?db=clinvar&id=' + uid + '&retmode=json';
    const sumData = await httpsGet(summaryUrl);
    const doc = sumData.result && sumData.result[uid];
    const sigText =
      (doc && doc.clinical_significance && doc.clinical_significance.description) ||
      (doc && doc.description) || '';

    return {
      id:           uid,
      significance: parseClinSig(sigText),
      url:          'https://www.ncbi.nlm.nih.gov/clinvar/variation/' + uid + '/',
    };
  } catch (err) {
    console.error('  NCBI eutils error:', err.message);
    return null;
  }
}

// Orchestrate all three methods for one variant.
async function fetchClinVarForVariant(v) {
  // 1. Coordinates provided → try local VCF directly
  if (v.chr && v.pos && v.ref && v.alt) {
    const hit = await lookupVcfByCoords(v.chr, v.pos, v.ref, v.alt);
    if (hit) { console.log('    [VCF] found'); return hit; }
  }

  // 2. Gene + variant → VEP → get coords → try local VCF
  if (v.gene && v.variant) {
    const coords = await vepGetCoords(v.gene, v.variant);
    if (coords && coords.chr && coords.pos && coords.ref && coords.alt) {
      const hit = await lookupVcfByCoords(coords.chr, coords.pos, coords.ref, coords.alt);
      if (hit) { console.log('    [VEP→VCF] found'); return hit; }
    }
  }

  // 3. NCBI eutils text search
  if (v.gene && v.variant) {
    const hit = await ncbiClinVarLookup(v.gene, v.variant);
    if (hit) { console.log('    [eutils] found'); return hit; }
  }

  return null;
}

// ── Franklin helpers (unchanged) ──────────────────────────────────────────────

function abbreviate(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/_/g, ' ').trim();
  if (t === 'pathogenic')                                  return 'P';
  if (t === 'likely pathogenic')                           return 'LP';
  if (t === 'pathogenic/likely pathogenic')                return 'LP';
  if (t.includes('uncertain significance') || t === 'vus') return 'VUS';
  if (t === 'likely benign')                               return 'LB';
  if (t === 'benign/likely benign')                        return 'LB';
  if (t === 'benign')                                      return 'B';
  if (t.includes('conflicting'))                           return 'Conflicting';
  return null;
}

function findClassInJson(obj, depth) {
  depth = depth || 0;
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  const keys = [
    'classification','suggestedClassification','suggested_classification',
    'acmg_classification','pathogenicity','clinicalSignificance',
    'variant_classification','acmg_class','suggested_pathogenicity',
  ];
  for (let i = 0; i < keys.length; i++) {
    const val = obj[keys[i]];
    if (!val) continue;
    if (typeof val === 'string') { const a = abbreviate(val); if (a) return a; }
    if (typeof val === 'object') {
      const inner = String(val.label || val.name || val.description || val.value || '');
      if (inner) { const a = abbreviate(inner); if (a) return a; }
    }
  }
  const entries = Object.values(obj);
  for (let j = 0; j < entries.length; j++) {
    if (entries[j] && typeof entries[j] === 'object') {
      const r = findClassInJson(entries[j], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ── Browser (single persistent Playwright instance) ───────────────────────────

let browser = null;
let page    = null;

async function ensureBrowser() {
  if (browser && page) return;
  console.log('Launching browser...');
  browser = await chromium.launch({
    headless: false, slowMo: 60,
    args: ['--window-size=1280,900'],
  });
  const ctx = await browser.newContext({
    viewport:  { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  page = await ctx.newPage();
  await page.goto(FRANKLIN_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  console.log('Browser ready ✓');
}

async function getClassification(gene, variant) {
  const query = [gene, variant].filter(Boolean).join(' ').trim();
  if (!query) return null;
  let captured = null;

  const onResp = async (response) => {
    if (captured) return;
    try {
      if (!response.url().includes('genoox.com')) return;
      if (response.status() !== 200) return;
      if (!(response.headers()['content-type'] || '').includes('json')) return;
      const json = await response.json();
      const found = findClassInJson(json);
      if (found) captured = found;
    } catch (_) {}
  };
  page.on('response', onResp);

  try {
    await page.goto(FRANKLIN_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const searchSel = [
      'input[placeholder*="Search" i]',
      'input[type="search"]',
      '[class*="search" i] input',
      'header input',
    ].join(',');
    const input = await page.waitForSelector(searchSel, { timeout: 10000 });
    await input.click({ clickCount: 3 });
    await input.fill(query);
    await page.waitForTimeout(700);

    const suggestion = page.locator(
      '[class*="autocomplete" i] li:first-child,' +
      '[class*="dropdown" i] a:first-child,' +
      '[role="option"]:first-child,' +
      '[class*="suggestion" i]:first-child'
    ).first();
    const hasSuggestion = await suggestion.count() > 0;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      hasSuggestion ? suggestion.click() : input.press('Enter'),
    ]);

    if (!page.url().includes('/variant/')) {
      const link = page.locator('a[href*="/variant/"]').first();
      if (await link.count() > 0) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
          link.click(),
        ]);
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    if (captured) { page.off('response', onResp); return captured; }

    const fromDom = await page.evaluate(function () {
      const body = (document.body && document.body.innerText) || '';
      const m = body.match(
        /Suggested\s+Classification[\s\S]{0,400}?(Pathogenic|Likely\s+pathogenic|Uncertain\s+significance|Likely\s+benign|Benign)\b/i
      );
      return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    });
    page.off('response', onResp);
    return fromDom ? (abbreviate(fromDom) || fromDom) : null;
  } catch (err) {
    page.off('response', onResp);
    console.error('  Franklin error:', err.message);
    return null;
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /status
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, vcfReady: vcfReady === true }));
    return;
  }

  // Read JSON body helper
  function readBody(cb) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      try { cb(null, JSON.parse(body)); }
      catch (e) { cb(e); }
    });
  }

  // POST /batch  – Franklin classification
  if (req.method === 'POST' && req.url === '/batch') {
    readBody(async function (err, parsed) {
      if (err || !Array.isArray(parsed && parsed.variants)) {
        res.writeHead(400); res.end('Bad JSON or missing variants[]'); return;
      }
      try {
        await ensureBrowser();
        const results = [];
        for (const { gene, variant, rowIdx } of parsed.variants) {
          process.stdout.write('  [Franklin] ' + gene + ' ' + variant + ' → ');
          const cls = await getClassification(gene, variant);
          console.log(cls || '(not found)');
          results.push({ rowIdx, classification: cls || null });
          await page.waitForTimeout(400);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err2) {
        res.writeHead(500); res.end(err2.message);
      }
    });
    return;
  }

  // POST /clinvar-batch  – ClinVar lookup (VCF → VEP → eutils)
  if (req.method === 'POST' && req.url === '/clinvar-batch') {
    readBody(async function (err, parsed) {
      if (err || !Array.isArray(parsed && parsed.variants)) {
        res.writeHead(400); res.end('Bad JSON or missing variants[]'); return;
      }
      try {
        const results = [];
        for (const v of parsed.variants) {
          process.stdout.write(
            '  [ClinVar] ' + (v.gene || '') + ' ' + (v.variant || '') + ' → '
          );
          const hit = await fetchClinVarForVariant(v);
          if (hit) {
            console.log((hit.significance || '?') + '  ' + hit.url);
          } else {
            console.log('(not found)');
          }
          results.push({
            rowIdx:       v.rowIdx,
            id:           hit ? hit.id           : null,
            significance: hit ? hit.significance : null,
            url:          hit ? hit.url          : null,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err2) {
        res.writeHead(500); res.end(err2.message);
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', async function () {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   CMC Fetcher Server  – port 3001        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Franklin auto-fill  →  POST /batch      ║');
  console.log('║  ClinVar lookup      →  POST /clinvar-batch');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Keep this window open while using CMC.  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  // Pre-init VCF reader so first request is fast
  await initVcf();
});
