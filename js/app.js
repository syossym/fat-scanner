import { parseNutritionLabel, classifyFatLevel } from './parser.js';
import {
  loadImageToCanvas,
  rotateCanvas90,
  cropCanvas,
  preprocessForOcr,
  mapOcrBboxToNormalized,
} from './image-processor.js';
import { createSampleLabelCanvas } from './sample-labels.js';

const HISTORY_KEY = 'fat100_recent_scans_v1';
const MAX_HISTORY = 8;

// DOM references
const els = {
  brandResetBtn: document.getElementById('brand-reset-btn'),
  newScanHeaderBtn: document.getElementById('new-scan-header-btn'),
  cameraInput: document.getElementById('camera-input'),
  libraryInput: document.getElementById('library-input'),
  trySampleBtn: document.getElementById('try-sample-btn'),

  homeView: document.getElementById('home-view'),
  scanningView: document.getElementById('scanning-view'),
  resultView: document.getElementById('result-view'),

  historySection: document.getElementById('history-section'),
  historyList: document.getElementById('history-list'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),

  scanningPreviewCanvas: document.getElementById('scanning-preview-canvas'),
  scanStatusText: document.getElementById('scan-status-text'),
  scanPercentText: document.getElementById('scan-percent-text'),
  scanProgressBar: document.getElementById('scan-progress-bar'),
  scanProgressFill: document.getElementById('scan-progress-fill'),

  resultEyebrow: document.getElementById('result-eyebrow'),
  fatLevelTag: document.getElementById('fat-level-tag'),
  resultHeroValue: document.getElementById('result-hero-value'),
  fatPrefix: document.getElementById('fat-prefix'),
  fatNumber: document.getElementById('fat-number'),
  fatUnit: document.getElementById('fat-unit'),
  resultEmptyHero: document.getElementById('result-empty-hero'),
  resultEmptyTitle: document.getElementById('result-empty-title'),
  fatScaleWrap: document.getElementById('fat-scale-wrap'),
  fatScaleMarker: document.getElementById('fat-scale-marker'),
  resultExplanation: document.getElementById('result-explanation'),
  resultWarning: document.getElementById('result-warning'),
  resultWarningText: document.getElementById('result-warning-text'),
  resultMetaStrip: document.getElementById('result-meta-strip'),
  satFatMeta: document.getElementById('sat-fat-meta'),
  matchedLineMeta: document.getElementById('matched-line-meta'),

  toggleAdjustBtn: document.getElementById('toggle-adjust-btn'),
  toggleAdjustLabel: document.getElementById('toggle-adjust-label'),
  saveNoteBtn: document.getElementById('save-note-btn'),
  adjustPanel: document.getElementById('adjust-panel'),
  modePer100Btn: document.getElementById('mode-per100-btn'),
  modeServingBtn: document.getElementById('mode-serving-btn'),
  adjustFields: document.querySelector('.adjust-fields'),
  manualFatLabel: document.getElementById('manual-fat-label'),
  manualFatInput: document.getElementById('manual-fat-input'),
  manualServingGroup: document.getElementById('manual-serving-group'),
  manualServingInput: document.getElementById('manual-serving-input'),

  resultPhotoCanvas: document.getElementById('result-photo-canvas'),
  detectedHighlightBox: document.getElementById('detected-highlight-box'),
  openCropBtn: document.getElementById('open-crop-btn'),
  rotatePhotoBtn: document.getElementById('rotate-photo-btn'),
  rawOcrDetails: document.getElementById('raw-ocr-details'),
  rawOcrText: document.getElementById('raw-ocr-text'),

  cropModal: document.getElementById('crop-modal'),
  cropStage: document.getElementById('crop-stage'),
  cropCanvas: document.getElementById('crop-canvas'),
  cropBox: document.getElementById('crop-box'),
  cropCancelBtn: document.getElementById('crop-cancel-btn'),
  cropApplyBtn: document.getElementById('crop-apply-btn'),
  cropResetBtn: document.getElementById('crop-reset-btn'),
  cropRotateBtn: document.getElementById('crop-rotate-btn'),
};

// Application state
const state = {
  worker: null,
  workerPromise: null,
  ocrBusyPromise: Promise.resolve(),
  scanToken: 0,
  currentScanId: null,
  currentScanLabel: null,
  originalCanvas: null, // Full (possibly rotated) captured photo
  activeCanvas: null,   // Currently scanned (possibly cropped) canvas
  lastParsed: null,
  lastHighlightNorm: null,
  adjustMode: 'per100', // 'per100' | 'serving'
  cropRect: { x: 0.08, y: 0.1, w: 0.84, h: 0.8 },
  cropDrag: null,
};

// ============================================================================
// Initialization & Event Wiring
// ============================================================================

function init() {
  renderHistory();

  els.cameraInput.addEventListener('change', handleFileSelected);
  els.libraryInput.addEventListener('change', handleFileSelected);

  // Support keyboard activation on <label role="button">
  document.querySelectorAll('label[role="button"]').forEach((lbl) => {
    lbl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        lbl.click();
      }
    });
  });

  els.trySampleBtn.addEventListener('click', handleTrySample);
  els.brandResetBtn.addEventListener('click', showHomeView);
  els.newScanHeaderBtn.addEventListener('click', showHomeView);
  els.clearHistoryBtn.addEventListener('click', clearHistory);

  els.toggleAdjustBtn.addEventListener('click', () => {
    const open = els.adjustPanel.classList.contains('hidden');
    setAdjustPanelOpen(open);
  });

  els.modePer100Btn.addEventListener('click', () => setAdjustMode('per100', true));
  els.modeServingBtn.addEventListener('click', () => setAdjustMode('serving', true));

  els.manualFatInput.addEventListener('input', handleManualAdjustInput);
  els.manualServingInput.addEventListener('input', handleManualAdjustInput);

  els.rotatePhotoBtn.addEventListener('click', handleRotateAndRescan);
  els.openCropBtn.addEventListener('click', openCropModal);

  els.cropCancelBtn.addEventListener('click', closeCropModal);
  els.cropApplyBtn.addEventListener('click', applyCropAndScan);
  els.cropResetBtn.addEventListener('click', () => {
    state.cropRect = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
    updateCropBoxStyle();
  });
  els.cropRotateBtn.addEventListener('click', () => {
    if (!state.originalCanvas) return;
    state.originalCanvas = rotateCanvas90(state.originalCanvas);
    drawCanvasToTarget(state.originalCanvas, els.cropCanvas);
    state.cropRect = { x: 0.08, y: 0.1, w: 0.84, h: 0.8 };
    updateCropBoxStyle();
  });

  initCropPointerEvents();
}

// ============================================================================
// View Navigation
// ============================================================================

function switchView(viewName) {
  els.homeView.classList.toggle('hidden', viewName !== 'home');
  els.scanningView.classList.toggle('hidden', viewName !== 'scanning');
  els.resultView.classList.toggle('hidden', viewName !== 'result');
  els.newScanHeaderBtn.classList.toggle('hidden', viewName === 'home');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showHomeView() {
  state.scanToken++;
  renderHistory();
  switchView('home');
}

// ============================================================================
// Photo Capture & Sample Trigger
// ============================================================================

async function handleFileSelected(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  // Reset immediately so re-selecting or retaking triggers change next time
  input.value = '';
  if (!file) return;

  try {
    state.currentScanId = `scan_${Date.now()}`;
    state.currentScanLabel = null;
    switchView('scanning');
    setProgress('Preparing photo…', 6);

    const canvas = await loadImageToCanvas(file);
    state.originalCanvas = canvas;
    state.activeCanvas = canvas;
    state.cropRect = { x: 0.08, y: 0.1, w: 0.84, h: 0.8 };

    await runScanPipeline(canvas);
  } catch (err) {
    renderErrorResult(err?.message || 'Could not open this image. Try taking a fresh photo.');
  }
}

async function handleTrySample() {
  try {
    const sample = createSampleLabelCanvas();
    state.currentScanId = `scan_${Date.now()}`;
    state.currentScanLabel = sample.name;
    state.originalCanvas = sample.canvas;
    state.activeCanvas = sample.canvas;
    state.cropRect = { x: 0.06, y: 0.06, w: 0.88, h: 0.88 };

    switchView('scanning');
    setProgress('Loading sample label…', 8);
    await runScanPipeline(sample.canvas);
  } catch (err) {
    renderErrorResult(err?.message || 'Failed to scan sample label.');
  }
}

async function handleRotateAndRescan() {
  if (!state.originalCanvas) return;
  state.originalCanvas = rotateCanvas90(state.originalCanvas);
  state.activeCanvas = state.originalCanvas;
  switchView('scanning');
  setProgress('Rotating photo…', 8);
  await runScanPipeline(state.activeCanvas);
}

// ============================================================================
// Tesseract.js v5 Worker & Multi-Pass OCR Pipeline
// ============================================================================

function setProgress(label, percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  els.scanStatusText.textContent = label;
  els.scanPercentText.textContent = `${clamped}%`;
  els.scanProgressFill.style.width = `${Math.max(5, clamped)}%`;
  els.scanProgressBar.setAttribute('aria-valuenow', String(clamped));
}

async function ensureTesseractWorker(onProgress) {
  if (state.worker) return state.worker;
  if (state.workerPromise) return state.workerPromise;

  state.workerPromise = (async () => {
    // Wait briefly if defer script is still parsing
    let waitTries = 0;
    while (!window.Tesseract && waitTries < 60) {
      await new Promise((r) => setTimeout(r, 100));
      waitTries++;
    }
    if (!window.Tesseract) {
      throw new Error('OCR engine could not load. Please check your internet connection and reload.');
    }

    const worker = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (onProgress) onProgress(m);
      },
    });
    state.worker = worker;
    return worker;
  })().catch((err) => {
    state.workerPromise = null;
    throw err;
  });

  return state.workerPromise;
}

async function runScanPipeline(targetCanvas) {
  const myToken = ++state.scanToken;
  drawCanvasToTarget(targetCanvas, els.scanningPreviewCanvas);

  let currentPhase = 'init';
  let activePass = 1;

  const handleWorkerLog = (m) => {
    if (myToken !== state.scanToken || !m) return;
    const p = typeof m.progress === 'number' ? m.progress : 0;
    if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
      setProgress('Loading OCR engine (first time)…', 10 + p * 20);
    } else if (m.status === 'loading language traineddata' || m.status === 'initializing api') {
      setProgress('Downloading language model…', 30 + p * 25);
    } else if (m.status === 'recognizing text') {
      if (activePass === 1) {
        setProgress('Reading nutrition values…', 55 + p * 35);
      } else if (activePass === 2) {
        setProgress('Enhancing contrast & re-reading…', 72 + p * 20);
      } else {
        setProgress('Checking dark-label pass…', 85 + p * 12);
      }
    }
  };

  // Serialize OCR calls so we never invoke worker.recognize concurrently
  const runJob = state.ocrBusyPromise.then(async () => {
    if (myToken !== state.scanToken) return null;

    setProgress(state.worker ? 'Enhancing label contrast…' : 'Loading OCR engine…', 14);
    const worker = await ensureTesseractWorker(handleWorkerLog);
    if (myToken !== state.scanToken) return null;

    // Pass 1: Enhanced grayscale + contrast stretch + auto-invert if dark
    activePass = 1;
    currentPhase = 'pass1';
    const prep1 = preprocessForOcr(targetCanvas, 'enhanced');
    setProgress('Reading nutrition values…', 55);
    const res1 = await worker.recognize(
      prep1.canvas,
      {},
      { text: true, blocks: true, tsv: true }
    );
    if (myToken !== state.scanToken) return null;

    let bestParsed = parseNutritionLabel(res1.data);
    let bestPrep = prep1;

    // Pass 2 fallback: Adaptive local illumination normalization (great for shadows/glare)
    if (bestParsed.status === 'not_found') {
      activePass = 2;
      setProgress('Enhancing glare & shadows…', 70);
      const prep2 = preprocessForOcr(targetCanvas, 'adaptive');
      const res2 = await worker.recognize(
        prep2.canvas,
        {},
        { text: true, blocks: true, tsv: true }
      );
      if (myToken !== state.scanToken) return null;

      const parsed2 = parseNutritionLabel(res2.data);
      if (isBetterParse(parsed2, bestParsed)) {
        bestParsed = parsed2;
        bestPrep = prep2;
      }
    }

    // Pass 3 fallback: Forced inversion for white-on-dark nutrition panels on bright packages
    if (bestParsed.status === 'not_found') {
      activePass = 3;
      setProgress('Trying inverted contrast…', 84);
      const prep3 = preprocessForOcr(targetCanvas, 'inverted');
      const res3 = await worker.recognize(
        prep3.canvas,
        {},
        { text: true, blocks: true, tsv: true }
      );
      if (myToken !== state.scanToken) return null;

      const parsed3 = parseNutritionLabel(res3.data);
      if (isBetterParse(parsed3, bestParsed)) {
        bestParsed = parsed3;
        bestPrep = prep3;
      }
    }

    setProgress('Calculating fat per 100g…', 98);
    const highlightNorm = bestParsed.matchedBbox
      ? mapOcrBboxToNormalized(bestParsed.matchedBbox, bestPrep, targetCanvas)
      : null;

    return { parsed: bestParsed, highlightNorm, phase: currentPhase };
  });

  state.ocrBusyPromise = runJob.catch(() => {});

  try {
    const outcome = await runJob;
    if (!outcome || myToken !== state.scanToken) return;

    state.lastParsed = outcome.parsed;
    state.lastHighlightNorm = outcome.highlightNorm;

    renderResultView(outcome.parsed, outcome.highlightNorm);
    if (outcome.parsed.status === 'success' && outcome.parsed.fatPer100g !== null) {
      saveToHistory(outcome.parsed.fatPer100g, outcome.parsed.basisUnit, state.currentScanLabel);
    }
  } catch (err) {
    if (myToken !== state.scanToken) return;
    renderErrorResult(err?.message || 'Scanning failed. Please try again.');
  }
}

function isBetterParse(candidate, current) {
  const rank = { success: 3, needs_serving: 2, not_found: 1 };
  if (rank[candidate.status] !== rank[current.status]) {
    return rank[candidate.status] > rank[current.status];
  }
  return (candidate.rawText || '').length > (current.rawText || '').length;
}

// ============================================================================
// Result View Rendering & Manual Quick Adjust
// ============================================================================

function renderResultView(parsed, highlightNorm) {
  switchView('result');

  // Render captured photo + optional highlight box over detected Fat row
  drawCanvasToTarget(state.activeCanvas, els.resultPhotoCanvas);
  if (highlightNorm) {
    els.detectedHighlightBox.style.left = `${highlightNorm.x * 100}%`;
    els.detectedHighlightBox.style.top = `${highlightNorm.y * 100}%`;
    els.detectedHighlightBox.style.width = `${highlightNorm.w * 100}%`;
    els.detectedHighlightBox.style.height = `${highlightNorm.h * 100}%`;
    els.detectedHighlightBox.classList.remove('hidden');
  } else {
    els.detectedHighlightBox.classList.add('hidden');
  }

  // Raw OCR text inspector
  els.rawOcrDetails.open = false;
  els.rawOcrText.textContent = parsed.rawText || '(No text recognized in this image)';

  // Pre-fill manual adjustment controls cleanly
  if (parsed.mode === 'converted_from_serving' || parsed.status === 'needs_serving') {
    setAdjustMode('serving', false);
    els.manualFatInput.value = parsed.fatRawValue !== null ? String(parsed.fatRawValue) : '';
    els.manualServingInput.value = parsed.servingWeightG !== null ? String(parsed.servingWeightG) : '';
  } else {
    setAdjustMode('per100', false);
    els.manualFatInput.value = parsed.fatPer100g !== null ? String(parsed.fatPer100g) : '';
    els.manualServingInput.value = parsed.servingWeightG !== null ? String(parsed.servingWeightG) : '';
  }

  // Auto-open adjust panel if serving weight is missing, warning exists, or not found
  const shouldAutoOpen =
    parsed.status === 'needs_serving' ||
    parsed.status === 'not_found' ||
    Boolean(parsed.warning);
  setAdjustPanelOpen(shouldAutoOpen);

  applyDisplayMetrics({
    status: parsed.status,
    fatPer100g: parsed.fatPer100g,
    basisUnit: parsed.basisUnit || '100g',
    isLessThan: parsed.isLessThan,
    explanation: parsed.explanation,
    warning: parsed.warning,
    saturatedFatPer100g: parsed.saturatedFatPer100g,
    matchedLine: parsed.matchedLine,
  });

  if (parsed.status === 'needs_serving') {
    setTimeout(() => els.manualServingInput.focus(), 200);
  }
}

function applyDisplayMetrics({
  status,
  fatPer100g,
  basisUnit,
  isLessThan,
  explanation,
  warning,
  saturatedFatPer100g,
  matchedLine,
}) {
  const hasValue = status === 'success' && fatPer100g !== null && !Number.isNaN(fatPer100g);

  els.resultHeroValue.classList.toggle('hidden', !hasValue);
  els.resultEmptyHero.classList.toggle('hidden', hasValue);
  els.fatScaleWrap.classList.toggle('hidden', !hasValue);

  if (hasValue) {
    els.resultEyebrow.textContent = basisUnit === '100ml' ? 'Fat content (liquid)' : 'Fat content';
    els.fatPrefix.classList.toggle('hidden', !isLessThan);
    els.fatNumber.textContent = formatFatNumber(fatPer100g);
    els.fatUnit.textContent = basisUnit === '100ml' ? 'g / 100ml' : 'g / 100g';

    const cls = classifyFatLevel(fatPer100g);
    if (cls) {
      els.fatLevelTag.textContent = cls.label;
      els.fatLevelTag.className = `level-tag level-${cls.level}`;
      els.fatLevelTag.classList.remove('hidden');
    } else {
      els.fatLevelTag.classList.add('hidden');
    }

    const markerPct = mapFatToScalePercent(fatPer100g);
    els.fatScaleMarker.style.left = `${markerPct}%`;
  } else {
    els.resultEyebrow.textContent = status === 'needs_serving' ? 'One detail needed' : 'Scan check';
    els.fatLevelTag.classList.add('hidden');
    els.resultEmptyTitle.textContent =
      status === 'needs_serving'
        ? 'Enter serving size to finish'
        : 'Couldn’t spot the fat value';
  }

  els.resultExplanation.textContent = explanation || '';

  if (warning) {
    els.resultWarningText.textContent = warning;
    els.resultWarning.classList.remove('hidden');
  } else {
    els.resultWarning.classList.add('hidden');
  }

  // Secondary metadata pills (saturated fat + matched OCR line)
  let metaCount = 0;
  if (hasValue && saturatedFatPer100g !== null && saturatedFatPer100g !== undefined) {
    els.satFatMeta.textContent = `Saturates: ${formatFatNumber(saturatedFatPer100g)} g / ${basisUnit}`;
    els.satFatMeta.classList.remove('hidden');
    metaCount++;
  } else {
    els.satFatMeta.classList.add('hidden');
  }

  if (matchedLine) {
    els.matchedLineMeta.textContent = `Matched: “${matchedLine}”`;
    els.matchedLineMeta.classList.remove('hidden');
    metaCount++;
  } else {
    els.matchedLineMeta.classList.add('hidden');
  }

  els.resultMetaStrip.classList.toggle('hidden', metaCount === 0);
}

function renderErrorResult(message) {
  switchView('result');
  if (state.activeCanvas) {
    drawCanvasToTarget(state.activeCanvas, els.resultPhotoCanvas);
  }
  els.detectedHighlightBox.classList.add('hidden');
  els.rawOcrText.textContent = message;
  setAdjustPanelOpen(true);
  applyDisplayMetrics({
    status: 'not_found',
    fatPer100g: null,
    basisUnit: '100g',
    isLessThan: false,
    explanation: message,
    warning: null,
    saturatedFatPer100g: null,
    matchedLine: null,
  });
}

function setAdjustPanelOpen(open) {
  els.adjustPanel.classList.toggle('hidden', !open);
  els.toggleAdjustBtn.setAttribute('aria-expanded', String(open));
  els.toggleAdjustLabel.textContent = open ? 'Hide editor' : 'Adjust numbers';
}

function setAdjustMode(mode, recalculate) {
  state.adjustMode = mode;
  const isServing = mode === 'serving';

  els.modePer100Btn.classList.toggle('active', !isServing);
  els.modePer100Btn.setAttribute('aria-checked', String(!isServing));
  els.modeServingBtn.classList.toggle('active', isServing);
  els.modeServingBtn.setAttribute('aria-checked', String(isServing));

  els.manualServingGroup.classList.toggle('hidden', !isServing);
  els.adjustFields.classList.toggle('two-col', isServing);
  els.manualFatLabel.textContent = isServing ? 'Fat per serving' : 'Fat per 100g';

  if (recalculate) {
    handleManualAdjustInput();
  }
}

function handleManualAdjustInput() {
  const fatVal = parseDecimalInput(els.manualFatInput.value);
  const servingVal = parseDecimalInput(els.manualServingInput.value);
  const basisUnit = state.lastParsed?.basisUnit || '100g';

  if (state.adjustMode === 'per100') {
    if (fatVal === null || fatVal < 0) {
      applyDisplayMetrics({
        status: 'not_found',
        fatPer100g: null,
        basisUnit,
        isLessThan: false,
        explanation: 'Enter the fat value per 100g, or switch to “Per serving” to convert.',
        warning: null,
        saturatedFatPer100g: null,
        matchedLine: state.lastParsed?.matchedLine || null,
      });
      return;
    }

    const rounded = Math.round(fatVal * 10) / 10;
    const warning = rounded > 100 ? 'Value exceeds 100g per 100g — double check decimal placement.' : null;
    applyDisplayMetrics({
      status: 'success',
      fatPer100g: rounded,
      basisUnit,
      isLessThan: false,
      explanation: `Entered directly as ${formatFatNumber(rounded)}g per ${basisUnit}.`,
      warning,
      saturatedFatPer100g: null,
      matchedLine: state.lastParsed?.matchedLine || null,
    });
    if (!warning) {
      saveToHistory(rounded, basisUnit, state.currentScanLabel);
    }
  } else {
    if (fatVal === null || fatVal < 0 || servingVal === null || servingVal <= 0) {
      applyDisplayMetrics({
        status: 'needs_serving',
        fatPer100g: null,
        basisUnit: '100g',
        isLessThan: false,
        explanation:
          fatVal !== null
            ? `Got ${fatVal}g fat — enter the serving weight in grams to calculate g / 100g.`
            : 'Enter both fat per serving and serving weight in grams.',
        warning: null,
        saturatedFatPer100g: null,
        matchedLine: state.lastParsed?.matchedLine || null,
      });
      return;
    }

    const computed = Math.round((fatVal / servingVal) * 1000) / 10;
    const warning =
      computed > 100
        ? `Fat (${fatVal}g) is larger than serving weight (${servingVal}g). Check both numbers.`
        : null;

    applyDisplayMetrics({
      status: 'success',
      fatPer100g: computed,
      basisUnit: '100g',
      isLessThan: false,
      explanation: `Calculated from ${fatVal}g fat per ${servingVal}g serving (${fatVal} ÷ ${servingVal} × 100).`,
      warning,
      saturatedFatPer100g: null,
      matchedLine: state.lastParsed?.matchedLine || null,
    });
    if (!warning) {
      saveToHistory(computed, '100g', state.currentScanLabel);
    }
  }
}

// ============================================================================
// Interactive Touch-Friendly Cropper Modal
// ============================================================================

function openCropModal() {
  if (!state.originalCanvas) return;
  drawCanvasToTarget(state.originalCanvas, els.cropCanvas);
  els.cropModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(updateCropBoxStyle);
}

function closeCropModal() {
  els.cropModal.classList.add('hidden');
  document.body.style.overflow = '';
  state.cropDrag = null;
}

async function applyCropAndScan() {
  if (!state.originalCanvas) return;
  const cropped = cropCanvas(state.originalCanvas, state.cropRect);
  state.activeCanvas = cropped;
  closeCropModal();
  switchView('scanning');
  setProgress('Cropping nutrition table…', 10);
  await runScanPipeline(cropped);
}

function updateCropBoxStyle() {
  const { x, y, w, h } = state.cropRect;
  els.cropBox.style.left = `${x * 100}%`;
  els.cropBox.style.top = `${y * 100}%`;
  els.cropBox.style.width = `${w * 100}%`;
  els.cropBox.style.height = `${h * 100}%`;
}

function initCropPointerEvents() {
  const MIN_SIZE = 0.14;

  els.cropBox.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const handle = e.target.dataset?.handle || 'move';
    const stageRect = els.cropStage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;

    state.cropDrag = {
      handle,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      stageW: stageRect.width,
      stageH: stageRect.height,
      orig: { ...state.cropRect },
    };
    els.cropBox.setPointerCapture(e.pointerId);
  });

  els.cropBox.addEventListener('pointermove', (e) => {
    const drag = state.cropDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();

    const dx = (e.clientX - drag.startX) / drag.stageW;
    const dy = (e.clientY - drag.startY) / drag.stageH;
    let { x, y, w, h } = drag.orig;

    if (drag.handle === 'move') {
      x = clamp(x + dx, 0, 1 - w);
      y = clamp(y + dy, 0, 1 - h);
    } else {
      const right = x + w;
      const bottom = y + h;
      if (drag.handle.includes('w')) {
        x = clamp(x + dx, 0, right - MIN_SIZE);
        w = right - x;
      }
      if (drag.handle.includes('e')) {
        w = clamp(w + dx, MIN_SIZE, 1 - x);
      }
      if (drag.handle.includes('n')) {
        y = clamp(y + dy, 0, bottom - MIN_SIZE);
        h = bottom - y;
      }
      if (drag.handle.includes('s')) {
        h = clamp(h + dy, MIN_SIZE, 1 - y);
      }
    }

    state.cropRect = { x, y, w, h };
    updateCropBoxStyle();
  });

  const endDrag = (e) => {
    if (state.cropDrag && e.pointerId === state.cropDrag.pointerId) {
      state.cropDrag = null;
    }
  };
  els.cropBox.addEventListener('pointerup', endDrag);
  els.cropBox.addEventListener('pointercancel', endDrag);
}

// ============================================================================
// Recent Scans Persistence
// ============================================================================

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveToHistory(fatPer100g, basisUnit, label) {
  try {
    const items = loadHistory();
    const id = state.currentScanId || `scan_${Date.now()}`;
    const existingIdx = items.findIndex((it) => it.id === id);
    const entry = {
      id,
      fatPer100g,
      basisUnit: basisUnit || '100g',
      label: label || `Label scan`,
      timestamp: Date.now(),
    };

    if (existingIdx >= 0) {
      items[existingIdx] = entry;
    } else {
      items.unshift(entry);
    }

    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
  } catch {
    // Ignore storage quota or private-mode restrictions
  }
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  els.historySection.classList.toggle('hidden', items.length === 0);
  if (items.length === 0) return;

  els.historyList.innerHTML = '';
  for (const item of items) {
    const cls = classifyFatLevel(item.fatPer100g) || { level: 'medium', label: '' };
    const li = document.createElement('li');
    li.className = 'history-item';

    const main = document.createElement('div');
    main.className = 'history-item-main';

    const name = document.createElement('span');
    name.className = 'history-item-name';
    name.textContent = item.label || 'Label scan';

    const time = document.createElement('span');
    time.className = 'history-item-time';
    time.textContent = formatRelativeTime(item.timestamp);

    main.append(name, time);

    const badge = document.createElement('span');
    badge.className = `history-item-val level-${cls.level}`;
    badge.innerHTML = `${formatFatNumber(item.fatPer100g)} <small>g/${item.basisUnit || '100g'}</small>`;

    li.append(main, badge);
    els.historyList.appendChild(li);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function drawCanvasToTarget(srcCanvas, dstCanvas) {
  if (!srcCanvas || !dstCanvas) return;
  dstCanvas.width = srcCanvas.width;
  dstCanvas.height = srcCanvas.height;
  const ctx = dstCanvas.getContext('2d');
  ctx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
  ctx.drawImage(srcCanvas, 0, 0);
}

function mapFatToScalePercent(fat) {
  const v = Math.max(0, fat);
  if (v <= 3) {
    return (v / 3) * 10;
  }
  if (v <= 17.5) {
    return 10 + ((v - 3) / 14.5) * 34;
  }
  return Math.min(98, 44 + ((v - 17.5) / 22.5) * 54);
}

function formatFatNumber(n) {
  if (n === null || Number.isNaN(n)) return '—';
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function parseDecimalInput(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(',', '.');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatRelativeTime(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

init();
