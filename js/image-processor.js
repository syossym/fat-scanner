/**
 * Client-side Image Processing for Nutrition Label OCR
 *
 * Designed for iOS Safari memory safety and high Tesseract.js v5 accuracy,
 * including round/circular stickers and cylindrical jars, cans, and bottles:
 * - Caps working canvas dimensions to stay safely inside iPhone Safari memory limits
 * - Center-weighted luminance statistics so dark backgrounds around round labels never trigger false inversion
 * - Auto-upscales tight crops so characters hit Tesseract LSTM's sweet spot
 * - Local illumination flattening ('adaptive') to remove cylindrical shadows & glare bands
 * - Cylindrical edge un-warping ('dewarp') to un-squash compressed numbers near curved bottle/jar edges
 * - Arbitrary-angle deskew rotation for tilted round/circular labels
 */

const MAX_WORKING_DIM = 1800;
const OCR_PADDING = 28;

/**
 * Load a File, Blob, Image, Canvas, or URL into a memory-safe working canvas.
 */
export async function loadImageToCanvas(source, maxDim = MAX_WORKING_DIM) {
  if (source instanceof HTMLCanvasElement) {
    return scaleCanvasIfNeeded(source, maxDim);
  }

  let objectUrl = null;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    if (source instanceof Blob) {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    } else if (typeof source === 'string') {
      img.src = source;
    } else {
      throw new Error('Unsupported image source');
    }

    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not decode this image'));
    });

    if (img.decode) {
      try {
        await img.decode();
      } catch {
        // onload already succeeded
      }
    }

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) throw new Error('Image has zero dimensions');

    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dstW, dstH);
    ctx.drawImage(img, 0, 0, dstW, dstH);
    return canvas;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

function scaleCanvasIfNeeded(src, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (scale >= 1) return src;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Rotate a canvas 90 degrees clockwise.
 */
export function rotateCanvas90(sourceCanvas) {
  const out = document.createElement('canvas');
  out.width = sourceCanvas.height;
  out.height = sourceCanvas.width;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return out;
}

/**
 * Rotate a canvas by an arbitrary angle (in degrees, positive = clockwise)
 * with white background fill, used to deskew tilted round labels.
 */
export function rotateCanvasByAngle(sourceCanvas, angleDeg) {
  if (!angleDeg || Math.abs(angleDeg) < 0.8) return sourceCanvas;
  const rad = (angleDeg * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(rad));
  const absSin = Math.abs(Math.sin(rad));
  const outW = Math.min(
    MAX_WORKING_DIM,
    Math.ceil(sourceCanvas.width * absCos + sourceCanvas.height * absSin)
  );
  const outH = Math.min(
    MAX_WORKING_DIM,
    Math.ceil(sourceCanvas.width * absSin + sourceCanvas.height * absCos)
  );

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return out;
}

/**
 * Estimate clockwise rotation angle (in degrees, -42..+42) needed to make text lines
 * perfectly horizontal, using a fast projection-profile variance search on local-dark ink pixels.
 * Ignores outer dark backgrounds around circular stickers and works even when OCR returns 0 words!
 *
 * Returns { angleDeg, confidence } where confidence = bestScore / zeroAngleScore.
 */
export function estimateSkewAngleFromCanvas(sourceCanvas) {
  const maxSide = 220;
  const scale = Math.min(1, maxSide / Math.max(sourceCanvas.width, sourceCanvas.height));
  const w = Math.max(32, Math.round(sourceCanvas.width * scale));
  const h = Math.max(32, Math.round(sourceCanvas.height * scale));

  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // Grayscale + integral image for fast local mean (isolates ink from dark tabletop corners!)
  const gray = new Uint8Array(w * h);
  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const srcRow = y * w;
    const dstRow = (y + 1) * stride;
    const prevRow = y * stride;
    for (let x = 0; x < w; x++) {
      const i = (srcRow + x) * 4;
      const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      gray[srcRow + x] = lum;
      rowSum += lum;
      integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
    }
  }

  // Collect ink coordinates inside an inner elliptical/central ROI (skip outer borders)
  const radWin = Math.max(6, Math.round(Math.min(w, h) / 18));
  const halfW = w / 2;
  const halfH = h / 2;
  const inkX = [];
  const inkY = [];
  const marginX = Math.floor(w * 0.08);
  const marginY = Math.floor(h * 0.08);

  for (let y = marginY; y < h - marginY; y++) {
    const y1 = Math.max(0, y - radWin);
    const y2 = Math.min(h - 1, y + radWin);
    const rowOff = y * w;
    for (let x = marginX; x < w - marginX; x++) {
      const x1 = Math.max(0, x - radWin);
      const x2 = Math.min(w - 1, x + radWin);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * stride + (x2 + 1)] -
        integral[y1 * stride + (x2 + 1)] -
        integral[(y2 + 1) * stride + x1] +
        integral[y1 * stride + x1];
      const localMean = sum / area;
      const lum = gray[rowOff + x];
      // Crisp dark ink on light paper (ignores uniform dark tabletop outside a circular label!)
      if (localMean > 85 && lum < localMean - 22) {
        inkX.push(x - halfW);
        inkY.push(y - halfH);
      }
    }
  }

  if (inkX.length < 40) {
    return { angleDeg: 0, confidence: 1 };
  }

  const diag = Math.ceil(Math.hypot(w, h));
  const bins = new Uint32Array(diag * 2 + 4);
  const offset = diag + 2;

  const scoreAngle = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    bins.fill(0);
    let minB = offset;
    let maxB = offset;
    for (let i = 0; i < inkX.length; i++) {
      const b = Math.round(inkX[i] * s + inkY[i] * c) + offset;
      bins[b]++;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    let energy = 0;
    for (let b = minB; b <= maxB; b++) {
      const v = bins[b];
      energy += v * v;
    }
    return energy;
  };

  const zeroScore = Math.max(1, scoreAngle(0));
  let bestAngle = 0;
  let bestScore = zeroScore;

  // Coarse search -42..+42 deg in 3-deg steps
  for (let deg = -42; deg <= 42; deg += 3) {
    if (deg === 0) continue;
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestAngle = deg;
    }
  }

  // Fine search around best coarse angle in 0.5-deg steps
  const fineStart = Math.max(-44, bestAngle - 3);
  const fineEnd = Math.min(44, bestAngle + 3);
  for (let deg = fineStart; deg <= fineEnd; deg += 0.5) {
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestAngle = deg;
    }
  }

  const confidence = bestScore / zeroScore;
  if (Math.abs(bestAngle) < 2.0 || confidence < 1.12) {
    return { angleDeg: 0, confidence: 1 };
  }
  return { angleDeg: bestAngle, confidence };
}

/**
 * Horizontally unwrap a cylindrical surface (bottle, jar, can, round tub) so
 * foreshortened gram amounts near the curved left/right edges expand back to
 * natural readable character proportions.
 */
export function unwrapCylinderCanvas(sourceCanvas, halfArcRad = 0.92) {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const sinMax = Math.sin(halfArcRad);
  // Output width expands by halfArcRad / sin(halfArcRad) (~1.16x) to preserve center scale
  const outW = Math.min(MAX_WORKING_DIM, Math.round(srcW * (halfArcRad / sinMax)));
  const outH = srcH;

  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  const outImg = outCtx.createImageData(outW, outH);
  const dst = outImg.data;

  // Precompute horizontal source mapping table (bilinear X interpolation)
  const mapX0 = new Int32Array(outW);
  const mapX1 = new Int32Array(outW);
  const mapFx = new Float32Array(outW);
  const halfSrc = (srcW - 1) / 2;

  for (let x = 0; x < outW; x++) {
    const u = (x / (outW - 1)) * 2 - 1; // [-1, 1] along unwrapped arc
    const uSrc = Math.sin(u * halfArcRad) / sinMax; // [-1, 1] projected on flat photo
    const sx = Math.max(0, Math.min(srcW - 1, (uSrc + 1) * halfSrc));
    const ix0 = Math.floor(sx);
    const ix1 = Math.min(srcW - 1, ix0 + 1);
    mapX0[x] = ix0 * 4;
    mapX1[x] = ix1 * 4;
    mapFx[x] = sx - ix0;
  }

  for (let y = 0; y < outH; y++) {
    const srcRow = y * srcW * 4;
    const dstRow = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const i0 = srcRow + mapX0[x];
      const i1 = srcRow + mapX1[x];
      const fx = mapFx[x];
      const invFx = 1 - fx;
      const di = dstRow + x * 4;
      dst[di] = srcData[i0] * invFx + srcData[i1] * fx;
      dst[di + 1] = srcData[i0 + 1] * invFx + srcData[i1 + 1] * fx;
      dst[di + 2] = srcData[i0 + 2] * invFx + srcData[i1 + 2] * fx;
      dst[di + 3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return out;
}

/**
 * Crop a canvas using normalized coordinates { x, y, w, h } in [0, 1].
 */
export function cropCanvas(sourceCanvas, rectNorm) {
  const sx = Math.max(0, Math.round(rectNorm.x * sourceCanvas.width));
  const sy = Math.max(0, Math.round(rectNorm.y * sourceCanvas.height));
  const sw = Math.max(16, Math.min(sourceCanvas.width - sx, Math.round(rectNorm.w * sourceCanvas.width)));
  const sh = Math.max(16, Math.min(sourceCanvas.height - sy, Math.round(rectNorm.h * sourceCanvas.height)));

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

/**
 * Compute luminance percentiles on the center 55% x 55% ROI so dark backgrounds
 * surrounding a circular sticker or round jar don't trick auto-inversion.
 */
function computeCenterStats(gray, width, height) {
  const xStart = Math.floor(width * 0.22);
  const xEnd = Math.max(xStart + 1, Math.ceil(width * 0.78));
  const yStart = Math.floor(height * 0.22);
  const yEnd = Math.max(yStart + 1, Math.ceil(height * 0.78));

  const hist = new Uint32Array(256);
  let count = 0;
  for (let y = yStart; y < yEnd; y++) {
    const row = y * width;
    for (let x = xStart; x < xEnd; x++) {
      hist[gray[row + x]]++;
      count++;
    }
  }

  const pLowTarget = Math.floor(count * 0.02);
  const pMedTarget = Math.floor(count * 0.5);
  const pHighTarget = Math.floor(count * 0.98);
  let acc = 0;
  let pLow = 0;
  let pMed = 128;
  let pHigh = 255;
  let foundLow = false;
  let foundMed = false;

  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!foundLow && acc >= pLowTarget) {
      pLow = v;
      foundLow = true;
    }
    if (!foundMed && acc >= pMedTarget) {
      pMed = v;
      foundMed = true;
    }
    if (acc >= pHighTarget) {
      pHigh = v;
      break;
    }
  }

  return { pLow, pMed, pHigh };
}

/**
 * Preprocess a canvas for Tesseract.js OCR.
 *
 * Modes:
 * - 'enhanced': Grayscale + center-weighted contrast stretch + safe auto-invert + gentle sharpen + white border
 * - 'adaptive': Local integral-image illumination flattening (erases cylindrical shadows & glare gradients)
 * - 'dewarp':   Cylindrical horizontal un-warp + local illumination flattening (best for round jars/cans/bottles)
 * - 'inverted': Force inverted enhanced grayscale (great for white text inside a dark box on bright packaging)
 *
 * Returns { canvas, scale, padding, isTransformed } so OCR bounding boxes map cleanly back to sourceCanvas.
 */
export function preprocessForOcr(sourceCanvas, mode = 'enhanced') {
  const baseCanvas = mode === 'dewarp' ? unwrapCylinderCanvas(sourceCanvas) : sourceCanvas;
  const srcW = baseCanvas.width;
  const srcH = baseCanvas.height;

  // Upscale small tight crops so text has enough pixel height for Tesseract LSTM
  let scale = 1;
  const maxSide = Math.max(srcW, srcH);
  if (maxSide < 950) {
    scale = Math.min(2.2, 1150 / maxSide);
  } else if (maxSide > 1750) {
    scale = 1750 / maxSide;
  }

  const innerW = Math.max(1, Math.round(srcW * scale));
  const innerH = Math.max(1, Math.round(srcH * scale));
  const pad = OCR_PADDING;

  const canvas = document.createElement('canvas');
  canvas.width = innerW + pad * 2;
  canvas.height = innerH + pad * 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(baseCanvas, 0, 0, srcW, srcH, pad, pad, innerW, innerH);

  // Read inner region only so white padding doesn't skew histograms
  const imgData = ctx.getImageData(pad, pad, innerW, innerH);
  const data = imgData.data;
  const pixelCount = innerW * innerH;
  const gray = new Uint8Array(pixelCount);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }

  const { pLow, pMed, pHigh } = computeCenterStats(gray, innerW, innerH);
  const autoInvert = mode === 'inverted' || (mode === 'enhanced' && pMed < 92);

  if (mode === 'adaptive' || mode === 'dewarp') {
    const invertForLocal = pMed < 92;
    // Integral-image local illumination normalization (flattens cylindrical falloff & glare)
    const stride = innerW + 1;
    const integral = new Float64Array(stride * (innerH + 1));
    for (let y = 0; y < innerH; y++) {
      let rowSum = 0;
      const srcRow = y * innerW;
      const dstRow = (y + 1) * stride;
      const prevRow = y * stride;
      for (let x = 0; x < innerW; x++) {
        const v = invertForLocal ? 255 - gray[srcRow + x] : gray[srcRow + x];
        rowSum += v;
        integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      }
    }

    const radius = Math.max(14, Math.min(42, Math.round(Math.min(innerW, innerH) / 22)));
    for (let y = 0; y < innerH; y++) {
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(innerH - 1, y + radius);
      const srcRow = y * innerW;
      for (let x = 0; x < innerW; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(innerW - 1, x + radius);
        const area = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum =
          integral[(y2 + 1) * stride + (x2 + 1)] -
          integral[y1 * stride + (x2 + 1)] -
          integral[(y2 + 1) * stride + x1] +
          integral[y1 * stride + x1];
        const localMean = sum / area;
        const orig = invertForLocal ? 255 - gray[srcRow + x] : gray[srcRow + x];

        // Soft local normalization preserving anti-aliased thin strokes & decimals
        const ratio = localMean > 8 ? orig / localMean : 1;
        let outVal;
        if (ratio < 0.82) {
          outVal = Math.max(0, Math.round((ratio / 0.82) * 85));
        } else if (ratio > 0.96) {
          outVal = 255;
        } else {
          outVal = Math.round(85 + ((ratio - 0.82) / 0.14) * 170);
        }
        const idx = (srcRow + x) * 4;
        data[idx] = outVal;
        data[idx + 1] = outVal;
        data[idx + 2] = outVal;
        data[idx + 3] = 255;
      }
    }
  } else {
    // Linear contrast stretch + optional inversion
    const span = Math.max(24, pHigh - pLow);
    const stretched = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      let norm = ((gray[p] - pLow) * 255) / span;
      if (norm < 0) norm = 0;
      else if (norm > 255) norm = 255;
      if (autoInvert) norm = 255 - norm;
      stretched[p] = norm;
    }

    // Gentle 3x3 unsharp mask to crisp up printed nutrition text
    const amount = 0.55;
    for (let y = 0; y < innerH; y++) {
      const rowOff = y * innerW;
      for (let x = 0; x < innerW; x++) {
        const p = rowOff + x;
        let val = stretched[p];
        if (x > 0 && x < innerW - 1 && y > 0 && y < innerH - 1) {
          const blur =
            (stretched[p - innerW - 1] +
              stretched[p - innerW] * 2 +
              stretched[p - innerW + 1] +
              stretched[p - 1] * 2 +
              val * 4 +
              stretched[p + 1] * 2 +
              stretched[p + innerW - 1] +
              stretched[p + innerW] * 2 +
              stretched[p + innerW + 1]) >>
            4;
          val = val + (val - blur) * amount;
          if (val < 0) val = 0;
          else if (val > 255) val = 255;
        }
        const idx = p * 4;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, pad, pad);
  return {
    canvas,
    scale,
    padding: pad,
    isTransformed: mode === 'dewarp',
  };
}

/**
 * Map a Tesseract bounding box from preprocessed OCR canvas back to normalized [0,1] coords on sourceCanvas.
 */
export function mapOcrBboxToNormalized(bbox, preprocessMeta, sourceCanvas) {
  if (!bbox || !preprocessMeta || !sourceCanvas || preprocessMeta.isTransformed) return null;
  const { scale, padding } = preprocessMeta;
  const padPx = 6;
  const x0 = Math.max(0, (bbox.x0 - padding) / scale - padPx) / sourceCanvas.width;
  const y0 = Math.max(0, (bbox.y0 - padding) / scale - padPx) / sourceCanvas.height;
  const x1 = Math.min(sourceCanvas.width, (bbox.x1 - padding) / scale + padPx) / sourceCanvas.width;
  const y1 = Math.min(sourceCanvas.height, (bbox.y1 - padding) / scale + padPx) / sourceCanvas.height;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
