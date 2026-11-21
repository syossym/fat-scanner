/**
 * Client-side Image Processing for Nutrition Label OCR
 *
 * Designed for iOS Safari memory safety and high Tesseract.js v5 accuracy:
 * - Caps working canvas dimensions to stay safely inside iPhone Safari memory limits
 * - Auto-upscales tight crops so characters hit Tesseract LSTM's sweet spot
 * - Percentile contrast stretching + gentle unsharp mask + auto dark-label inversion
 * - Fast O(W*H) integral-image local adaptive thresholding fallback for shadows/glare
 */

const MAX_WORKING_DIM = 1800;
const OCR_PADDING = 24;

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
 * Preprocess a canvas for Tesseract.js OCR.
 *
 * Modes:
 * - 'enhanced': Grayscale + percentile contrast stretch + auto-invert if dark + gentle sharpen + white border
 * - 'adaptive': Local integral-image illumination flattening (great for shadows / glossy curved bottles)
 * - 'inverted': Force inverted enhanced grayscale (great for white text inside a dark box on a bright package)
 *
 * Returns { canvas, scale, padding } so OCR bounding boxes can be mapped back to sourceCanvas coordinates.
 */
export function preprocessForOcr(sourceCanvas, mode = 'enhanced') {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

  // Upscale small tight crops so text has enough pixel height for Tesseract LSTM
  let scale = 1;
  const maxSide = Math.max(srcW, srcH);
  if (maxSide < 900) {
    scale = Math.min(2.2, 1100 / maxSide);
  } else if (maxSide > 1700) {
    scale = 1700 / maxSide;
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
  ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, pad, pad, innerW, innerH);

  // Read inner region only so white padding doesn't skew histograms
  const imgData = ctx.getImageData(pad, pad, innerW, innerH);
  const data = imgData.data;
  const pixelCount = innerW * innerH;
  const gray = new Uint8Array(pixelCount);

  // 1. Convert to grayscale luminance & build histogram
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    gray[p] = lum;
    hist[lum]++;
  }

  // Compute 2nd, 50th (median), and 98th percentile luminance
  const pLowTarget = Math.floor(pixelCount * 0.02);
  const pMedTarget = Math.floor(pixelCount * 0.5);
  const pHighTarget = Math.floor(pixelCount * 0.98);
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

  const autoInvert = mode === 'inverted' || (mode === 'enhanced' && pMed < 112);

  if (mode === 'adaptive') {
    // Integral-image local illumination normalization (Bradley-Roth soft contrast)
    const integral = new Float64Array((innerW + 1) * (innerH + 1));
    const stride = innerW + 1;
    for (let y = 0; y < innerH; y++) {
      let rowSum = 0;
      const srcRow = y * innerW;
      const dstRow = (y + 1) * stride;
      const prevRow = y * stride;
      for (let x = 0; x < innerW; x++) {
        const v = pMed < 112 ? 255 - gray[srcRow + x] : gray[srcRow + x];
        rowSum += v;
        integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      }
    }

    const radius = Math.max(12, Math.min(36, Math.round(Math.min(innerW, innerH) / 24)));
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
        const orig = pMed < 112 ? 255 - gray[srcRow + x] : gray[srcRow + x];
        // Soft local normalization preserving anti-aliased thin strokes & decimals
        const ratio = localMean > 8 ? orig / localMean : 1;
        let outVal;
        if (ratio < 0.84) {
          outVal = Math.max(0, Math.round((ratio / 0.84) * 90));
        } else if (ratio > 0.96) {
          outVal = 255;
        } else {
          outVal = Math.round(90 + ((ratio - 0.84) / 0.12) * 165);
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
  return { canvas, scale, padding: pad };
}

/**
 * Map a Tesseract bounding box from preprocessed OCR canvas back to normalized [0,1] coords on sourceCanvas.
 */
export function mapOcrBboxToNormalized(bbox, preprocessMeta, sourceCanvas) {
  if (!bbox || !preprocessMeta || !sourceCanvas) return null;
  const { scale, padding } = preprocessMeta;
  const padPx = 6;
  const x0 = Math.max(0, (bbox.x0 - padding) / scale - padPx) / sourceCanvas.width;
  const y0 = Math.max(0, (bbox.y0 - padding) / scale - padPx) / sourceCanvas.height;
  const x1 = Math.min(sourceCanvas.width, (bbox.x1 - padding) / scale + padPx) / sourceCanvas.width;
  const y1 = Math.min(sourceCanvas.height, (bbox.y1 - padding) / scale + padPx) / sourceCanvas.height;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
