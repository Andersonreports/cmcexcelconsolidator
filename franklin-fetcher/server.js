/**
 * Franklin Fetcher – Local Server
 * --------------------------------
 * Runs a tiny HTTP server on localhost:3001.
 * The CMC web app posts gene+variant pairs here; this server opens Franklin
 * in a real browser (no CORS restrictions) and returns the classification.
 *
 * Start:  double-click  start-server.bat
 * Keep the window open while using the web app.
 */

'use strict';

const http       = require('http');
const { chromium } = require('playwright');

const PORT         = 3001;
const FRANKLIN_HOME = 'https://franklin.genoox.com/clinical-db/home';

// ── Classification helpers ──────────────────────────────────────────────────

function abbreviate(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/_/g, ' ').trim();
  if (t === 'pathogenic')                                 return 'P';
  if (t === 'likely pathogenic')                          return 'LP';
  if (t === 'pathogenic/likely pathogenic')               return 'LP';
  if (t.includes('uncertain significance') || t === 'vus') return 'VUS';
  if (t === 'likely benign')                              return 'LB';
  if (t === 'benign/likely benign')                       return 'LB';
  if (t === 'benign')                                     return 'B';
  if (t.includes('conflicting'))                          return 'Conflicting';
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

// ── Browser (single persistent instance) ───────────────────────────────────

let browser = null;
let page    = null;

async function ensureBrowser() {
  if (browser && page) return;
  console.log('Launching browser...');
  browser = await chromium.launch({
    headless: false,
    slowMo: 60,
    args: ['--window-size=1280,900'],
  });
  const ctx = await browser.newContext({
    viewport:  { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  page = await ctx.newPage();
  // Pre-warm: load Franklin home once so future navigations are faster
  await page.goto(FRANKLIN_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  console.log('Browser ready ✓');
}

// ── Franklin search ─────────────────────────────────────────────────────────

async function fetchClassification(gene, variant) {
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

    // Fill the search box
    const searchSel = [
      'input[placeholder*="Search" i]',
      'input[type="search"]',
      '[class*="search" i] input',
      'header input',
    ].join(',');
    const input = await page.waitForSelector(searchSel, { timeout: 10000 });
    await input.click({ clickCount: 3 });
    await input.fill(query);

    // Wait briefly for autocomplete to appear
    await page.waitForTimeout(700);

    // Click first autocomplete suggestion if visible, else press Enter
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

    // If we're on a search results page (not a direct variant page), click first result
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

    // DOM fallback – scan page text for "Suggested Classification … <term>"
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
    console.error('  Error:', err.message);
    return null;
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS – allow the web app (any origin) to call us
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /status – health check (web app uses this to detect if server is running)
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /batch – main endpoint
  if (req.method === 'POST' && req.url === '/batch') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let variants;
      try { ({ variants } = JSON.parse(body)); }
      catch (_) { res.writeHead(400); res.end('Bad JSON'); return; }

      if (!Array.isArray(variants) || !variants.length) {
        res.writeHead(400); res.end('variants[] required'); return;
      }

      try {
        await ensureBrowser();
        const results = [];
        for (const { gene, variant, rowIdx } of variants) {
          process.stdout.write(`  [${gene} ${variant}] → `);
          const cls = await fetchClassification(gene, variant);
          console.log(cls || '(not found)');
          results.push({ rowIdx, classification: cls || null });
          await page.waitForTimeout(400);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        res.writeHead(500); res.end(err.message);
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Franklin Fetcher Server  – port 3001   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Keep this window open.                  ║');
  console.log('║  Open CMC Excel Consolidator normally.   ║');
  console.log('║  Franklin values will auto-fill when     ║');
  console.log('║  you upload a VarSeq file.               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
