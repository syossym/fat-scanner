/**
 * Nutrition Label Fat Content Parser (g per 100g)
 *
 * Supports:
 * - Spatial word-level row reconstruction (handles multi-column tables split by OCR)
 * - Direct per-100g / per-100ml tables (EU, UK, AU, Intl — both 100g-first and serving-first)
 * - Per-serving labels (US/CA Nutrition Facts) with automatic conversion to g / 100g
 * - Multi-language Latin labels (EN, DE, FR, ES, IT, PT, NL, DA/SV/NO, PL, FI, CS)
 * - Strict exclusion of Saturated / Trans / Mono / Poly / Calories-from-Fat rows
 */

const TOTAL_FAT_PATTERNS = [
  /\btotal\s+fat\b/i,
  /\btotal\s+lipids?\b/i,
  /\bfat\s*\(g\)/i,
  /\bfats?\b/i,
  /\bfett\b/i,
  /\bmati[eè]res?\s+grasses?\b/i,
  /\blipides?\b/i,
  /\bgrasas?\s+totales?\b/i,
  /\bgrasa\s+total\b/i,
  /\bgrasas?\b/i,
  /\bgrassi\b/i,
  /\bgorduras?\s+totais?\b/i,
  /\bgorduras?\b/i,
  /\bl[ií]pidos?\b/i,
  /\bvetten\b/i,
  /\bvet\b/i,
  /\bfedt\b/i,
  /\brasva\b/i,
  /\bt[lł]uszcz\b/i,
  /\btuky\b/i,
];

const SUB_FAT_EXCLUDE_PATTERNS = [
  /\bsaturat/i,
  /\bsat\.?\s*fat\b/i,
  /\bof\s+which\s+sat/i,
  /\bwhich\s+saturat/i,
  /\btrans\b/i,
  /\bmono[-\s]?unsat/i,
  /\bpoly[-\s]?unsat/i,
  /\bunsaturat/i,
  /\bges[aä]ttigt/i,
  /\bunges[aä]ttigt/i,
  /\bsatur[eé]s?\b/i,
  /\bdont\s+acides?\b/i,
  /\bsaturadas?\b/i,
  /\bsaturati\b/i,
  /\bverzadigd/i,
  /\bnasycon/i,
  /\bm[aä]ttat\b/i,
  /\bm[æa]ttede\b/i,
  /\btyydyttyne/i,
  /\bcalories?\s+from\s+fat\b/i,
  /\benergy\s+from\s+fat\b/i,
  /\bkcal\s+from\s+fat\b/i,
  /\bfat[-\s]?free\b/i,
  /\blow[-\s]?fat\b/i,
  /\breduced[-\s]?fat\b/i,
  /\bnon[-\s]?fat\b/i,
  /\bless\s+fat\b/i,
  /\b%?\s*daily\s+value/i,
  /\bcholesterol\b/i,
  /\bomega\b/i,
  /\bsodium\b/i,
  /\bcarbohydrate/i,
  /\bprotein\b/i,
  /\bfib(?:re|er)\b/i,
  /\bsugars?\b/i,
  /\bsalt\b/i,
];

const SATURATED_FAT_PATTERNS = [
  /\bsaturated\s+fat\b/i,
  /\bof\s+which\s+saturates?\b/i,
  /\bsaturates?\b/i,
  /\bsat\.?\s*fat\b/i,
  /\bges[aä]ttigte\s+fetts[aä]uren\b/i,
  /\bdont\s+acides?\s+gras\s+satur[eé]s?\b/i,
  /\bde\s+las\s+cuales\s+saturadas\b/i,
  /\bdi\s+cui\s+acidi\s+grassi\s+saturi\b/i,
  /\bwaarvan\s+verzadigde\b/i,
];

/**
 * Clean common OCR artifacts inside numeric segments while preserving structure.
 */
export function normalizeOcrText(raw) {
  if (!raw) return '';
  let text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"');

  // Fix "1OOg" or "1O0g" -> "100g"
  text = text.replace(/\b1[Oo0]{2}\s*(g|gr|gm|ml)\b/gi, '100$1');
  // Fix "per 1009" / "per 100q" -> "per 100g"
  text = text.replace(/\b(per|pro|par|por|je|\/)\s*100\s*[9q]\b/gi, '$1 100g');
  // Fix "O.5g" or "o,5 g" -> "0.5g"
  text = text.replace(/(^|[\s:(<])[Oo]([.,]\d+\s*(?:g|gr|gm|mg|ml)?\b)/g, '$10$2');
  // Fix standalone "Og" -> "0g" after fat keywords or spaces
  text = text.replace(/(\s)[Oo]\s*g\b/g, '$10g');
  // Fix "l2.5g" or "I2g" -> "12.5g" / "12g" when clearly a digit before number+g
  text = text.replace(/(\s)[lI](\d(?:[.,]\d+)?\s*g\b)/g, '$11$2');
  // Fix spaced decimals like "14 . 5 g" or "0 , 4g"
  text = text.replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3');

  return text;
}

/**
 * Extract spatial words from a Tesseract.js v5/v6 result object (or TSV string).
 * Returns an array of { text, x0, y0, x1, y1, conf }.
 */
export function extractWordsFromOcr(ocrData) {
  if (!ocrData) return [];

  // 1. Direct words array (Tesseract.js v4/v5)
  if (Array.isArray(ocrData.words) && ocrData.words.length > 0) {
    return ocrData.words
      .filter((w) => w && w.text && w.text.trim() && w.bbox)
      .map((w) => ({
        text: w.text.trim(),
        x0: w.bbox.x0,
        y0: w.bbox.y0,
        x1: w.bbox.x1,
        y1: w.bbox.y1,
        conf: typeof w.confidence === 'number' ? w.confidence : 80,
      }));
  }

  // 2. Nested blocks -> paragraphs -> lines -> words (Tesseract.js v5/v6 with blocks:true)
  if (Array.isArray(ocrData.blocks) && ocrData.blocks.length > 0) {
    const words = [];
    for (const block of ocrData.blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const w of line.words || []) {
            if (w && w.text && w.text.trim() && w.bbox) {
              words.push({
                text: w.text.trim(),
                x0: w.bbox.x0,
                y0: w.bbox.y0,
                x1: w.bbox.x1,
                y1: w.bbox.y1,
                conf: typeof w.confidence === 'number' ? w.confidence : 80,
              });
            }
          }
        }
      }
    }
    if (words.length > 0) return words;
  }

  // 3. TSV string fallback (works with both Tesseract.js tsv output and CLI `tesseract --tsv`)
  if (typeof ocrData.tsv === 'string' && ocrData.tsv.trim()) {
    return parseTsvWords(ocrData.tsv);
  }

  return [];
}

/**
 * Parse standard Tesseract TSV output into spatial words.
 */
export function parseTsvWords(tsvString) {
  const words = [];
  const lines = tsvString.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) continue;
    // Skip header
    if (cols[0] === 'level') continue;
    const level = Number(cols[0]);
    const text = cols.slice(11).join('\t').trim();
    if (level !== 5 || !text) continue;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const conf = Number(cols[10]);
    if (Number.isNaN(left) || Number.isNaN(top) || width <= 0 || height <= 0) continue;
    words.push({
      text,
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
      conf: Number.isNaN(conf) ? 80 : conf,
    });
  }
  return words;
}

/**
 * Group spatial words into horizontal visual rows, rescuing tables where OCR
 * broke the label column and values column into separate blocks.
 */
export function buildSpatialRows(words) {
  if (!words || words.length === 0) return [];

  // Filter out extreme noise specks (very low confidence single punctuation)
  const cleanWords = words.filter((w) => {
    if (w.conf < 15 && w.text.length <= 1 && !/\d/.test(w.text)) return false;
    return true;
  });
  if (cleanWords.length === 0) return [];

  const heights = cleanWords
    .map((w) => Math.max(4, w.y1 - w.y0))
    .sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;

  // Sort top-to-bottom by vertical midpoint
  const sorted = [...cleanWords].sort((a, b) => {
    const ya = (a.y0 + a.y1) / 2;
    const yb = (b.y0 + b.y1) / 2;
    return ya - yb;
  });

  const rows = [];
  for (const w of sorted) {
    const wMid = (w.y0 + w.y1) / 2;
    const wH = Math.max(4, w.y1 - w.y0);

    let bestRow = null;
    let bestDist = Infinity;

    for (const row of rows) {
      const tolerance = Math.max(medianHeight * 0.55, Math.min(wH, row.avgHeight) * 0.65);
      const dist = Math.abs(wMid - row.yMid);
      if (dist <= tolerance && dist < bestDist) {
        bestDist = dist;
        bestRow = row;
      }
    }

    if (bestRow) {
      bestRow.words.push(w);
      const n = bestRow.words.length;
      bestRow.yMid = bestRow.yMid + (wMid - bestRow.yMid) / n;
      bestRow.avgHeight = bestRow.avgHeight + (wH - bestRow.avgHeight) / n;
      bestRow.y0 = Math.min(bestRow.y0, w.y0);
      bestRow.y1 = Math.max(bestRow.y1, w.y1);
    } else {
      rows.push({
        words: [w],
        yMid: wMid,
        avgHeight: wH,
        y0: w.y0,
        y1: w.y1,
      });
    }
  }

  rows.sort((a, b) => a.yMid - b.yMid);

  return rows.map((row) => {
    row.words.sort((a, b) => a.x0 - b.x0);
    const x0 = Math.min(...row.words.map((w) => w.x0));
    const x1 = Math.max(...row.words.map((w) => w.x1));
    const text = normalizeOcrText(row.words.map((w) => w.text).join(' '));
    return {
      text,
      words: row.words,
      bbox: { x0, y0: row.y0, x1, y1: row.y1 },
      yMid: row.yMid,
    };
  });
}

/**
 * Fallback row builder from plain text when no bounding boxes are available.
 */
function buildTextRows(plainText) {
  const normalized = normalizeOcrText(plainText);
  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, idx) => ({
      text,
      words: [],
      bbox: null,
      yMid: idx * 30,
    }));
}

/**
 * Parse numeric gram/milligram values from a row, ignoring percentages and energy units.
 * Returns array of { value, unit, isLessThan, isTrace, xCenter, raw, explicitUnit, index }.
 */
function extractGramCandidates(row, startCharIndex = 0) {
  const text = row.text;
  const sub = text.slice(startCharIndex);
  const candidates = [];

  // Check for "trace" / "traces" / "nil" after keyword
  const traceMatch = sub.match(/\b(traces?|nil)\b/i);
  if (traceMatch) {
    candidates.push({
      value: 0,
      unit: 'g',
      isLessThan: false,
      isTrace: true,
      xCenter: null,
      raw: traceMatch[0],
      explicitUnit: true,
      index: startCharIndex + traceMatch.index,
    });
  }

  // Match numbers with optional '<' and optional unit
  // Avoid matching numbers inside "100g" or "100ml" if "per 100g" appears on the same line
  const cleanedSub = sub.replace(/\b(?:per|pro|par|por|\/)\s*100\s*(?:g|ml)\b/gi, (m) =>
    ' '.repeat(m.length)
  );

  // Regex captures optional '<', digits with optional decimal, and trailing unit/symbol
  const tokenRe = /(<\s*)?(\d+(?:[.,]\d+)?)\s*(%|kcal|kj|mg|mcg|ug|µg|g|gr|gm|grams?|ml|oz|cal)?(?![a-z0-9])/gi;
  let m;
  while ((m = tokenRe.exec(cleanedSub)) !== null) {
    const isLessThan = Boolean(m[1]);
    let rawNum = m[2].replace(',', '.');
    const unitRaw = (m[3] || '').toLowerCase();

    // Ignore percentages and energy values
    if (unitRaw === '%' || unitRaw === 'kcal' || unitRaw === 'kj' || unitRaw === 'cal') {
      continue;
    }
    if (unitRaw === 'ml' || unitRaw === 'oz' || unitRaw === 'mcg' || unitRaw === 'ug' || unitRaw === 'µg') {
      continue;
    }

    // Check immediate trailing character in original text for '%' (e.g. "10 %")
    const afterPos = m.index + m[0].length;
    const trailing = cleanedSub.slice(afterPos, afterPos + 3);
    if (/^\s*%/.test(trailing)) continue;

    // Classic Tesseract OCR artifact: "41.5g" / "25.0g" misread as "41.59" / "25.09" (no 'g' unit).
    // Nutrition labels round fat to 0.1g (EU) or 0.5g/1g (US), never 2 decimals without a unit.
    let inferredGFrom9 = false;
    if (!unitRaw && /^\d+\.\d9$/.test(rawNum)) {
      rawNum = rawNum.slice(0, -1);
      inferredGFrom9 = true;
    }

    let value = parseFloat(rawNum);
    if (Number.isNaN(value)) continue;

    let explicitUnit = inferredGFrom9;
    if (unitRaw === 'mg') {
      value = value / 1000;
      explicitUnit = true;
    } else if (unitRaw === 'g' || unitRaw === 'gr' || unitRaw === 'gm' || unitRaw === 'gram' || unitRaw === 'grams') {
      explicitUnit = true;
    }

    // Estimate xCenter from row words if available
    const absIndex = startCharIndex + m.index;
    const xCenter = findXCenterForToken(row, m[2], absIndex);

    candidates.push({
      value,
      unit: 'g',
      isLessThan,
      isTrace: false,
      xCenter,
      raw: m[0].trim(),
      explicitUnit,
      index: absIndex,
    });
  }

  return candidates;
}

/**
 * Find the horizontal center (xCenter) of a matched numeric token in row.words.
 */
function findXCenterForToken(row, numStr, charIndex) {
  if (!row.words || row.words.length === 0) return null;

  // Walk row.words accumulating approximate char offset
  let offset = 0;
  let bestWord = null;
  let bestOffsetDiff = Infinity;

  const numPlain = numStr.replace(',', '.');
  for (const w of row.words) {
    const normW = normalizeOcrText(w.text).replace(',', '.');
    const containsNum = normW.includes(numPlain);
    const diff = Math.abs(offset - charIndex);
    if (containsNum && diff < bestOffsetDiff) {
      bestOffsetDiff = diff;
      bestWord = w;
    }
    offset += normW.length + 1;
  }

  if (bestWord) {
    return (bestWord.x0 + bestWord.x1) / 2;
  }
  return null;
}

/**
 * Inspect all rows to detect:
 * - Whether a "per 100g" or "per 100ml" column/basis exists and its xCenter
 * - Serving size in grams (or ml / oz) and serving column xCenter
 * - Relative column ordering (is 100g left of serving or right of serving?)
 */
function detectBasisAndServing(rows) {
  let hasPer100g = false;
  let per100Unit = 'g'; // 'g' or 'ml'
  let per100X = null;
  let per100RowIndex = -1;
  let per100CharPos = -1;

  let servingWeightG = null;
  let servingUnit = 'g'; // 'g' | 'ml' | 'oz'
  let servingRaw = null;
  let servingX = null;
  let servingCharPos = -1;

  // Patterns for per-100g / per-100ml header
  const per100Re = /\b(?:per|for|pro|par|por|je|in|\/)?\s*100\s*(g|gr|gm|grams?|ml)\b/i;
  // Patterns for serving column header (e.g. "per serving", "per portion", "per 30g", "per bar (40g)")
  const servingHeaderRe = /\b(?:per\s+(?:serving|portion|pack|bar|piece|biscuit|slice|cup|tbsp|tsp|scoop|bottle|can|bag|unit|\d+(?:[.,]\d+)?\s*(?:g|ml))|serving\s*size|portion)\b/i;

  // Pass 1: Detect per-100g header and serving column header
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = row.text;

    const m100 = t.match(per100Re);
    if (m100 && !hasPer100g) {
      // Avoid matching "Serving size 100g" as a generic table header unless it's actually 100g serving
      // (Actually, if serving size IS 100g, fat per serving == fat per 100g anyway!)
      hasPer100g = true;
      per100Unit = m100[1].toLowerCase() === 'ml' ? 'ml' : 'g';
      per100RowIndex = i;
      per100CharPos = m100.index;
      per100X = findHeaderWordX(row, /100/i);
    }

    const mServHdr = t.match(servingHeaderRe);
    if (mServHdr) {
      // If same row as per100 or header area, capture serving column X
      const is100Match = /^per\s+100\s*(?:g|ml)$/i.test(mServHdr[0].trim());
      if (!is100Match && servingX === null) {
        servingCharPos = mServHdr.index;
        servingX = findHeaderWordX(row, /(?:serving|portion|pack|bar|piece|biscuit|slice|cup|per)/i, per100X);
      }
    }
  }

  // Pass 2: Extract explicit serving weight (e.g., "Serving size 2/3 cup (55g)", "Per serving (30g)", "Per 25g serving")
  const servingWeightPatterns = [
    // "Serving size: 2/3 cup (55g)" or "Serving Size 1 bar (45 g)"
    /serving\s*size[^(\n]{0,40}\(\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml|oz)\s*\)/i,
    // "Serving size: 55g" or "Serving size 30 g"
    /serving\s*size\s*[:\-]?\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml|oz)\b/i,
    // "Per serving (30g)" / "Per portion (40 g)" / "Per pack (25g)" / "Per 2 biscuits (28g)"
    /\b(?:per|1)\s+(?:serving|portion|pack|bar|piece|biscuits?|cookies?|slices?|crackers?|cup|bowl|scoop|pouch|pot|tub|bottle|can|bag|stick|sachet|roll|slice|wafers?|units?|[\d/]+\s+\w+)[^(\n]{0,25}\(\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml|oz)\s*\)/i,
    // "Per 30g serving" or "Per 45g pack" or "Per 30g" (when not 100g!)
    /\bper\s+(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml)\b/i,
    // "Portion: 30g" / "Portion (30g)"
    /\bportion\s*[:\-(\s]\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml|oz)\b/i,
    // "Serving: 28g"
    /\bserving\s*[:\-(\s]\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml|oz)\b/i,
    // Generic parenthesized weight on a line mentioning serving/cup/tbsp/tsp/oz/pieces/bars/slices
    /\b(?:serving|cup|tbsp|tablespoon|tsp|teaspoon|oz|piece|pieces|bar|slice|slices|cookie|cookies|biscuit|crackers?|chips|nuts|scoop|pouch|pack)\b[^(\n]{0,30}\(\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|ml)\s*\)/i,
  ];

  for (let i = 0; i < rows.length; i++) {
    // Check both the current row and current+next row joined (US labels often wrap Serving Size onto 2 lines!)
    const rowText = rows[i].text;
    const joinedText = i + 1 < rows.length ? `${rowText} ${rows[i + 1].text}` : rowText;

    for (const textToSearch of [rowText, joinedText]) {
      for (const re of servingWeightPatterns) {
        const m = textToSearch.match(re);
        if (!m) continue;
        const val = parseFloat(m[1].replace(',', '.'));
        const unit = m[2].toLowerCase();
        if (Number.isNaN(val) || val <= 0) continue;
        // Skip "per 100g" matched by the generic "per Xg" pattern
        if (Math.abs(val - 100) < 0.01 && re.source.startsWith('\\bper\\s+')) continue;
        // Skip unrealistically tiny or huge serving weights (> 2000g)
        if (val > 2000) continue;

        if (unit === 'oz') {
          // Only use oz if we don't already have a gram weight
          if (servingWeightG === null) {
            servingWeightG = round2(val * 28.3495);
            servingUnit = 'oz';
            servingRaw = `${val} oz`;
          }
        } else {
          servingWeightG = val;
          servingUnit = unit === 'ml' ? 'ml' : 'g';
          servingRaw = `${val}${servingUnit}`;
          break;
        }
      }
      if (servingWeightG !== null && servingUnit !== 'oz') break;
    }
    if (servingWeightG !== null && servingUnit !== 'oz') break;
  }

  // Determine column order if both headers appear
  let per100ColumnOrder = null; // 'first' | 'second' | null
  if (hasPer100g) {
    if (per100X !== null && servingX !== null && Math.abs(per100X - servingX) > 20) {
      per100ColumnOrder = per100X < servingX ? 'first' : 'second';
    } else if (per100CharPos >= 0 && servingCharPos >= 0 && per100RowIndex >= 0) {
      // Check if they appeared on the same header row
      const hdrText = rows[per100RowIndex].text;
      const m1 = hdrText.match(per100Re);
      const m2 = hdrText.match(servingHeaderRe);
      if (m1 && m2 && m1.index !== m2.index) {
        per100ColumnOrder = m1.index < m2.index ? 'first' : 'second';
      }
    }
  }

  return {
    hasPer100g,
    per100Unit,
    per100X,
    servingWeightG,
    servingUnit,
    servingRaw,
    servingX,
    per100ColumnOrder,
  };
}

/**
 * Locate xCenter of a header word in a row, optionally avoiding another known x position.
 */
function findHeaderWordX(row, regex, avoidX = null) {
  if (!row.words || row.words.length === 0) return null;
  let best = null;
  for (const w of row.words) {
    if (regex.test(normalizeOcrText(w.text))) {
      const cx = (w.x0 + w.x1) / 2;
      if (avoidX !== null && Math.abs(cx - avoidX) < 30) continue;
      best = cx;
      break;
    }
  }
  return best;
}

/**
 * Determine if a row matches Total Fat (and not a sub-fat / excluded row).
 * Returns { matched, score, keywordEndIndex } or null.
 */
function matchTotalFatRow(rowText) {
  // Check for "Total Fat" explicitly first (highest priority, can share line with other text)
  const totalFatMatch = rowText.match(
    /\b(total\s+fat|total\s+lipids?|grasas?\s+totales?|grasa\s+total|gorduras?\s+totais?|mati[eè]res?\s+grasses?)\b/i
  );
  if (totalFatMatch) {
    // Make sure it's not "% Daily Value" header or "Calories from Total Fat"
    const before = rowText.slice(0, totalFatMatch.index);
    if (!/\b(?:calories?|energy|kcal)\s+from\s*$/i.test(before)) {
      return {
        matched: true,
        score: 100,
        keywordEndIndex: totalFatMatch.index + totalFatMatch[0].length,
      };
    }
  }

  // Otherwise reject lines that contain sub-fat / exclusion terms
  for (const excl of SUB_FAT_EXCLUDE_PATTERNS) {
    if (excl.test(rowText)) {
      return null;
    }
  }

  for (let i = 0; i < TOTAL_FAT_PATTERNS.length; i++) {
    const m = rowText.match(TOTAL_FAT_PATTERNS[i]);
    if (m) {
      // Score higher if keyword appears near the start of the row
      const nearStartBonus = m.index <= 8 ? 20 : 0;
      return {
        matched: true,
        score: 70 + nearStartBonus - i,
        keywordEndIndex: m.index + m[0].length,
      };
    }
  }

  return null;
}

/**
 * Choose which gram candidate corresponds to per-100g vs per-serving.
 */
function selectFatCandidate(candidates, basis) {
  if (!candidates || candidates.length === 0) return null;

  // Prefer candidates with explicit 'g' unit if we have a mix of explicit & bare numbers
  const explicit = candidates.filter((c) => c.explicitUnit);
  const pool = explicit.length > 0 ? explicit : candidates;

  if (pool.length === 1) {
    return {
      chosen: pool[0],
      isDirectPer100: basis.hasPer100g && !(basis.servingWeightG && !basis.hasPer100g),
      reason: basis.hasPer100g ? 'single_per_100' : 'single_per_serving',
    };
  }

  // Multiple gram candidates on the Fat row (very common on EU/UK 2-column tables!)
  const [c0, c1] = pool;

  // Strategy 1: Mathematical ratio check against servingWeightG (very strong signal!)
  if (basis.hasPer100g && basis.servingWeightG && basis.servingWeightG !== 100) {
    const ratio = basis.servingWeightG / 100;
    const expectedFromC0 = c0.value * ratio;
    const expectedFromC1 = c1.value * ratio;
    const tol = (v) => Math.max(0.6, v * 0.22);

    const c0Is100 = c0.value > 0 && Math.abs(expectedFromC0 - c1.value) <= tol(c1.value);
    const c1Is100 = c1.value > 0 && Math.abs(expectedFromC1 - c0.value) <= tol(c0.value);

    if (c0Is100 && !c1Is100) {
      return { chosen: c0, isDirectPer100: true, reason: 'ratio_verified_first' };
    }
    if (c1Is100 && !c0Is100) {
      return { chosen: c1, isDirectPer100: true, reason: 'ratio_verified_second' };
    }
  }

  // Strategy 2: Spatial X-coordinate alignment with "100g" header
  if (basis.hasPer100g && basis.per100X !== null) {
    const withX = pool.filter((c) => c.xCenter !== null);
    if (withX.length >= 2) {
      withX.sort((a, b) => Math.abs(a.xCenter - basis.per100X) - Math.abs(b.xCenter - basis.per100X));
      return { chosen: withX[0], isDirectPer100: true, reason: 'spatial_column_match' };
    }
  }

  // Strategy 3: Header column order ("Per 100g | Per serving" vs "Per serving | Per 100g")
  if (basis.hasPer100g && basis.per100ColumnOrder === 'second' && pool.length >= 2) {
    return { chosen: pool[1], isDirectPer100: true, reason: 'header_order_second' };
  }

  // Strategy 4: Default to first gram candidate (standard EU/UK left column is per 100g; US has 1 value)
  return {
    chosen: pool[0],
    isDirectPer100: basis.hasPer100g,
    reason: basis.hasPer100g ? 'default_first_per_100' : 'default_first_serving',
  };
}

/**
 * Optionally extract saturated fat per 100g as secondary context.
 */
function extractSaturatedFat(rows, basis, chosenMode) {
  for (const row of rows) {
    let matchedEnd = -1;
    for (const re of SATURATED_FAT_PATTERNS) {
      const m = row.text.match(re);
      if (m) {
        matchedEnd = m.index + m[0].length;
        break;
      }
    }
    if (matchedEnd < 0) continue;

    const candidates = extractGramCandidates(row, matchedEnd);
    if (candidates.length === 0) continue;

    const sel = selectFatCandidate(candidates, basis);
    if (!sel) continue;

    let val = sel.chosen.value;
    if (!sel.isDirectPer100 && chosenMode === 'converted' && basis.servingWeightG) {
      val = (val / basis.servingWeightG) * 100;
    } else if (!sel.isDirectPer100 && chosenMode !== 'converted') {
      return null;
    }

    if (val >= 0 && val <= 100) {
      return round1(val);
    }
  }
  return null;
}

/**
 * Classify fat per 100g using standard UK NHS / EU food nutrition thresholds.
 */
export function classifyFatLevel(fatPer100g) {
  if (fatPer100g === null || Number.isNaN(fatPer100g)) return null;
  if (fatPer100g <= 3.0) {
    return {
      level: 'low',
      label: 'Low fat',
      range: '≤ 3g per 100g',
    };
  }
  if (fatPer100g <= 17.5) {
    return {
      level: 'medium',
      label: 'Medium fat',
      range: '3–17.5g per 100g',
    };
  }
  return {
    level: 'high',
    label: 'High fat',
    range: '> 17.5g per 100g',
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Main entry point: parse Tesseract OCR output ({ text, words, blocks, tsv }) or raw string.
 *
 * Returns a structured result:
 * {
 *   status: 'success' | 'needs_serving' | 'not_found',
 *   fatPer100g: number | null,
 *   basisUnit: '100g' | '100ml',
 *   mode: 'direct_100g' | 'direct_100ml' | 'converted_from_serving' | 'needs_serving' | 'none',
 *   fatRawValue: number | null,
 *   servingWeightG: number | null,
 *   servingRaw: string | null,
 *   isLessThan: boolean,
 *   isTrace: boolean,
 *   saturatedFatPer100g: number | null,
 *   classification: { level, label, range } | null,
 *   matchedLine: string | null,
 *   matchedBbox: { x0, y0, x1, y1 } | null,
 *   warning: string | null,
 *   explanation: string,
 *   rawText: string,
 * }
 */
export function parseNutritionLabel(ocrInput) {
  const ocrData = typeof ocrInput === 'string' ? { text: ocrInput } : ocrInput || {};
  const words = extractWordsFromOcr(ocrData);
  const spatialRows = words.length > 0 ? buildSpatialRows(words) : [];
  const textRows = buildTextRows(ocrData.text || '');

  // Prefer spatial rows if available, but also keep textRows as fallback
  const primaryRows = spatialRows.length > 0 ? spatialRows : textRows;
  const rawText = (ocrData.text || primaryRows.map((r) => r.text).join('\n')).trim();

  let parsed = attemptParseRows(primaryRows, rawText);

  // If spatial reconstruction missed something that plain text caught, try textRows
  if (parsed.status !== 'success' && spatialRows.length > 0 && textRows.length > 0) {
    const fallbackParsed = attemptParseRows(textRows, rawText);
    if (
      fallbackParsed.status === 'success' ||
      (fallbackParsed.status === 'needs_serving' && parsed.status === 'not_found')
    ) {
      parsed = fallbackParsed;
    }
  }

  return parsed;
}

function attemptParseRows(rows, rawText) {
  const basis = detectBasisAndServing(rows);

  // Find candidate Fat rows
  const fatRowMatches = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const match = matchTotalFatRow(row.text);
    if (!match) continue;

    // Extract gram candidates after the keyword on this row
    let candidates = extractGramCandidates(row, match.keywordEndIndex);

    // If no number on this row, check if the value wrapped onto the very next row (rare mobile crop)
    if (candidates.length === 0 && i + 1 < rows.length) {
      const nextRow = rows[i + 1];
      if (/^\s*<?\d+(?:[.,]\d+)?\s*g\b/i.test(nextRow.text)) {
        candidates = extractGramCandidates(nextRow, 0);
      }
    }

    // Ignore lines like "Total Fat" with zero numbers found
    if (candidates.length === 0) continue;

    fatRowMatches.push({
      row,
      score: match.score + (candidates.some((c) => c.explicitUnit) ? 15 : 0),
      candidates,
    });
  }

  if (fatRowMatches.length === 0) {
    return {
      status: 'not_found',
      fatPer100g: null,
      basisUnit: basis.per100Unit === 'ml' ? '100ml' : '100g',
      mode: 'none',
      fatRawValue: null,
      servingWeightG: basis.servingWeightG,
      servingRaw: basis.servingRaw,
      isLessThan: false,
      isTrace: false,
      saturatedFatPer100g: null,
      classification: null,
      matchedLine: null,
      matchedBbox: null,
      warning: null,
      explanation: 'Could not find a Total Fat value on this label.',
      rawText,
    };
  }

  // Pick the highest-scoring Fat row
  fatRowMatches.sort((a, b) => b.score - a.score);
  const best = fatRowMatches[0];
  const selection = selectFatCandidate(best.candidates, basis);
  const chosen = selection.chosen;

  let fatPer100g = null;
  let mode = 'none';
  let status = 'success';
  let warning = null;
  let explanation = '';
  const basisUnit =
    selection.isDirectPer100 && basis.per100Unit === 'ml'
      ? '100ml'
      : !selection.isDirectPer100 && basis.servingUnit === 'ml'
      ? '100ml'
      : '100g';

  if (selection.isDirectPer100) {
    fatPer100g = round1(chosen.value);
    mode = basisUnit === '100ml' ? 'direct_100ml' : 'direct_100g';
    explanation =
      basisUnit === '100ml'
        ? `Read directly from the per 100ml column (${chosen.raw})`
        : `Read directly from the per 100g column (${chosen.raw})`;
  } else if (basis.servingWeightG && basis.servingWeightG > 0) {
    fatPer100g = round1((chosen.value / basis.servingWeightG) * 100);
    mode = 'converted_from_serving';
    explanation = `Calculated from ${chosen.value}g fat per ${basis.servingRaw} serving (${chosen.value} ÷ ${basis.servingWeightG} × 100)`;
  } else {
    // Found fat value, but neither "per 100g" nor a serving size weight was detected
    status = 'needs_serving';
    mode = 'needs_serving';
    explanation = `Found ${chosen.value}g fat, but couldn't tell if it's per 100g or per serving.`;
  }

  // Sanity check: fat per 100g cannot physically exceed 100g!
  if (fatPer100g !== null && fatPer100g > 100) {
    // Often happens when OCR drops a decimal point (e.g., "14.5g" read as "145g")
    if (selection.isDirectPer100 && chosen.value > 100 && chosen.value < 1000 && Number.isInteger(chosen.value)) {
      const fixed = round1(chosen.value / 10);
      warning = `OCR read "${chosen.raw}" (> 100g) — likely missing a decimal point. Adjusted to ${fixed}g; please verify.`;
      fatPer100g = fixed;
    } else {
      warning = `Computed ${fatPer100g}g / 100g, which exceeds 100g. Please check the fat and serving values below.`;
    }
  }

  // Also check if per-serving fat > serving weight (impossible!)
  if (
    mode === 'converted_from_serving' &&
    basis.servingWeightG &&
    chosen.value > basis.servingWeightG
  ) {
    warning = `Fat (${chosen.value}g) appears larger than serving weight (${basis.servingWeightG}g). Please verify below.`;
  }

  const saturatedFatPer100g =
    status === 'success'
      ? extractSaturatedFat(rows, basis, mode === 'converted_from_serving' ? 'converted' : 'direct')
      : null;

  return {
    status,
    fatPer100g,
    basisUnit,
    mode,
    fatRawValue: chosen.value,
    servingWeightG: basis.servingWeightG,
    servingRaw: basis.servingRaw,
    isLessThan: chosen.isLessThan,
    isTrace: chosen.isTrace,
    saturatedFatPer100g:
      saturatedFatPer100g !== null && fatPer100g !== null && saturatedFatPer100g <= fatPer100g + 0.5
        ? saturatedFatPer100g
        : null,
    classification: status === 'success' ? classifyFatLevel(fatPer100g) : null,
    matchedLine: best.row.text,
    matchedBbox: best.row.bbox,
    warning,
    explanation,
    rawText,
  };
}
