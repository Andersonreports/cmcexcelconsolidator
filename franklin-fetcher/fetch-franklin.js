/**
 * Franklin Classification Fetcher
 * --------------------------------
 * Reads Listed Variant Excel files, opens Franklin in a real browser for each
 * gene+variant, extracts the "Suggested Classification", and writes it back.
 *
 * Setup (one time):
 *   npm run setup
 *
 * Usage:
 *   node fetch-franklin.js file1.xlsx file2.xlsx ...
 *   node fetch-franklin.js          ← processes all .xlsx in the current folder
 */

'use strict';

const { chromium } = require('playwright');
const ExcelJS      = require('exceljs');
const path         = require('path');
const fs           = require('fs');

const FRANKLIN_HOME = 'https://franklin.genoox.com/clinical-db/home';

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function abbreviate(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/_/g, ' ').trim();
  if (t === 'pathogenic')                           return 'P';
  if (t === 'likely pathogenic')                    return 'LP';
  if (t === 'pathogenic/likely pathogenic')         return 'LP';
  if (t.includes('uncertain significance'))         return 'VUS';
  if (t === 'likely benign')                        return 'LB';
  if (t === 'benign/likely benign')                 return 'LB';
  if (t === 'benign')                               return 'B';
  if (t.includes('conflicting'))                    return 'Conflicting';
  return null;
}

// Walk a JSON object recursively looking for a classification value.
function findClassInJson(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || !obj || typeof obj !== 'object') return null;

  const classKeys = [
    'classification', 'suggestedClassification', 'suggested_classification',
    'acmg_classification', 'pathogenicity', 'clinicalSignificance',
    'variant_classification', 'acmg_class', 'suggested_pathogenicity',
    'classification_suggestion', 'final_classification',
  ];

  for (var i = 0; i < classKeys.length; i++) {
    var val = obj[classKeys[i]];
    if (val == null) continue;
    if (typeof val === 'string') {
      var a = abbreviate(val);
      if (a) return a;
    }
    if (typeof val === 'object') {
      var inner = String(val.label || val.name || val.description || val.value || val.text || '');
      if (inner) { var a2 = abbreviate(inner); if (a2) return a2; }
    }
  }

  var entries = Object.values(obj);
  for (var j = 0; j < entries.length; j++) {
    if (entries[j] && typeof entries[j] === 'object') {
      var r = findClassInJson(entries[j], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core fetch: navigate Franklin, search gene+variant, return abbreviated class
// ---------------------------------------------------------------------------

async function getClassification(page, gene, variant) {
  const query = [gene, variant].filter(Boolean).join(' ').trim();
  if (!query) return null;

  let captured = null;

  // --- Layer 1: intercept Franklin's internal API JSON responses ---
  const onResponse = async (response) => {
    if (captured) return;
    try {
      const url = response.url();
      if (!url.includes('genoox.com') && !url.includes('franklin')) return;
      if (response.status() !== 200) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await response.json();
      const found = findClassInJson(json);
      if (found) captured = found;
    } catch (_) {}
  };
  page.on('response', onResponse);

  try {
    // Navigate to Franklin home
    await page.goto(FRANKLIN_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Find the search input
    const searchSel = [
      'input[placeholder*="Search" i]',
      'input[type="search"]',
      '[class*="search" i] input',
      'header input',
      'nav input',
    ].join(', ');
    const searchInput = await page.waitForSelector(searchSel, { timeout: 10000 });

    // Type the query and submit
    await searchInput.click({ clickCount: 3 });
    await searchInput.fill(query);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      searchInput.press('Enter'),
    ]);

    // If we landed on a search-results page (not a variant page), click the first result
    const currentUrl = page.url();
    const isVariantPage = currentUrl.includes('/variant/snp/') || currentUrl.includes('/variant/indel/');

    if (!isVariantPage) {
      try {
        // Look for a result link pointing to a specific variant page
        const resultLink = page.locator(
          'a[href*="/variant/snp/"], a[href*="/variant/indel/"], a[href*="/clinical-db/variant"]'
        ).first();
        if (await resultLink.count() > 0) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
            resultLink.click(),
          ]);
        }
      } catch (_) {}
    }

    // Wait for the variant page to fully load (API calls finish)
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Return API-intercepted result if found
    if (captured) {
      page.off('response', onResponse);
      return captured;
    }

    // --- Layer 2: DOM text scan for "Suggested Classification" ---
    const fromDom = await page.evaluate(function () {
      const body = document.body ? (document.body.innerText || '') : '';
      const terms = ['Pathogenic', 'Likely pathogenic', 'Uncertain significance', 'Likely benign', 'Benign'];

      // Search for "Suggested Classification" then the nearest term after it
      const m = body.match(
        /Suggested\s+Classification[\s\S]{0,300}?(Pathogenic|Likely\s+pathogenic|Uncertain\s+significance|Likely\s+benign|Benign)\b/i
      );
      if (m) return m[1].replace(/\s+/g, ' ').trim();

      // Count occurrences — the classification shown on the page appears 2–4 times
      // (in the gauge label, heading, evidence section, etc.)
      var best = null, bestCount = 1;
      for (var i = 0; i < terms.length; i++) {
        var re = new RegExp('\\b' + terms[i].replace(/\s/g, '\\s+') + '\\b', 'gi');
        var count = (body.match(re) || []).length;
        if (count > bestCount) { best = terms[i]; bestCount = count; }
      }
      return best;
    });

    page.off('response', onResponse);
    if (fromDom) return abbreviate(fromDom) || fromDom;
    return null;

  } catch (err) {
    page.off('response', onResponse);
    console.error('    Error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Excel processing
// ---------------------------------------------------------------------------

async function processFile(filePath, page) {
  console.log('\n──────────────────────────────────────');
  console.log('File: ' + path.basename(filePath));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) { console.log('  No worksheet — skipping.'); return; }

  // Find the header row (the one that contains "GENE")
  let headerRowNum = 1;
  outer:
  for (let r = 1; r <= Math.min(sheet.rowCount, 6); r++) {
    const rowObj = sheet.getRow(r);
    for (let c = 1; c <= Math.min(sheet.columnCount, 30); c++) {
      if (String(rowObj.getCell(c).value || '').toUpperCase().trim() === 'GENE') {
        headerRowNum = r;
        break outer;
      }
    }
  }

  // Identify column indices from header
  const hRow = sheet.getRow(headerRowNum);
  let geneCol = null, variantCol = null, franklinCol = null;

  for (let c = 1; c <= sheet.columnCount; c++) {
    const h = String(hRow.getCell(c).value || '').toUpperCase().trim();
    if (h === 'GENE')                                          geneCol     = c;
    if (h === 'VARIANT')                                       variantCol  = c;
    if (h === 'FRANKLIN' || h === 'FRA CLASS' || h.startsWith('FRANK')) franklinCol = c;
  }

  if (!geneCol || !variantCol) {
    console.log('  Cannot find GENE/VARIANT columns — skipping.');
    return;
  }
  if (!franklinCol) {
    console.log('  Cannot find FRANKLIN column — skipping.');
    return;
  }

  console.log('  Header row: ' + headerRowNum +
              '  |  GENE:' + geneCol +
              '  VARIANT:' + variantCol +
              '  FRANKLIN:' + franklinCol);

  let processed = 0, filled = 0;
  const dataStart = headerRowNum + 1;

  for (let r = dataStart; r <= sheet.rowCount; r++) {
    const row     = sheet.getRow(r);
    const gene    = String(row.getCell(geneCol).value    || '').trim();
    const variant = String(row.getCell(variantCol).value || '').trim();
    const existing = String(row.getCell(franklinCol).value || '').trim();

    if (!gene && !variant) continue;
    processed++;

    if (existing) {
      console.log('  [row ' + r + '] ' + gene + ' ' + variant + ' → already "' + existing + '"');
      continue;
    }

    process.stdout.write('  [row ' + r + '] ' + gene + ' ' + variant + ' → ');

    const cls = await getClassification(page, gene, variant);

    if (cls) {
      row.getCell(franklinCol).value = cls;
      row.commit();
      filled++;
      console.log(cls);
    } else {
      console.log('(not found)');
    }

    // Brief pause between searches to avoid hammering the server
    await page.waitForTimeout(600);
  }

  // Save in place
  await wb.xlsx.writeFile(filePath);
  console.log('\n  ✓ ' + filled + '/' + processed + ' rows filled → saved to ' + path.basename(filePath));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let files = process.argv.slice(2).map(f => path.resolve(f));

  if (!files.length) {
    // Auto-discover xlsx files in the current working directory
    files = fs.readdirSync(process.cwd())
      .filter(function (f) { return /\.(xlsx|xls)$/i.test(f) && !f.startsWith('~$'); })
      .map(function (f) { return path.resolve(process.cwd(), f); });
  }

  if (!files.length) {
    console.log('No Excel files found.');
    console.log('');
    console.log('Usage:');
    console.log('  node fetch-franklin.js file1.xlsx file2.xlsx');
    console.log('  node fetch-franklin.js   ← auto-finds all .xlsx in this folder');
    process.exit(0);
  }

  console.log('Franklin Classification Fetcher');
  console.log('================================');
  console.log('Files to process:');
  files.forEach(function (f) { console.log('  • ' + path.basename(f)); });
  console.log('');

  // Launch a real (visible) browser — the user can watch it work
  const browser = await chromium.launch({
    headless: false,
    slowMo: 80,
    args: ['--start-maximized'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    for (const f of files) {
      if (!fs.existsSync(f)) {
        console.log('\nSkipping (file not found): ' + f);
        continue;
      }
      await processFile(f, page);
    }
  } finally {
    await browser.close();
  }

  console.log('\n══════════════════════════════════════');
  console.log('All done!');
}

main().catch(function (err) {
  console.error('\nFatal error:', err);
  process.exit(1);
});
