/**
 * Nutrition Label Fat Content Parser (g per 100g)
 *
 * Supports:
 * - Auto-deskewed, curve-tolerant spatial word row reconstruction (round lids, cylindrical jars/bottles, split tables)
 * - Linear & circular front-of-pack nutrition labels (FDA linear format, stacked circular badges)
 * - Direct per-100g / per-100ml tables (EU, UK, AU, Intl — both 100g-first and serving-first)
 * - Per-serving labels (US/CA Nutrition Facts, dual-column Per Serving | Per Container, Serv. size) with exact conversion to g / 100g
 * - Multi-language Latin labels (EN, DE, FR, ES, IT, PT, NL, DA/SV/NO, PL, FI, CS)
 * - Strict exclusion of Saturated / Trans / Mono / Poly / Calories-from-Fat rows
 * - % Daily Value cross-check for Tesseract "Xg -> X9" OCR artifacts
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
  /\bcholest\.?\b/i,
  /\bomega\b/i,
  /\bsodium\b/i,
  /\bcarbohydrate/i,
  /\bprotein\b/i,
  /\bfib(?:re|er)\b/i,
  /\bsugars?\b/i,
  /\bsalt\b/i,
];

// Nutrient keywords that terminate a Total Fat segment on compact/linear round labels
const NEXT_NUTRIENT_BOUNDARY_RE =
  /\b(?:saturated|sat\.?\s*fat|saturates?|of\s+which|trans(?:\s+fat)?|poly[-\s]?unsat|mono[-\s]?unsat|cholesterol|cholest\.?|sodium|potassium|total\s+carb|carbohydrates?|carb\.?|dietary\s+fib(?:er|re)|fib(?:er|re)|total\s+sugars?|sugars?|protein|salt|vitamin|calcium|iron|davon|dont|waarvan|de\s+las\s+cuales|di\s+cui)\b/i;

const SATURATED_FAT_PATTERNS = [
  /\bsaturated\s+fat\b/i,
  /\bsat\.?\s*fat\b/i,
  /\bof\s+which\s+saturates?\b/i,
  /\bsaturates?\b/i,
  /\bges[aä]ttigte\s+fetts[aä]uren\b/i,
  /\bdont\s+acides?\s+gras\s+satur[eé]s?\b/i,
  /\bde\s+las\s+cuales\s+saturadas\b/i,
  /\bdi\s+cui\s+acidi\s+grassi\s+saturi\b/i,
  /\bwaarvan\s+verzadigde\b/i,
];

const NET_WEIGHT_CONTEXT_RE =
  /\b(?:net\s*wt\.?|net\s*weight|net\s*cont(?:ent|ents)?|total\s*weight|poids\s*net|peso\s*neto|gewicht|netto|contents?\s*:)\b/i;

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
    .replace(/[“”]/g, '"')
    .replace(/[|¦]/g, ' ');

  // Fix "1OOg" or "1O0g" -> "100g"
  text = text.replace(/\b1[Oo0]{2}\s*(g|gr|gm|ml)\b/gi, '100$1');
  // Fix "per 1009" / "per 100q" -> "per 100g"
  text = text.replace(/\b(per|pro|par|pour|por|je|\/)\s*100\s*[9q]\b/gi, '$1 100g');
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
 * Estimate dominant text tilt angle (in degrees, positive = tilted downward left-to-right)
 * from horizontally adjacent words. Useful for tilted round/circular labels.
 */
export function estimateTiltAngleFromWords(words) {
  if (!words || words.length < 4) return 0;

  const valid = words.filter((w) => w.conf >= 30 && w.text.length >= 2);
  if (valid.length < 4) return 0;

  const heights = valid.map((w) => Math.max(4, w.y1 - w.y0)).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 20;

  const angles = [];
  for (let i = 0; i < valid.length; i++) {
    const a = valid[i];
    const ax = (a.x0 + a.x1) / 2;
    const ay = (a.y0 + a.y1) / 2;
    let bestB = null;
    let bestDist = Infinity;

    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;
      const b = valid[j];
      const gap = b.x0 - a.x1;
      if (gap < -medH * 0.2 || gap > medH * 4.5) continue;
      const bx = (b.x0 + b.x1) / 2;
      const by = (b.y0 + b.y1) / 2;
      const dx = bx - ax;
      const dy = by - ay;
      if (dx <= medH * 0.6 || Math.abs(dy) > medH * 1.4) continue;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestB = b;
      }
    }

    if (bestB) {
      const dx = (bestB.x0 + bestB.x1) / 2 - ax;
      const dy = (bestB.y0 + bestB.y1) / 2 - ay;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (Math.abs(deg) <= 35) {
        angles.push(deg);
      }
    }
  }

  if (angles.length < 3) return 0;
  angles.sort((a, b) => a - b);
  const median = angles[Math.floor(angles.length / 2)];
  return Math.abs(median) >= 1.5 ? median : 0;
}

/**
 * Group spatial words into horizontal visual rows:
 * 1. Auto-deskews coordinates when a round/circular label is photographed at a tilt
 * 2. Follows gentle horizontal curvature (smile/frown arc on cylindrical jars/cans/tubs)
 *    by chaining words left-to-right relative to each row's rightmost word.
 */
export function buildSpatialRows(words) {
  if (!words || words.length === 0) return [];

  const cleanWords = words.filter((w) => {
    if (w.conf < 12 && w.text.length <= 1 && !/\d/.test(w.text)) return false;
    return true;
  });
  if (cleanWords.length === 0) return [];

  const heights = cleanWords
    .map((w) => Math.max(4, w.y1 - w.y0))
    .sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;

  // Compute centroid & tilt angle for coordinate deskewing
  let sumX = 0;
  let sumY = 0;
  for (const w of cleanWords) {
    sumX += (w.x0 + w.x1) / 2;
    sumY += (w.y0 + w.y1) / 2;
  }
  const cx = sumX / cleanWords.length;
  const cy = sumY / cleanWords.length;

  const tiltDeg = estimateTiltAngleFromWords(cleanWords);
  const rad = (-tiltDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const projected = cleanWords.map((w) => {
    const mx = (w.x0 + w.x1) / 2 - cx;
    const my = (w.y0 + w.y1) / 2 - cy;
    const rx = mx * cosA - my * sinA + cx;
    const ry = mx * sinA + my * cosA + cy;
    const wH = Math.max(4, w.y1 - w.y0);
    return {
      orig: w,
      rx,
      ry,
      rx0: rx - (w.x1 - w.x0) / 2,
      rx1: rx + (w.x1 - w.x0) / 2,
      wH,
    };
  });

  // Sort left-to-right (breaking ties top-to-bottom) so curved rows chain smoothly along x
  projected.sort((a, b) => {
    if (Math.abs(a.rx0 - b.rx0) > medianHeight * 0.4) return a.rx0 - b.rx0;
    return a.ry - b.ry;
  });

  const rows = [];
  for (const item of projected) {
    let bestRow = null;
    let bestScore = Infinity;

    for (const row of rows) {
      // Compare vertically against the rightmost word currently in this row (tracks gentle cylinder curve!)
      const last = row.items[row.items.length - 1];
      // Prevent merging two words stacked at the same X coordinate
      if (item.rx0 < last.rx1 - medianHeight * 0.35 && Math.abs(item.ry - last.ry) > medianHeight * 0.4) {
        continue;
      }

      const refY = 0.7 * last.ry + 0.3 * row.yMid;
      const distY = Math.abs(item.ry - refY);
      const baseTol = Math.max(medianHeight * 0.62, Math.min(item.wH, row.avgHeight) * 0.7);
      // Allow modest extra vertical tolerance across wide gaps on curved bottles/jars
      const gapX = Math.max(0, item.rx0 - last.rx1);
      const curveBonus = Math.min(medianHeight * 0.35, gapX * 0.035);
      const tolerance = baseTol + curveBonus;

      if (distY <= tolerance) {
        const score = distY + gapX * 0.002;
        if (score < bestScore) {
          bestScore = score;
          bestRow = row;
        }
      }
    }

    if (bestRow) {
      bestRow.items.push(item);
      const n = bestRow.items.length;
      bestRow.yMid = bestRow.yMid + (item.ry - bestRow.yMid) / n;
      bestRow.avgHeight = bestRow.avgHeight + (item.wH - bestRow.avgHeight) / n;
    } else {
      rows.push({
        items: [item],
        yMid: item.ry,
        avgHeight: item.wH,
      });
    }
  }

  rows.sort((a, b) => a.yMid - b.yMid);

  return rows.map((row) => {
    row.items.sort((a, b) => a.rx0 - b.rx0);
    const origWords = row.items.map((it) => it.orig);
    const x0 = Math.min(...origWords.map((w) => w.x0));
    const y0 = Math.min(...origWords.map((w) => w.y0));
    const x1 = Math.max(...origWords.map((w) => w.x1));
    const y1 = Math.max(...origWords.map((w) => w.y1));
    const text = normalizeOcrText(origWords.map((w) => w.text).join(' '));
    return {
      text,
      words: origWords,
      projectedItems: row.items,
      bbox: { x0, y0, x1, y1 },
      yMid: row.yMid,
      medianHeight,
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
      projectedItems: [],
      bbox: null,
      yMid: idx * 30,
      medianHeight: 20,
    }));
}

/**
 * Extract numeric gram/milligram candidates from a row after `startCharIndex`,
 * truncating before the next nutrient keyword (critical for compact/linear round labels!),
 * ignoring percentages and energy units, and cross-checking Tesseract "Xg -> X9" errors
 * against any % Daily Value on the same segment.
 */
function extractGramCandidates(row, startCharIndex = 0, { stopAtNextNutrient = true } = {}) {
  const text = row.text;
  let sub = text.slice(startCharIndex);

  if (stopAtNextNutrient) {
    const boundary = sub.match(NEXT_NUTRIENT_BOUNDARY_RE);
    if (boundary && boundary.index > 0) {
      sub = sub.slice(0, boundary.index);
    }
  }

  const candidates = [];

  // Capture any % Daily Value in this Total Fat segment (for smart X9 -> Xg cross-check)
  const dvMatches = [...sub.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) =>
    parseFloat(m[1].replace(',', '.'))
  );
  const firstDvPercent = dvMatches.length > 0 ? dvMatches[0] : null;

  // Check for "trace" / "traces" / "nil"
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

  // Mask "per 100g" / "per 100ml" if it somehow appears on the same line
  const cleanedSub = sub.replace(/\b(?:per|pro|par|pour|por|\/)\s*100\s*(?:g|ml)\b/gi, (m) =>
    ' '.repeat(m.length)
  );

  // Match optional '<', numeric value, and optional unit/symbol
  const tokenRe =
    /(<\s*)?(\d+(?:[.,]\d+)?)\s*(%|kcal|kj|mg|mcg|ug|µg|g|gr|gm|grams?|ml|oz|cal)?(?![a-z0-9])/gi;
  let m;
  while ((m = tokenRe.exec(cleanedSub)) !== null) {
    const isLessThan = Boolean(m[1]);
    let rawNum = m[2].replace(',', '.');
    const unitRaw = (m[3] || '').toLowerCase();

    // Skip percentages, energy, and non-mass units
    if (
      unitRaw === '%' ||
      unitRaw === 'kcal' ||
      unitRaw === 'kj' ||
      unitRaw === 'cal' ||
      unitRaw === 'ml' ||
      unitRaw === 'oz' ||
      unitRaw === 'mcg' ||
      unitRaw === 'ug' ||
      unitRaw === 'µg'
    ) {
      continue;
    }

    const afterPos = m.index + m[0].length;
    const trailing = cleanedSub.slice(afterPos, afterPos + 4);
    if (/^\s*%/.test(trailing)) continue;
    // Skip numbers followed by "DV" (e.g. "15 DV" where '%' was dropped by OCR)
    if (/^\s*dv\b/i.test(trailing)) continue;

    // 1. Classic Tesseract OCR artifact: "41.5g" / "25.0g" misread as "41.59" / "25.09"
    let inferredGFrom9 = false;
    if (!unitRaw && /^\d+\.\d9$/.test(rawNum)) {
      rawNum = rawNum.slice(0, -1);
      inferredGFrom9 = true;
    }

    // 2. US Nutrition Facts OCR artifact: integer "8g" / "12g" / "0g" misread as "89" / "129" / "09"
    //    Cross-checked safely against % Daily Value (FDA 78g or 65g reference)!
    if (!unitRaw && !inferredGFrom9 && /^\d+9$/.test(rawNum) && rawNum.length >= 2) {
      const asInt = parseInt(rawNum, 10);
      const stripped = parseInt(rawNum.slice(0, -1), 10);
      if (rawNum === '09') {
        rawNum = '0';
        inferredGFrom9 = true;
      } else if (firstDvPercent !== null && firstDvPercent >= 0 && firstDvPercent <= 100) {
        const expected78 = (firstDvPercent / 100) * 78;
        const expected65 = (firstDvPercent / 100) * 65;
        const errAsIs = Math.min(Math.abs(asInt - expected78), Math.abs(asInt - expected65));
        const errStripped = Math.min(Math.abs(stripped - expected78), Math.abs(stripped - expected65));
        if (errStripped <= Math.max(2.2, expected78 * 0.25) && errStripped * 2.5 < errAsIs) {
          rawNum = String(stripped);
          inferredGFrom9 = true;
        }
      }
    }

    let value = parseFloat(rawNum);
    if (Number.isNaN(value)) continue;

    let explicitUnit = inferredGFrom9;
    if (unitRaw === 'mg') {
      value = value / 1000;
      explicitUnit = true;
    } else if (
      unitRaw === 'g' ||
      unitRaw === 'gr' ||
      unitRaw === 'gm' ||
      unitRaw === 'gram' ||
      unitRaw === 'grams'
    ) {
      explicitUnit = true;
    }

    const absIndex = startCharIndex + m.index;
    const xCenter = findXCenterForToken(row, m[2], absIndex);

    candidates.push({
      value,
      unit: 'g',
      isLessThan,
      isTrace: false,
      xCenter,
      raw: inferredGFrom9 ? `${value}g` : m[0].trim(),
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
 * Parse a serving weight token inside a string after a serving keyword.
 * Handles: "(55g)", "(28g / 1 oz)", "(28g/about 14 chips)", "(55g", "55g)", "55g",
 * "(559)" (OCR g->9 inside parens), "1 oz", "8 fl oz", "240mL".
 */
function extractWeightFromServingSegment(segment) {
  if (!segment) return null;

  // 1. Explicit grams/ml inside parentheses (even if followed by "/ 1 oz", "/ about 14 chips", or missing closing ')')
  const parenGramRe =
    /\(\s*(?:about\s+)?(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml)\b/i;
  const m1 = segment.match(parenGramRe);
  if (m1) {
    const val = parseFloat(m1[1].replace(',', '.'));
    if (val > 0 && val <= 2000) {
      const unit = m1[2].toLowerCase() === 'ml' ? 'ml' : 'g';
      return { weightG: val, unit, raw: `${val}${unit}`, priority: 10 };
    }
  }

  // 2. Explicit grams/ml after a slash inside parens, e.g. "(1 oz / 28g)" or "(1.1 oz, 30g)"
  const parenSlashGramRe =
    /\([^)\n]{0,28}[/,]\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml)\b/i;
  const m2 = segment.match(parenSlashGramRe);
  if (m2) {
    const val = parseFloat(m2[1].replace(',', '.'));
    if (val > 0 && val <= 2000) {
      const unit = m2[2].toLowerCase() === 'ml' ? 'ml' : 'g';
      return { weightG: val, unit, raw: `${val}${unit}`, priority: 10 };
    }
  }

  // 3. Explicit grams/ml anywhere in the serving segment (handles missing '(' like "2/3 cup 55g)" or "28g")
  //    Avoid matching "100g" if it says "per 100g"
  const cleanedSeg = segment.replace(/\b(?:per|pro|par|pour|por|\/)\s*100\s*(?:g|ml)\b/gi, '');
  const plainGramRe =
    /\b(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml)\b/i;
  const m3 = cleanedSeg.match(plainGramRe);
  if (m3) {
    const val = parseFloat(m3[1].replace(',', '.'));
    if (val > 0 && val <= 2000) {
      const unit = m3[2].toLowerCase() === 'ml' ? 'ml' : 'g';
      return { weightG: val, unit, raw: `${val}${unit}`, priority: 9 };
    }
  }

  // 4. OCR artifact inside parens on a Serving Size line: "(559)" or "(289)" or "(30q)" where g -> 9/q
  const parenOcr9Re = /\(\s*(\d{1,3})[9q]\s*\)/i;
  const m4 = segment.match(parenOcr9Re);
  if (m4) {
    const val = parseInt(m4[1], 10);
    if (val >= 5 && val <= 600) {
      return { weightG: val, unit: 'g', raw: `${val}g`, priority: 7 };
    }
  }

  // 5. Fluid ounces: "8 fl oz" -> 236.6ml
  const flOzRe = /\b(\d+(?:[.,]\d+)?)\s*fl\.?\s*oz\.?\b/i;
  const m5 = segment.match(flOzRe);
  if (m5) {
    const oz = parseFloat(m5[1].replace(',', '.'));
    if (oz > 0 && oz <= 64) {
      return { weightG: round1(oz * 29.5735), unit: 'ml', raw: `${oz} fl oz`, priority: 5 };
    }
  }

  // 6. Ounces (only if no gram weight was found): "1 oz" or "1.5 oz" -> grams
  const ozRe = /\b(\d+(?:[.,]\d+)?)\s*oz\.?\b/i;
  const m6 = segment.match(ozRe);
  if (m6) {
    const oz = parseFloat(m6[1].replace(',', '.'));
    if (oz > 0 && oz <= 64) {
      return { weightG: round2(oz * 28.3495), unit: 'oz', raw: `${oz} oz`, priority: 4 };
    }
  }

  return null;
}

/**
 * Inspect all rows to detect:
 * - Whether an authentic "per 100g" / "per 100ml" nutrition table column exists (and its xCenter)
 * - Whether US/CA per-serving indicators exist ("Nutrition Facts", "Amount per serving", "% Daily Value")
 * - Explicit serving weight in grams (or ml / oz), plus fallback from Net Weight / Servings per container
 * - Relative column ordering ("Per 100g | Per serving" vs "Per serving | Per 100g")
 */
function detectBasisAndServing(rows) {
  let hasPer100g = false;
  let per100IsExplicit = false; // true when "per 100g" / "/100g" / "pro 100g" etc. was seen
  let per100Unit = 'g'; // 'g' or 'ml'
  let per100X = null;
  let per100RowIndex = -1;
  let per100CharPos = -1;

  let hasUsPerServingIndicators = false;
  let hasDualPerContainer = false;

  let servingWeightG = null;
  let servingUnit = 'g'; // 'g' | 'ml' | 'oz'
  let servingRaw = null;
  let servingSource = null; // 'explicit' | 'net_wt_divided'
  let servingPriority = 0;
  let servingX = null;
  let servingCharPos = -1;

  let servingsPerContainer = null;
  let netWeightG = null;

  // Explicit per-100g basis patterns (unambiguous nutrition basis)
  const explicitPer100Re =
    /\b(?:per|for|pro|par|pour|por|je|in)\s*100\s*(g|gr|gm|grams?|ml)\b|\/\s*100\s*(g|gr|gm|ml)\b/i;
  // Bare "100g" / "100 ml" column header (only accepted in header rows, never on Net Wt or Serving Size lines!)
  const bare100HeaderRe = /(?:^|[\s:])100\s*(g|ml)\b(?![^\n]*\be\b)/i;

  const servingHeaderRe =
    /\b(?:per\s+(?:serving|portion|pack|bar|piece|biscuit|slice|cup|tbsp|tsp|scoop|bottle|can|bag|tub|pot|pouch|unit|container|\d+(?:[.,]\d+)?\s*(?:g|ml))|serving\s*size|serv\.?\s*size|portion)\b/i;

  const usIndicatorRe =
    /\b(?:nutrition\s+facts|amount\s+per\s+serving|amount\s*\/\s*serving|%\s*daily\s+value|%\s*dv\b|servings?\s+per\s+container|serv\.?\s*size)\b/i;

  const dualContainerRe =
    /\bper\s+(?:container|package|pack|bottle|can|bag|box|tub|jar|pouch)\b/i;

  // Locate approximate Fat row index so bare "100g" headers are only trusted above or near the table top
  let firstFatRowIdx = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (matchTotalFatRow(rows[i].text)) {
      firstFatRowIdx = i;
      break;
    }
  }

  // Pass 1: Detect per-100g column, US per-serving indicators, dual-column, net weight, and servings/container
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = row.text;

    if (usIndicatorRe.test(t)) {
      hasUsPerServingIndicators = true;
    }
    if (dualContainerRe.test(t) && /\bper\s+serving\b/i.test(rows.map((r) => r.text).join(' '))) {
      hasDualPerContainer = true;
    }

    // Extract "X servings per container" (useful for dual-column verification or net-wt fallback)
    const spcMatch = t.match(/\b(?:about\s+)?(\d+(?:[.,]\d+)?)\s*servings?\s+per\s+(?:container|package|pack|bag|box|jar|tub|bottle|can)\b/i)
      || t.match(/\bservings?\s*[:\-]?\s*(?:about\s+)?(\d+(?:[.,]\d+)?)\b/i);
    if (spcMatch && servingsPerContainer === null && !/size/i.test(t.slice(spcMatch.index, spcMatch.index + 20))) {
      const n = parseFloat(spcMatch[1].replace(',', '.'));
      if (n > 0 && n <= 200) servingsPerContainer = n;
    }

    // Extract Net Weight if present (also helps us IGNORE "Net Wt 100g" as a per-100g column!)
    const isNetWtLine = NET_WEIGHT_CONTEXT_RE.test(t) || /\b\d+(?:[.,]\d+)?\s*g\s*e\b/i.test(t);
    if (isNetWtLine && netWeightG === null) {
      const nw = extractWeightFromServingSegment(t);
      if (nw && nw.unit !== 'oz') {
        netWeightG = nw.weightG;
      } else if (nw) {
        netWeightG = nw.weightG;
      }
    }

    // Check explicit "per 100g" / "/100g" / "pro 100g"
    const mExp100 = t.match(explicitPer100Re);
    if (mExp100 && !isNetWtLine) {
      const unitStr = (mExp100[1] || mExp100[2] || 'g').toLowerCase();
      hasPer100g = true;
      per100IsExplicit = true;
      per100Unit = unitStr === 'ml' ? 'ml' : 'g';
      per100RowIndex = i;
      per100CharPos = mExp100.index;
      per100X = findHeaderWordX(row, /100/i);
    } else if (
      !hasPer100g &&
      !isNetWtLine &&
      i <= firstFatRowIdx &&
      !/\b(?:serving\s*size|serv\.?\s*size)\b/i.test(t) &&
      !/\(\s*100\s*(?:g|ml)\s*\)/i.test(t) &&
      bare100HeaderRe.test(t)
    ) {
      // Bare "100g" only counts as a table header if the row looks like a table header
      // (short row, or mentions nutrition/typical/values/energy/serving/portion/%RI)
      const tokenCount = t.split(/\s+/).length;
      const looksLikeHeader =
        tokenCount <= 6 ||
        /\b(?:typical|values?|nutrition|n[aä]hrwerte|valeurs|valori|voedingswaarde|per|serving|portion|ri|reference)\b/i.test(t);
      if (looksLikeHeader) {
        const mBare = t.match(bare100HeaderRe);
        hasPer100g = true;
        per100Unit = mBare[1].toLowerCase() === 'ml' ? 'ml' : 'g';
        per100RowIndex = i;
        per100CharPos = mBare.index;
        per100X = findHeaderWordX(row, /100/i);
      }
    }

    // Detect serving column header X coordinate (mask out "Per 100g" first so we match "Per serving" later on the same row!)
    const tWithout100 = t.replace(
      /\b(?:per|for|pro|par|pour|por|je|in)\s*100\s*(?:g|gr|gm|grams?|ml)\b/gi,
      (m) => ' '.repeat(m.length)
    );
    const mServHdr = tWithout100.match(servingHeaderRe);
    if (mServHdr && servingX === null) {
      servingCharPos = mServHdr.index;
      servingX =
        findHeaderWordX(
          row,
          /(?:serving|serv\.?|portion|pack|bar|piece|biscuit|slice|cup|container|bottle|can|tub|pot|pouch)/i,
          per100X
        ) ??
        findHeaderWordX(row, /^(?:\(?\d+(?:[.,]\d+)?\s*(?:g|ml)\)?)$/i, per100X);
    }
  }

  // Pass 2: Extract explicit serving weight (handles 1, 2, or 3 wrapped lines!)
  const servingAnchorPatterns = [
    /\bserv(?:ing)?\.?\s*size\b/i,
    /\bportion\s*size\b/i,
    /\bper\s+(?:\d+(?:[.,/]\d+)?\s+)?(?:serving|portion|pack|bar|piece|biscuits?|cookies?|slices?|crackers?|cup|bowl|scoop|pouch|pot|tub|bottle|can|bag|stick|sachet|roll|wafers?|container|package|wedge|patty|unit)\b/i,
    /\bamount\s+per\s+serving\b/i,
    /\bportion\b/i,
    /\bserving\s*[:\-=]/i,
  ];

  const acceptServing = (cand, source = 'explicit') => {
    if (!cand) return;
    if (cand.priority > servingPriority) {
      servingWeightG = cand.weightG;
      servingUnit = cand.unit;
      servingRaw = cand.raw;
      servingSource = source;
      servingPriority = cand.priority;
    }
  };

  for (let i = 0; i < rows.length; i++) {
    const rowText = rows[i].text;
    // Skip nutrient data rows when looking for serving size
    if (/\b(?:total\s+fat|saturated|cholesterol|sodium|carbohydrate|protein|calories)\b/i.test(rowText)) {
      // Unless it's a compact FDA linear label that has BOTH "Serv. size" and "Total Fat" on the same row!
      if (!/\bserv(?:ing)?\.?\s*size\b/i.test(rowText)) continue;
    }

    for (const anchorRe of servingAnchorPatterns) {
      const am = rowText.match(anchorRe);
      if (!am) continue;

      // Search from the anchor onward across current row, +next row, +2 rows (stops before Calories/Total Fat!)
      const segs = [];
      let combined = rowText.slice(am.index + am[0].length);
      // Truncate before Calories / Total Fat on linear labels so we never grab a nutrient gram value!
      const stopLinear = combined.match(/\b(?:amount\s+per|calories|total\s+fat|energy)\b/i);
      if (stopLinear) {
        combined = combined.slice(0, stopLinear.index);
      }
      segs.push(combined);

      if (i + 1 < rows.length && !/\b(?:total\s+fat|saturated|cholesterol|sodium)\b/i.test(rows[i + 1].text)) {
        const nextClean = rows[i + 1].text.replace(/\b(?:calories|amount\s+per).*$/i, '');
        segs.push(`${combined} ${nextClean}`);
        if (
          i + 2 < rows.length &&
          !/\b(?:total\s+fat|saturated|cholesterol|sodium|calories)\b/i.test(rows[i + 2].text)
        ) {
          segs.push(`${combined} ${nextClean} ${rows[i + 2].text}`);
        }
      }

      for (const seg of segs) {
        const w = extractWeightFromServingSegment(seg);
        if (w) {
          acceptServing(w, 'explicit');
          break;
        }
      }
      if (servingPriority >= 9) break;
    }
    if (servingPriority >= 9) break;
  }

  // Pass 2b: "Per 30g" / "Per 45g serving" / "1 cup (240ml)" / "2 Tbsp (32g)" without explicit "Serving size" word
  if (servingPriority < 9) {
    const fallbackServingPatterns = [
      // "Per 30g" / "Per 45 g" (not 100g!)
      /\bper\s+(\d+(?:[.,]\d+)?)\s*(g|gr|gm|grams?|ml)\b/i,
      // Household measure + weight: "2/3 cup (55g)", "2 tbsp (30g)", "1 container (150g)", "3 cookies (34g)"
      /\b(?:\d+(?:\/\d+)?\s+)?(?:cups?|tbsp\.?|tablespoons?|tsp\.?|teaspoons?|oz\.?|fl\.?\s*oz\.?|pieces?|pcs\.?|bars?|slices?|cookies?|biscuits?|crackers?|chips|nuts|scoops?|pouch(?:es)?|packs?|packages?|pkg\.?|containers?|jars?|tubs?|pots?|bottles?|cans?|bags?|sticks?|wedges?|patties|links?|tortillas?|muffins?|bagels?|donuts?|eggs?|units?|rolls?|wafers?|squares?|servings?)\b[^(\n]{0,24}\(\s*(\d+(?:[.,]\d+)?)\s*(g|gr|gm|ml)\b/i,
    ];

    for (let i = 0; i < Math.min(rows.length, firstFatRowIdx + 2); i++) {
      const t = rows[i].text;
      if (NET_WEIGHT_CONTEXT_RE.test(t)) continue;
      if (/\b(?:total\s+fat|saturated|cholesterol|sodium|carbohydrate|protein)\b/i.test(t)) continue;

      for (const re of fallbackServingPatterns) {
        const m = t.match(re);
        if (!m) continue;
        const val = parseFloat(m[1].replace(',', '.'));
        const unit = m[2].toLowerCase() === 'ml' ? 'ml' : 'g';
        if (Number.isNaN(val) || val <= 0 || val > 2000) continue;
        if (Math.abs(val - 100) < 0.01 && re.source.startsWith('\\bper\\s+')) continue;
        acceptServing({ weightG: val, unit, raw: `${val}${unit}`, priority: 8 }, 'explicit');
        break;
      }
      if (servingPriority >= 8) break;
    }
  }

  // Pass 2c: Fallback from Net Weight ÷ Servings per container (when serving size grams were cut off)
  if (servingWeightG === null && netWeightG && servingsPerContainer && servingsPerContainer >= 1) {
    const est = round1(netWeightG / servingsPerContainer);
    if (est >= 2 && est <= 1500) {
      servingWeightG = est;
      servingUnit = 'g';
      servingRaw = `${est}g (${netWeightG}g ÷ ${servingsPerContainer} servings)`;
      servingSource = 'net_wt_divided';
    }
  }

  // If this is clearly a US Nutrition Facts per-serving label and "100g" was NOT an explicit "per 100g" header,
  // never let an incidental bare "100g" disable the serving-size conversion!
  if (hasUsPerServingIndicators && !per100IsExplicit && servingWeightG !== null) {
    hasPer100g = false;
  }

  // Determine column order if both Per 100g and Per Serving headers appear
  let per100ColumnOrder = null; // 'first' | 'second' | null
  if (hasPer100g) {
    if (per100X !== null && servingX !== null && Math.abs(per100X - servingX) > 20) {
      per100ColumnOrder = per100X < servingX ? 'first' : 'second';
    } else if (per100CharPos >= 0 && servingCharPos >= 0 && per100RowIndex >= 0) {
      const hdrText = rows[per100RowIndex].text;
      const m1 = hdrText.match(explicitPer100Re) || hdrText.match(bare100HeaderRe);
      const hdrNo100 = hdrText.replace(
        /\b(?:per|for|pro|par|pour|por|je|in)\s*100\s*(?:g|gr|gm|grams?|ml)\b/gi,
        (m) => ' '.repeat(m.length)
      );
      const m2 = hdrNo100.match(servingHeaderRe);
      if (m1 && m2 && m1.index !== m2.index) {
        per100ColumnOrder = m1.index < m2.index ? 'first' : 'second';
      }
    }
  }

  return {
    hasPer100g,
    per100IsExplicit,
    per100Unit,
    per100X,
    hasUsPerServingIndicators,
    hasDualPerContainer,
    servingsPerContainer,
    servingWeightG,
    servingUnit,
    servingRaw,
    servingSource,
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
  // Reject US FDA footnote reference table rows (e.g., "Total Fat Less than 65g 80g")
  if (/\bless\s+than\s+\d+\s*g\b/i.test(rowText) || /\bcalories?\s+per\s+gram\b/i.test(rowText)) {
    return null;
  }

  // Check for "Total Fat" explicitly first (highest priority, works on FDA linear labels too!)
  const totalFatMatch = rowText.match(
    /\b(total\s+fat|total\s+lipids?|grasas?\s+totales?|grasa\s+total|gorduras?\s+totais?|mati[eè]res?\s+grasses?)\b/i
  );
  if (totalFatMatch) {
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

  const explicit = candidates.filter((c) => c.explicitUnit);
  const pool = explicit.length > 0 ? explicit : candidates;

  if (pool.length === 1) {
    const c = pool[0];
    // Even with a single candidate, check if this is a 2-column table where OCR only caught
    // the Per Serving column (spatially aligned under servingX rather than per100X)!
    if (
      basis.hasPer100g &&
      basis.servingWeightG &&
      basis.per100X !== null &&
      basis.servingX !== null &&
      c.xCenter !== null &&
      Math.abs(basis.per100X - basis.servingX) > 25
    ) {
      const dist100 = Math.abs(c.xCenter - basis.per100X);
      const distServ = Math.abs(c.xCenter - basis.servingX);
      if (distServ < dist100 * 0.72) {
        return {
          chosen: c,
          isDirectPer100: false,
          reason: 'single_spatially_under_serving',
        };
      }
    }

    return {
      chosen: c,
      isDirectPer100: basis.hasPer100g,
      reason: basis.hasPer100g ? 'single_per_100' : 'single_per_serving',
    };
  }

  const [c0, c1] = pool;

  // US Dual-Column (Per Serving | Per Container): NOT per 100g — use Per Serving column!
  if (!basis.hasPer100g) {
    return {
      chosen: c0,
      isDirectPer100: false,
      reason: basis.hasDualPerContainer ? 'dual_column_per_serving' : 'default_first_serving',
    };
  }

  // Strategy 1: Mathematical ratio check against servingWeightG (very strong signal!)
  if (basis.hasPer100g && basis.servingWeightG && Math.abs(basis.servingWeightG - 100) > 1) {
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

  // Strategy 4: Default to first gram candidate (standard EU/UK left column is per 100g)
  return {
    chosen: pool[0],
    isDirectPer100: basis.hasPer100g,
    reason: 'default_first_per_100',
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

    // Truncate right after Saturated Fat before Trans / Cholesterol on linear labels!
    const candidates = extractGramCandidates(row, matchedEnd, { stopAtNextNutrient: true });
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
 * Combine complementary findings across multiple OCR passes of the same image.
 * Example: Pass 1 cleanly reads "Serving size (55g)" on the top of a curved jar,
 * while Pass 2 (local glare flattening) cleanly reads "Total Fat 8g" in the middle.
 */
export function combineScanPasses(passA, passB) {
  if (!passA) return passB;
  if (!passB) return passA;

  // Prefer clean success without warning
  const score = (r) => {
    let s = 0;
    if (r.status === 'success') s += 100;
    else if (r.status === 'needs_serving') s += 50;
    if (!r.warning) s += 15;
    if (r.mode === 'converted_from_serving' || r.mode === 'direct_100g' || r.mode === 'direct_100ml') s += 5;
    if (r.saturatedFatPer100g !== null) s += 2;
    return s;
  };

  // Complementary rescue: one pass found fat (needs_serving), the other found servingWeightG!
  const tryMerge = (fatPass, servPass) => {
    if (
      fatPass.status === 'needs_serving' &&
      fatPass.fatRawValue !== null &&
      servPass.servingWeightG &&
      servPass.servingWeightG > 0
    ) {
      const fatPer100g = round1((fatPass.fatRawValue / servPass.servingWeightG) * 100);
      const basisUnit = servPass.basisUnit === '100ml' ? '100ml' : '100g';
      const warning =
        fatPer100g > 100
          ? `Computed ${fatPer100g}g / ${basisUnit}, which exceeds 100g. Please check the fat and serving values below.`
          : null;
      return {
        ...fatPass,
        status: 'success',
        fatPer100g,
        basisUnit,
        mode: 'converted_from_serving',
        servingWeightG: servPass.servingWeightG,
        servingRaw: servPass.servingRaw || `${servPass.servingWeightG}g`,
        classification: classifyFatLevel(fatPer100g),
        warning,
        explanation: `Calculated from ${fatPass.fatRawValue}g fat per ${servPass.servingRaw || `${servPass.servingWeightG}g`} serving (${fatPass.fatRawValue} ÷ ${servPass.servingWeightG} × 100)`,
      };
    }
    return null;
  };

  const mergedAB = tryMerge(passA, passB);
  const mergedBA = tryMerge(passB, passA);
  const candidates = [passA, passB, mergedAB, mergedBA].filter(Boolean);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
}

/**
 * Main entry point: parse Tesseract OCR output ({ text, words, blocks, tsv }) or raw string.
 */
export function parseNutritionLabel(ocrInput) {
  const ocrData = typeof ocrInput === 'string' ? { text: ocrInput } : ocrInput || {};
  const words = extractWordsFromOcr(ocrData);
  const tiltAngleDeg = estimateTiltAngleFromWords(words);
  const spatialRows = words.length > 0 ? buildSpatialRows(words) : [];
  const textRows = buildTextRows(ocrData.text || '');

  const primaryRows = spatialRows.length > 0 ? spatialRows : textRows;
  const rawText = (ocrData.text || primaryRows.map((r) => r.text).join('\n')).trim();

  let parsed = attemptParseRows(primaryRows, rawText);

  // If spatial reconstruction missed something plain text caught (or only got needs_serving), try textRows too
  if (spatialRows.length > 0 && textRows.length > 0) {
    const fallbackParsed = attemptParseRows(textRows, rawText);
    parsed = combineScanPasses(parsed, fallbackParsed);
  }

  return {
    ...parsed,
    tiltAngleDeg,
  };
}

/**
 * Check if a row is purely a numeric amount (used for stacked / circular nutrition badges
 * or curved rows where Tesseract dropped the gram value onto the previous/next line).
 */
function isStandaloneAmountRow(text) {
  if (!text) return false;
  // Must not contain another nutrient name
  if (NEXT_NUTRIENT_BOUNDARY_RE.test(text)) return false;
  if (/\b(?:serving|calories|energy|nutrition)\b/i.test(text)) return false;
  return /^\s*(?:<\s*)?\d+(?:[.,]\d+)?\s*(?:g|gr|gm|mg|grams?)?(?:\s+\d+(?:[.,]\d+)?\s*(?:g|gr|gm|%))*\s*$/i.test(
    text
  );
}

function attemptParseRows(rows, rawText) {
  const basis = detectBasisAndServing(rows);

  const fatRowMatches = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const match = matchTotalFatRow(row.text);
    if (!match) continue;

    // 1. Extract gram candidates after the keyword on this row
    let candidates = extractGramCandidates(row, match.keywordEndIndex, { stopAtNextNutrient: true });
    let matchedLineText = row.text;

    // 2. Adjacent-row recovery for curved / round labels where amount landed on next line
    if (candidates.length === 0 && i + 1 < rows.length) {
      const nextRow = rows[i + 1];
      if (isStandaloneAmountRow(nextRow.text)) {
        candidates = extractGramCandidates(nextRow, 0, { stopAtNextNutrient: true });
        if (candidates.length > 0) {
          matchedLineText = `${row.text} ${nextRow.text}`;
        }
      }
    }

    // 3. Previous-row recovery for round/circular front-of-pack badges ("14.5g" stacked above "FAT")
    if (candidates.length === 0 && i - 1 >= 0) {
      const prevRow = rows[i - 1];
      if (isStandaloneAmountRow(prevRow.text) && /\d\s*(?:g|gr|gm)\b/i.test(prevRow.text)) {
        candidates = extractGramCandidates(prevRow, 0, { stopAtNextNutrient: true });
        if (candidates.length > 0) {
          matchedLineText = `${row.text} ${prevRow.text}`;
        }
      }
    }

    // 4. Curved-jar far-right orphan recovery: look at neighboring rows within +/- 1.8 row heights
    //    that contain ONLY an amount positioned horizontally to the right of this row!
    if (candidates.length === 0 && row.bbox) {
      const medH = row.medianHeight || 20;
      const rowRight = row.bbox.x1;
      let bestOrphan = null;
      let bestDy = Infinity;

      for (let j = Math.max(0, i - 2); j <= Math.min(rows.length - 1, i + 2); j++) {
        if (j === i) continue;
        const other = rows[j];
        if (!other.bbox || !isStandaloneAmountRow(other.text)) continue;
        if (other.bbox.x0 < rowRight - medH) continue; // must be to the right
        const dy = Math.abs(other.yMid - row.yMid);
        if (dy <= medH * 2.2 && dy < bestDy) {
          bestDy = dy;
          bestOrphan = other;
        }
      }

      if (bestOrphan) {
        candidates = extractGramCandidates(bestOrphan, 0, { stopAtNextNutrient: true });
        if (candidates.length > 0) {
          matchedLineText = `${row.text} ${bestOrphan.text}`;
        }
      }
    }

    if (candidates.length === 0) continue;

    fatRowMatches.push({
      row,
      matchedLineText,
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
      explanation: 'Could not find a Total Fat amount on this label.',
      rawText,
    };
  }

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
    const servLabel = basis.servingRaw || `${basis.servingWeightG}g`;
    explanation =
      basis.servingSource === 'net_wt_divided'
        ? `Calculated from ${chosen.value}g fat per estimated ${servLabel} serving (${chosen.value} ÷ ${basis.servingWeightG} × 100)`
        : `Calculated from ${chosen.value}g fat per ${servLabel} serving (${chosen.value} ÷ ${basis.servingWeightG} × 100)`;
  } else {
    status = 'needs_serving';
    mode = 'needs_serving';
    explanation = basis.hasUsPerServingIndicators
      ? `Found ${chosen.value}g fat per serving, but couldn't read the serving weight (g). Enter it below to calculate g / 100g.`
      : `Found ${chosen.value}g fat, but couldn't tell if it's per 100g or per serving.`;
  }

  // Sanity check: fat per 100g cannot physically exceed 100g!
  if (fatPer100g !== null && fatPer100g > 100) {
    if (
      selection.isDirectPer100 &&
      chosen.value > 100 &&
      chosen.value < 1000 &&
      Number.isInteger(chosen.value)
    ) {
      const fixed = round1(chosen.value / 10);
      warning = `OCR read "${chosen.raw}" (> 100g) — likely missing a decimal point. Adjusted to ${fixed}g; please verify.`;
      fatPer100g = fixed;
    } else {
      warning = `Computed ${fatPer100g}g / ${basisUnit}, which exceeds 100g. Please check the fat and serving values below.`;
    }
  }

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
    matchedLine: best.matchedLineText,
    matchedBbox: best.row.bbox,
    warning,
    explanation,
    rawText,
  };
}
