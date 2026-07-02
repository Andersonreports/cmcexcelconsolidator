/**
 * Franklin (Genoox) classification relay — deploy as a Google Apps Script Web App.
 *
 * Why this exists: franklin.genoox.com's search/classify APIs are public and need no
 * login, but they send no CORS headers, so a browser on GitHub Pages can't call them
 * directly. This script runs server-side (no CORS problem there), always forces the
 * hg38 assembly, and hands back just the classification.
 *
 * Deploy:
 *   1. https://script.google.com/  → New project → paste this file over Code.gs.
 *   2. Deploy → New deployment → type "Web app".
 *      Execute as: Me.  Who has access: Anyone.
 *   3. Copy the /exec URL into FRANKLIN_PROXY_URL in index.html.
 *
 * Usage from the browser:
 *   GET <exec-url>?gene=BRCA1&variant=c.68_69delAG
 *   → { ok:true, classification:"Pathogenic", abbr:"P",
 *       chrom:"17", pos:43124027, ref:"ACT", alt:"A" }
 */

var FRANKLIN_BASE = 'https://franklin.genoox.com';
var CACHE_SECONDS = 21600; // 6h — same gene+variant is asked by many users

function doGet(e) {
  var gene    = String((e.parameter && e.parameter.gene)    || '').trim();
  var variant = String((e.parameter && e.parameter.variant) || '').trim();
  var query   = [gene, variant].filter(Boolean).join(' ').trim();

  if (!query) return respond({ ok: false, error: 'gene and/or variant required' });

  var cache    = CacheService.getScriptCache();
  var cacheKey = 'fr:' + query.toLowerCase();
  var cached   = cache.get(cacheKey);
  if (cached) return respond(JSON.parse(cached));

  var result = lookupClassification(query);
  if (result.ok) cache.put(cacheKey, JSON.stringify(result), CACHE_SECONDS);
  return respond(result);
}

function lookupClassification(query) {
  try {
    var parsed = postJson(FRANKLIN_BASE + '/api/parse_search', {
      search_text_input: query,
      case_context: {
        phenotypes: [], ethnicity: [], consanguinity: null,
        family_inheritance_status: null, reported_classification: null,
        sex: null, search_term: query,
      },
      roh_allowed: true,
      reference_version: 'hg38',
    });

    if (parsed.response_type !== 'SNP_VARIANT' || !parsed.best_variant_option) {
      return { ok: false, error: 'no variant match (' + (parsed.response_type || 'unknown') + ')' };
    }

    var v     = parsed.best_variant_option;
    var chrom = String(v.chrom || '').replace(/^chr/i, '');

    var classified = postJson(FRANKLIN_BASE + '/api/classify', {
      variant: {
        chrom: chrom,
        pos: v.pos,
        ref: v.ref,
        alt: v.alt,
        reference_version: 'hg38',
      },
      is_versioned_request: false,
    });

    if (!classified.classification) {
      return { ok: false, error: 'no classification returned' };
    }

    return {
      ok: true,
      classification: classified.classification,
      abbr: abbreviate(classified.classification),
      gene: classified.gene || null,
      chrom: chrom,
      pos: v.pos,
      ref: v.ref,
      alt: v.alt,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function postJson(url, bodyObj) {
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(bodyObj),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('HTTP ' + res.getResponseCode() + ' from ' + url);
  }
  return JSON.parse(res.getContentText());
}

function abbreviate(text) {
  var t = String(text || '').toLowerCase().replace(/_/g, ' ').trim();
  if (t === 'pathogenic')                                    return 'P';
  if (t === 'likely pathogenic')                             return 'LP';
  if (t === 'pathogenic/likely pathogenic')                  return 'LP';
  if (t.indexOf('uncertain significance') !== -1)            return 'VUS';
  if (t === 'likely benign')                                 return 'LB';
  if (t === 'benign/likely benign')                          return 'LB';
  if (t === 'benign')                                        return 'B';
  if (t.indexOf('conflicting') !== -1)                       return 'Conflicting';
  return null;
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
