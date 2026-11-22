import { logger, APP_VERSION } from './logger.js?v=3';
import { parseNutritionLabel, combineScanPasses, classifyFatLevel } from './parser.js?v=3';
import {
  loadImageToCanvas,
  rotateCanvas90,
  rotateCanvasByAngle,
  estimateSkewAngleFromCanvas,
  cropCanvas,
  preprocessForOcr,
  mapOcrBboxToNormalized,
  releaseCanvas,
} from './image-processor.js?v=3';
import { createSampleLabelCanvas } from './sample-labels.js?v=3';

window.__fat100LoggerReady = true;

const HISTORY_KEY = 'fat100_recent_scans_v1';
const MAX_HISTORY = 8;
const OCR_PASS_TIMEOUT_MS = 35000;
const THUMB_MAX_DIM = 900;

// DOM references
const els = {
  brandResetBtn: document.getElementById('brand-reset-btn'),
  newScanHeaderBtn: document.getElementById('new-scan-header-btn'),
  openSettingsBtn: document.getElementById('open-settings-btn'),
  settingsErrDot: document.getElementById('settings-err-dot'),
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
  servingMeta: document.getElementById('serving-meta'),
  satFatMeta: document.getElementById('sat-fat-meta'),
  matchedLineMeta: document.getElementById('matched-line-meta'),

  toggleAdjustBtn: document.getElementById('toggle-adjust-btn'),
  toggleAdjustLabel: document.getElementById('toggle-adjust-label'),
  viewLogShortcutBtn: document.getElementById('view-log-shortcut-btn'),
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

  // Settings & Technical Log modal
  settingsModal: document.getElementById('settings-modal'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  diagVersion: document.getElementById('diag-version'),
  diagTesseract: document.getElementById('diag-tesseract'),
  diagWorker: document.getElementById('diag-worker'),
  resetWorkerBtn: document.getElementById('reset-worker-btn'),
  settingsClearHistoryBtn: document.getElementById('settings-clear-history-btn'),
  logFilterAllBtn: document.getElementById('log-filter-all-btn'),
  logFilterErrBtn: document.getElementById('log-filter-err-btn'),
  logCountLabel: document.getElementById('log-count-label'),
  copyLogBtn: document.getElementById('copy-log-btn'),
  clearLogBtn: document.getElementById('clear-log-btn'),
  techLogViewer: document.getElementById('tech-log-viewer'),
};

// Application state
const state = {
  worker: null,
  workerPromise: null,
  workerStatus: 'Idle',
  onWorkerLog: null,
  ocrBusyPromise: Promise.resolve(),
  scanToken: 0,
  currentScanId: null,
  currentScanLabel: null,
  originalCanvas: null,
  activeCanvas: null,
  lastParsed: null,
  lastHighlightNorm: null,
  adjustMode: 'per100',
  cropRect: { x: 0.08, y: 0.1, w: 0.84, h: 0.8 },
  cropDrag: null,
  logFilter: 'all', // 'all' | 'errors'
  settingsOpen: false,
};

// ============================================================================
// Initialization & Event Wiring
// ============================================================================

function init() {
  logger.info('INIT', `Fat100 ${APP_VERSION} initialized`, {
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    tesseractGlobal: Boolean(window.Tesseract),
  });

  renderHistory();
  initSettingsModal();

  els.cameraInput?.addEventListener('change', handleFileSelected);
  els.libraryInput?.addEventListener('change', handleFileSelected);

  document.querySelectorAll('label[role="button"]').forEach((lbl) => {
    lbl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        lbl.click();
      }
    });
  });

  els.trySampleBtn?.addEventListener('click', handleTrySample);
  els.brandResetBtn?.addEventListener('click', showHomeView);
  els.newScanHeaderBtn?.addEventListener('click', showHomeView);
  els.clearHistoryBtn?.addEventListener('click', clearHistory);

  els.toggleAdjustBtn?.addEventListener('click', () => {
    const open = els.adjustPanel?.classList.contains('hidden');
    setAdjustPanelOpen(Boolean(open));
  });
  els.viewLogShortcutBtn?.addEventListener('click', openSettingsModal);

  els.modePer100Btn?.addEventListener('click', () => setAdjustMode('per100', true));
  els.modeServingBtn?.addEventListener('click', () => setAdjustMode('serving', true));

  els.manualFatInput?.addEventListener('input', handleManualAdjustInput);
  els.manualServingInput?.addEventListener('input', handleManualAdjustInput);

  els.rotatePhotoBtn?.addEventListener('click', handleRotateAndRescan);
  els.openCropBtn?.addEventListener('click', openCropModal);

  els.cropCancelBtn?.addEventListener('click', closeCropModal);
  els.cropApplyBtn?.addEventListener('click', applyCropAndScan);
  els.cropResetBtn?.addEventListener('click', () => {
    state.cropRect = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
    updateCropBoxStyle();
  });
  els.cropRotateBtn?.addEventListener('click', () => {
    if (!state.originalCanvas) return;
    const prev = state.originalCanvas;
    state.originalCanvas = rotateCanvas90(prev);
    if (prev !== state.activeCanvas) releaseCanvas(prev);
    drawCanvasToTarget(state.originalCanvas, els.cropCanvas, THUMB_MAX_DIM);
    state.cropRect = { x: 0.08, y: 0.1, w: 0.84, h: 0.8 };
    updateCropBoxStyle();
  });

  initCropPointerEvents();
}

// ============================================================================
// Settings & Technical Log Modal
// ============================================================================

function initSettingsModal() {
  if (els.diagVersion) els.diagVersion.textContent = APP_VERSION;

  els.openSettingsBtn?.addEventListener('click', openSettingsModal);
  els.settingsCloseBtn?.addEventListener('click', closeSettingsModal);
  els.settingsModal?.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettingsModal();
  });

  els.resetWorkerBtn?.addEventListener('click', async () => {
    logger.info('SETTINGS', 'User requested OCR engine reset');
    await resetTesseractWorker();
    updateDiagnosticsStatus();
  });

  els.settingsClearHistoryBtn?.addEventListener('click', () => {
    clearHistory();
    logger.info('SETTINGS', 'Cleared scan history');
  });

  els.logFilterAllBtn?.addEventListener('click', () => {
    state.logFilter = 'all';
    els.logFilterAllBtn?.classList.add('active');
    els.logFilterAllBtn?.setAttribute('aria-selected', 'true');
    els.logFilterErrBtn?.classList.remove('active');
    els.logFilterErrBtn?.setAttribute('aria-selected', 'false');
    renderTechnicalLog();
  });

  els.logFilterErrBtn?.addEventListener('click', () => {
    state.logFilter = 'errors';
    els.logFilterErrBtn?.classList.add('active');
    els.logFilterErrBtn?.setAttribute('aria-selected', 'true');
    els.logFilterAllBtn?.classList.remove('active');
    els.logFilterAllBtn?.setAttribute('aria-selected', 'false');
    renderTechnicalLog();
  });

  els.clearLogBtn?.addEventListener('click', () => {
    logger.clear();
    logger.info('LOG', 'Technical log cleared');
    updateErrorDot();
  });

  els.copyLogBtn?.addEventListener('click', handleCopyLog);

  logger.subscribe(() => {
    updateErrorDot();
    if (state.settingsOpen) {
      updateDiagnosticsStatus();
      renderTechnicalLog();
    }
  });

  updateErrorDot();
}

function openSettingsModal() {
  state.settingsOpen = true;
  updateDiagnosticsStatus();
  els.settingsModal?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderTechnicalLog();
}

function closeSettingsModal() {
  state.settingsOpen = false;
  els.settingsModal?.classList.add('hidden');
  document.body.style.overflow = '';
}

function updateDiagnosticsStatus() {
  if (els.diagVersion) els.diagVersion.textContent = APP_VERSION;
  if (els.diagTesseract) {
    els.diagTesseract.textContent = window.Tesseract ? 'Loaded (v5)' : 'Not loaded';
  }
  if (els.diagWorker) {
    els.diagWorker.textContent = state.workerStatus;
  }
}

function updateErrorDot() {
  const hasErr = logger.getEntries().some((e) => e.level === 'ERR');
  els.settingsErrDot?.classList.toggle('hidden', !hasErr);
}

function renderTechnicalLog() {
  const viewer = els.techLogViewer;
  if (!viewer) return;

  const all = logger.getEntries();
  const filtered =
    state.logFilter === 'errors'
      ? all.filter((e) => e.level === 'ERR' || e.level === 'WARN')
      : all;

  if (els.logCountLabel) {
    const errCount = all.filter((e) => e.level === 'ERR').length;
    els.logCountLabel.textContent =
      errCount > 0
        ? `${filtered.length} entries (${errCount} err)`
        : `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`;
  }

  viewer.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent =
      state.logFilter === 'errors' ? 'No errors or warnings recorded.' : 'No log entries yet.';
    viewer.appendChild(empty);
    return;
  }

  // Show newest at bottom (console order) and scroll to latest
  const frag = document.createDocumentFragment();
  for (const entry of filtered) {
    const row = document.createElement('div');
    row.className = 'log-entry';

    const head = document.createElement('div');
    head.className = 'log-entry-head';

    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = logger.formatTimestamp(entry.ts);

    const lvl = document.createElement('span');
    lvl.className = `log-lvl log-lvl-${entry.level}`;
    lvl.textContent = entry.level;

    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = entry.tag;

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = entry.message;

    head.append(ts, lvl, tag, msg);
    row.appendChild(head);

    if (entry.detail) {
      const det = document.createElement('div');
      det.className = 'log-detail';
      det.textContent = entry.detail;
      row.appendChild(det);
    }

    frag.appendChild(row);
  }
  viewer.appendChild(frag);
  viewer.scrollTop = viewer.scrollHeight;
}

async function handleCopyLog() {
  const dump = logger.formatForExport({
    TesseractLoaded: Boolean(window.Tesseract),
    WorkerStatus: state.workerStatus,
  });

  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(dump);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    try {
      const ta = document.createElement('textarea');
      ta.value = dump;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, dump.length);
      copied = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      copied = false;
    }
  }

  if (els.copyLogBtn) {
    const orig = els.copyLogBtn.textContent;
    els.copyLogBtn.textContent = copied ? 'Copied!' : 'Copy failed';
    setTimeout(() => {
      if (els.copyLogBtn) els.copyLogBtn.textContent = orig;
    }, 1600);
  }
}

// ============================================================================
// View Navigation
// ============================================================================

function switchView(viewName) {
  els.homeView?.classList.toggle('hidden', viewName !== 'home');
  els.scanningView?.classList.toggle('hidden', viewName !== 'scanning');
  els.resultView?.classList.toggle('hidden', viewName !== 'result');
  els.newScanHeaderBtn?.classList.toggle('hidden', viewName === 'home');
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

function replaceWorkingCanvases(newOriginal, newActive) {
  if (state.originalCanvas && state.originalCanvas !== newOriginal && state.originalCanvas !== newActive) {
    releaseCanvas(state.originalCanvas);
  }
  if (state.activeCanvas && state.activeCanvas !== state.originalCanvas && state.activeCanvas !== newActive) {
    releaseCanvas(state.activeCanvas);
  }
  state.originalCanvas = newOriginal;
  state.activeCanvas = newActive;
}

async function handleFileSelected(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  logger.info('INPUT', `Photo selected (${input.id})`, {
    name: file.name || '(unnamed)',
    type: file.type || '(unknown)',
    sizeKB: Math.round(file.size / 1024),
  });

  try {
    state.currentScanId = `scan_${Date.now()}`;
    state.currentScanLabel = null;
    switchView('scanning');
    setProgress('Preparing photo…', 6);

    const t0 = performance.now();
    const canvas = await loadImageToCanvas(file);
    logger.info('IMAGE', `Decoded image to ${canvas.width}x${canvas.height} in ${Math.round(performance.now() - t0)}ms`);

    replaceWorkingCanvases(canvas, canvas);
    state.cropRect = { x: 0.08, y: 0.1, w: 0.84, h: 0.8 };

    await runScanPipeline(canvas);
  } catch (err) {
    logger.error('IMAGE', 'Failed to decode selected image', err);
    renderErrorResult(err?.message || 'Could not open this image. Try taking a fresh photo.');
  }
}

async function handleTrySample() {
  try {
    const sample = createSampleLabelCanvas();
    logger.info('SAMPLE', `Loaded ${sample.name} (${sample.canvas.width}x${sample.canvas.height})`);
    state.currentScanId = `scan_${Date.now()}`;
    state.currentScanLabel = sample.name;
    replaceWorkingCanvases(sample.canvas, sample.canvas);
    state.cropRect = { x: 0.06, y: 0.06, w: 0.88, h: 0.88 };

    switchView('scanning');
    setProgress('Loading sample label…', 8);
    await runScanPipeline(sample.canvas);
  } catch (err) {
    logger.error('SAMPLE', 'Sample scan failed', err);
    renderErrorResult(err?.message || 'Failed to scan sample label.');
  }
}

async function handleRotateAndRescan() {
  if (!state.originalCanvas) return;
  logger.info('IMAGE', 'User rotated photo 90° clockwise');
  const rotated = rotateCanvas90(state.originalCanvas);
  replaceWorkingCanvases(rotated, rotated);
  switchView('scanning');
  setProgress('Rotating photo…', 8);
  await runScanPipeline(state.activeCanvas);
}

// ============================================================================
// Tesseract.js v5 Worker & Multi-Pass OCR Pipeline (Flat + Round/Curved Labels)
// ============================================================================

function setProgress(label, percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (els.scanStatusText) els.scanStatusText.textContent = label;
  if (els.scanPercentText) els.scanPercentText.textContent = `${clamped}%`;
  if (els.scanProgressFill) els.scanProgressFill.style.width = `${Math.max(5, clamped)}%`;
  els.scanProgressBar?.setAttribute('aria-valuenow', String(clamped));
}

async function resetTesseractWorker() {
  const oldWorker = state.worker;
  state.worker = null;
  state.workerPromise = null;
  state.workerStatus = 'Idle';
  if (oldWorker) {
    try {
      await oldWorker.terminate();
      logger.info('OCR', 'Terminated previous Tesseract worker');
    } catch (err) {
      logger.warn('OCR', 'Worker terminate warning', err);
    }
  }
}

async function ensureTesseractWorker() {
  if (state.worker) return state.worker;
  if (state.workerPromise) return state.workerPromise;

  state.workerStatus = 'Loading…';
  updateDiagnosticsStatus();

  state.workerPromise = (async () => {
    const t0 = performance.now();
    let waitTries = 0;
    while (!window.Tesseract && waitTries < 80) {
      await new Promise((r) => setTimeout(r, 100));
      waitTries++;
    }
    if (!window.Tesseract) {
      state.workerStatus = 'Error (library missing)';
      throw new Error('OCR engine script did not load. Check internet access or open Settings → Technical log.');
    }

    logger.ocr('OCR', 'Creating Tesseract.js v5 worker (eng)');
    const worker = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (state.onWorkerLog) state.onWorkerLog(m);
      },
    });
    state.worker = worker;
    state.workerStatus = 'Ready';
    logger.ocr('OCR', `Tesseract worker ready in ${Math.round(performance.now() - t0)}ms`);
    updateDiagnosticsStatus();
    return worker;
  })().catch((err) => {
    state.workerPromise = null;
    state.worker = null;
    state.workerStatus = 'Error';
    logger.error('OCR', 'Failed to initialize Tesseract worker', err);
    updateDiagnosticsStatus();
    throw err;
  });

  return state.workerPromise;
}

async function recognizeWithTimeout(worker, canvas, passName) {
  const t0 = performance.now();
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`OCR timed out during ${passName} after ${OCR_PASS_TIMEOUT_MS / 1000}s`));
    }, OCR_PASS_TIMEOUT_MS);
  });

  try {
    const res = await Promise.race([
      worker.recognize(canvas, {}, { text: true, blocks: true, tsv: true }),
      timeoutPromise,
    ]);
    clearTimeout(timerId);
    const ms = Math.round(performance.now() - t0);
    const textLen = (res?.data?.text || '').trim().length;
    const wordCount = Array.isArray(res?.data?.words) ? res.data.words.length : 0;
    logger.ocr('OCR', `${passName} finished in ${ms}ms (${textLen} chars, ${wordCount} words)`);
    return res;
  } catch (err) {
    clearTimeout(timerId);
    logger.error('OCR', `${passName} failed — resetting worker`, err);
    await resetTesseractWorker();
    throw err;
  }
}

function isCleanSuccess(parsed) {
  return parsed && parsed.status === 'success' && !parsed.warning;
}

function summarizeParse(parsed) {
  return {
    status: parsed.status,
    fatPer100g: parsed.fatPer100g,
    fatRaw: parsed.fatRawValue,
    servingG: parsed.servingWeightG,
    mode: parsed.mode,
    matched: parsed.matchedLine,
    warning: parsed.warning || undefined,
  };
}

async function runScanPipeline(targetCanvas) {
  const myToken = ++state.scanToken;
  drawCanvasToTarget(targetCanvas, els.scanningPreviewCanvas, THUMB_MAX_DIM);

  let activePass = 1;
  let lastLoggedStatus = '';

  state.onWorkerLog = (m) => {
    if (myToken !== state.scanToken || !m) return;
    const p = typeof m.progress === 'number' ? m.progress : 0;
    if (m.status && m.status !== lastLoggedStatus && m.status !== 'recognizing text') {
      lastLoggedStatus = m.status;
      logger.ocr('WORKER', m.status);
    }
    if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
      setProgress('Loading OCR engine (first time)…', 10 + p * 18);
    } else if (m.status === 'loading language traineddata' || m.status === 'initializing api') {
      setProgress('Downloading language model…', 28 + p * 22);
    } else if (m.status === 'recognizing text') {
      if (activePass === 1) {
        setProgress('Reading nutrition values…', 50 + p * 25);
      } else if (activePass === 2) {
        setProgress('Flattening shadows & glare…', 75 + p * 10);
      } else if (activePass === 3) {
        setProgress('Un-warping curved label edges…', 85 + p * 8);
      } else {
        setProgress('Checking inverted contrast…', 93 + p * 5);
      }
    }
  };

  const runJob = state.ocrBusyPromise.then(async () => {
    if (myToken !== state.scanToken) return null;

    setProgress(state.worker ? 'Enhancing label contrast…' : 'Loading OCR engine…', 14);
    const worker = await ensureTesseractWorker();
    if (myToken !== state.scanToken) return null;

    // Fast pixel-based auto-deskew check for tilted round/circular labels
    const tSkew = performance.now();
    const pixelSkew = estimateSkewAngleFromCanvas(targetCanvas);
    const didPixelDeskew = Math.abs(pixelSkew.angleDeg) >= 3.0 && pixelSkew.confidence >= 1.2;
    logger.ocr(
      'SKEW',
      `Estimated tilt ${pixelSkew.angleDeg.toFixed(1)}° (conf ${pixelSkew.confidence.toFixed(2)}, applied=${didPixelDeskew}) in ${Math.round(performance.now() - tSkew)}ms`
    );

    const baseCanvas = didPixelDeskew
      ? rotateCanvasByAngle(targetCanvas, pixelSkew.angleDeg)
      : targetCanvas;

    let bestParsed = null;
    let bestPrepMeta = null;
    let bestCanvasForHighlight = null;

    try {
      // Pass 1: Center-weighted enhanced grayscale
      activePass = 1;
      const prep1 = preprocessForOcr(baseCanvas, 'enhanced');
      const prep1Meta = { scale: prep1.scale, padding: prep1.padding, isTransformed: prep1.isTransformed };
      setProgress('Reading nutrition values…', 50);
      let res1;
      try {
        res1 = await recognizeWithTimeout(worker, prep1.canvas, 'Pass 1 (enhanced)');
      } finally {
        releaseCanvas(prep1.canvas);
      }
      if (myToken !== state.scanToken) return null;

      bestParsed = parseNutritionLabel(res1.data);
      bestPrepMeta = prep1Meta;
      bestCanvasForHighlight = didPixelDeskew ? null : targetCanvas;
      logger.ocr('PARSE', 'Pass 1 result', summarizeParse(bestParsed));
      const detectedTilt = bestParsed.tiltAngleDeg || 0;

      // Pass 2: Local illumination flattening (shadows/glare on curved bottles & jars)
      if (!isCleanSuccess(bestParsed)) {
        activePass = 2;
        setProgress('Flattening shadows & glare…', 74);
        const needOcrDeskew = !didPixelDeskew && Math.abs(detectedTilt) >= 2.5;
        const pass2Canvas = needOcrDeskew ? rotateCanvasByAngle(targetCanvas, -detectedTilt) : baseCanvas;
        const prep2 = preprocessForOcr(pass2Canvas, 'adaptive');
        const prep2Meta = { scale: prep2.scale, padding: prep2.padding, isTransformed: prep2.isTransformed };
        if (needOcrDeskew) releaseCanvas(pass2Canvas);

        let res2;
        try {
          res2 = await recognizeWithTimeout(worker, prep2.canvas, 'Pass 2 (adaptive)');
        } finally {
          releaseCanvas(prep2.canvas);
        }
        if (myToken !== state.scanToken) return null;

        const parsed2 = parseNutritionLabel(res2.data);
        logger.ocr('PARSE', 'Pass 2 result', summarizeParse(parsed2));
        const prevBest = bestParsed;
        bestParsed = combineScanPasses(bestParsed, parsed2);
        if (bestParsed === parsed2) {
          bestPrepMeta = prep2Meta;
          bestCanvasForHighlight = !needOcrDeskew && !didPixelDeskew ? targetCanvas : null;
        } else if (bestParsed !== prevBest) {
          logger.ocr('MERGE', 'Merged Pass 1 + Pass 2 complementary findings', summarizeParse(bestParsed));
        }
      }

      // Pass 3: Cylindrical horizontal edge un-warp (round jars, cans, bottles)
      if (!isCleanSuccess(bestParsed)) {
        activePass = 3;
        setProgress('Un-warping curved label edges…', 84);
        const needOcrDeskew = !didPixelDeskew && Math.abs(detectedTilt) >= 2.5;
        const pass3Canvas = needOcrDeskew ? rotateCanvasByAngle(targetCanvas, -detectedTilt) : baseCanvas;
        const prep3 = preprocessForOcr(pass3Canvas, 'dewarp');
        if (needOcrDeskew) releaseCanvas(pass3Canvas);

        let res3;
        try {
          res3 = await recognizeWithTimeout(worker, prep3.canvas, 'Pass 3 (cylindrical dewarp)');
        } finally {
          releaseCanvas(prep3.canvas);
        }
        if (myToken !== state.scanToken) return null;

        const parsed3 = parseNutritionLabel(res3.data);
        logger.ocr('PARSE', 'Pass 3 result', summarizeParse(parsed3));
        const prevBest = bestParsed;
        bestParsed = combineScanPasses(bestParsed, parsed3);
        if (bestParsed === parsed3) {
          bestPrepMeta = null;
          bestCanvasForHighlight = null;
        } else if (bestParsed !== prevBest) {
          logger.ocr('MERGE', 'Merged Pass 3 complementary findings', summarizeParse(bestParsed));
        }
      }

      // Pass 4: Fallback (original un-rotated adaptive if pixel-deskewed, else inverted dark-label pass)
      if (bestParsed.status === 'not_found') {
        activePass = 4;
        setProgress('Checking inverted contrast…', 92);
        const mode4 = didPixelDeskew ? 'adaptive' : 'inverted';
        const prep4 = preprocessForOcr(targetCanvas, mode4);
        const prep4Meta = { scale: prep4.scale, padding: prep4.padding, isTransformed: prep4.isTransformed };

        let res4;
        try {
          res4 = await recognizeWithTimeout(worker, prep4.canvas, `Pass 4 (${mode4})`);
        } finally {
          releaseCanvas(prep4.canvas);
        }
        if (myToken !== state.scanToken) return null;

        const parsed4 = parseNutritionLabel(res4.data);
        logger.ocr('PARSE', 'Pass 4 result', summarizeParse(parsed4));
        const prevBest = bestParsed;
        bestParsed = combineScanPasses(bestParsed, parsed4);
        if (bestParsed === parsed4 && prevBest !== parsed4) {
          bestPrepMeta = prep4Meta;
          bestCanvasForHighlight = targetCanvas;
        }
      }
    } finally {
      if (didPixelDeskew && baseCanvas !== targetCanvas) {
        releaseCanvas(baseCanvas);
      }
    }

    setProgress('Calculating fat per 100g…', 98);
    const highlightNorm =
      bestParsed?.matchedBbox && bestCanvasForHighlight && bestPrepMeta
        ? mapOcrBboxToNormalized(bestParsed.matchedBbox, bestPrepMeta, bestCanvasForHighlight)
        : null;

    return { parsed: bestParsed, highlightNorm };
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
    logger.error('SCAN', 'Scan pipeline error', err);
    renderErrorResult(err?.message || 'Scanning failed. Open Settings → Technical log for details.');
  }
}

// ============================================================================
// Result View Rendering & Manual Quick Adjust
// ============================================================================

function renderResultView(parsed, highlightNorm) {
  switchView('result');

  drawCanvasToTarget(state.activeCanvas, els.resultPhotoCanvas, THUMB_MAX_DIM);
  if (els.detectedHighlightBox) {
    if (highlightNorm) {
      els.detectedHighlightBox.style.left = `${highlightNorm.x * 100}%`;
      els.detectedHighlightBox.style.top = `${highlightNorm.y * 100}%`;
      els.detectedHighlightBox.style.width = `${highlightNorm.w * 100}%`;
      els.detectedHighlightBox.style.height = `${highlightNorm.h * 100}%`;
      els.detectedHighlightBox.classList.remove('hidden');
    } else {
      els.detectedHighlightBox.classList.add('hidden');
    }
  }

  if (els.rawOcrDetails) els.rawOcrDetails.open = false;
  if (els.rawOcrText) els.rawOcrText.textContent = parsed.rawText || '(No text recognized in this image)';

  if (parsed.mode === 'converted_from_serving' || parsed.status === 'needs_serving') {
    setAdjustMode('serving', false);
    if (els.manualFatInput) els.manualFatInput.value = parsed.fatRawValue !== null ? String(parsed.fatRawValue) : '';
    if (els.manualServingInput) els.manualServingInput.value = parsed.servingWeightG !== null ? String(parsed.servingWeightG) : '';
  } else {
    setAdjustMode('per100', false);
    if (els.manualFatInput) els.manualFatInput.value = parsed.fatPer100g !== null ? String(parsed.fatPer100g) : '';
    if (els.manualServingInput) els.manualServingInput.value = parsed.servingWeightG !== null ? String(parsed.servingWeightG) : '';
  }

  const shouldAutoOpen =
    parsed.status === 'needs_serving' ||
    parsed.status === 'not_found' ||
    Boolean(parsed.warning);
  setAdjustPanelOpen(shouldAutoOpen);

  const servingSummary =
    parsed.mode === 'converted_from_serving' && parsed.servingWeightG && parsed.fatRawValue !== null
      ? `Serving: ${parsed.servingRaw || `${parsed.servingWeightG}g`} · ${parsed.fatRawValue}g fat`
      : null;

  applyDisplayMetrics({
    status: parsed.status,
    fatPer100g: parsed.fatPer100g,
    basisUnit: parsed.basisUnit || '100g',
    isLessThan: parsed.isLessThan,
    explanation: parsed.explanation,
    warning: parsed.warning,
    servingSummary,
    saturatedFatPer100g: parsed.saturatedFatPer100g,
    matchedLine: parsed.matchedLine,
  });

  if (parsed.status === 'needs_serving') {
    setTimeout(() => els.manualServingInput?.focus(), 200);
  }
}

function applyDisplayMetrics({
  status,
  fatPer100g,
  basisUnit,
  isLessThan,
  explanation,
  warning,
  servingSummary = null,
  saturatedFatPer100g,
  matchedLine,
}) {
  const hasValue = status === 'success' && fatPer100g !== null && !Number.isNaN(fatPer100g);

  els.resultHeroValue?.classList.toggle('hidden', !hasValue);
  els.resultEmptyHero?.classList.toggle('hidden', hasValue);
  els.fatScaleWrap?.classList.toggle('hidden', !hasValue);

  if (hasValue) {
    if (els.resultEyebrow) els.resultEyebrow.textContent = basisUnit === '100ml' ? 'Fat content (liquid)' : 'Fat content';
    els.fatPrefix?.classList.toggle('hidden', !isLessThan);
    if (els.fatNumber) els.fatNumber.textContent = formatFatNumber(fatPer100g);
    if (els.fatUnit) els.fatUnit.textContent = basisUnit === '100ml' ? 'g / 100ml' : 'g / 100g';

    const cls = classifyFatLevel(fatPer100g);
    if (els.fatLevelTag) {
      if (cls) {
        els.fatLevelTag.textContent = cls.label;
        els.fatLevelTag.className = `level-tag level-${cls.level}`;
        els.fatLevelTag.classList.remove('hidden');
      } else {
        els.fatLevelTag.classList.add('hidden');
      }
    }

    if (els.fatScaleMarker) {
      const markerPct = mapFatToScalePercent(fatPer100g);
      els.fatScaleMarker.style.left = `${markerPct}%`;
    }
  } else {
    if (els.resultEyebrow) els.resultEyebrow.textContent = status === 'needs_serving' ? 'One detail needed' : 'Scan check';
    els.fatLevelTag?.classList.add('hidden');
    if (els.resultEmptyTitle) {
      els.resultEmptyTitle.textContent =
        status === 'needs_serving'
          ? 'Enter serving size to finish'
          : 'Couldn’t spot the fat value';
    }
  }

  if (els.resultExplanation) els.resultExplanation.textContent = explanation || '';

  if (els.resultWarning) {
    if (warning) {
      if (els.resultWarningText) els.resultWarningText.textContent = warning;
      els.resultWarning.classList.remove('hidden');
    } else {
      els.resultWarning.classList.add('hidden');
    }
  }

  let metaCount = 0;
  if (els.servingMeta) {
    if (hasValue && servingSummary) {
      els.servingMeta.textContent = servingSummary;
      els.servingMeta.classList.remove('hidden');
      metaCount++;
    } else {
      els.servingMeta.classList.add('hidden');
    }
  }

  if (els.satFatMeta) {
    if (hasValue && saturatedFatPer100g !== null && saturatedFatPer100g !== undefined) {
      els.satFatMeta.textContent = `Saturates: ${formatFatNumber(saturatedFatPer100g)} g / ${basisUnit}`;
      els.satFatMeta.classList.remove('hidden');
      metaCount++;
    } else {
      els.satFatMeta.classList.add('hidden');
    }
  }

  if (els.matchedLineMeta) {
    if (matchedLine) {
      els.matchedLineMeta.textContent = `Matched: “${matchedLine}”`;
      els.matchedLineMeta.classList.remove('hidden');
      metaCount++;
    } else {
      els.matchedLineMeta.classList.add('hidden');
    }
  }

  els.resultMetaStrip?.classList.toggle('hidden', metaCount === 0);
}

function renderErrorResult(message) {
  switchView('result');
  if (state.activeCanvas) {
    drawCanvasToTarget(state.activeCanvas, els.resultPhotoCanvas, THUMB_MAX_DIM);
  }
  els.detectedHighlightBox?.classList.add('hidden');
  if (els.rawOcrText) els.rawOcrText.textContent = message;
  setAdjustPanelOpen(true);
  applyDisplayMetrics({
    status: 'not_found',
    fatPer100g: null,
    basisUnit: '100g',
    isLessThan: false,
    explanation: message,
    warning: null,
    servingSummary: null,
    saturatedFatPer100g: null,
    matchedLine: null,
  });
}

function setAdjustPanelOpen(open) {
  els.adjustPanel?.classList.toggle('hidden', !open);
  els.toggleAdjustBtn?.setAttribute('aria-expanded', String(open));
  if (els.toggleAdjustLabel) els.toggleAdjustLabel.textContent = open ? 'Hide editor' : 'Adjust numbers';
}

function setAdjustMode(mode, recalculate) {
  state.adjustMode = mode;
  const isServing = mode === 'serving';

  els.modePer100Btn?.classList.toggle('active', !isServing);
  els.modePer100Btn?.setAttribute('aria-checked', String(!isServing));
  els.modeServingBtn?.classList.toggle('active', isServing);
  els.modeServingBtn?.setAttribute('aria-checked', String(isServing));

  els.manualServingGroup?.classList.toggle('hidden', !isServing);
  els.adjustFields?.classList.toggle('two-col', isServing);
  if (els.manualFatLabel) els.manualFatLabel.textContent = isServing ? 'Fat per serving' : 'Fat per 100g';

  if (recalculate) {
    handleManualAdjustInput();
  }
}

function handleManualAdjustInput() {
  const fatVal = parseDecimalInput(els.manualFatInput?.value || '');
  const servingVal = parseDecimalInput(els.manualServingInput?.value || '');
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
        servingSummary: null,
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
      servingSummary: null,
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
        servingSummary: null,
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
      servingSummary: `Serving: ${servingVal}g · ${fatVal}g fat`,
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
  drawCanvasToTarget(state.originalCanvas, els.cropCanvas, THUMB_MAX_DIM);
  els.cropModal?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(updateCropBoxStyle);
}

function closeCropModal() {
  els.cropModal?.classList.add('hidden');
  document.body.style.overflow = '';
  state.cropDrag = null;
}

async function applyCropAndScan() {
  if (!state.originalCanvas) return;
  const cropped = cropCanvas(state.originalCanvas, state.cropRect);
  logger.info('CROP', `Cropped region to ${cropped.width}x${cropped.height}`, {
    rect: {
      x: Number(state.cropRect.x.toFixed(2)),
      y: Number(state.cropRect.y.toFixed(2)),
      w: Number(state.cropRect.w.toFixed(2)),
      h: Number(state.cropRect.h.toFixed(2)),
    },
  });
  if (state.activeCanvas && state.activeCanvas !== state.originalCanvas) {
    releaseCanvas(state.activeCanvas);
  }
  state.activeCanvas = cropped;
  closeCropModal();
  switchView('scanning');
  setProgress('Cropping nutrition table…', 10);
  await runScanPipeline(cropped);
}

function updateCropBoxStyle() {
  if (!els.cropBox) return;
  const { x, y, w, h } = state.cropRect;
  els.cropBox.style.left = `${x * 100}%`;
  els.cropBox.style.top = `${y * 100}%`;
  els.cropBox.style.width = `${w * 100}%`;
  els.cropBox.style.height = `${h * 100}%`;
}

function initCropPointerEvents() {
  if (!els.cropBox || !els.cropStage) return;
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
    // ignore
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
  if (!els.historySection || !els.historyList) return;
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

function drawCanvasToTarget(srcCanvas, dstCanvas, maxDim = THUMB_MAX_DIM) {
  if (!srcCanvas || !dstCanvas || !srcCanvas.width || !srcCanvas.height) return;
  const scale = Math.min(1, maxDim / Math.max(srcCanvas.width, srcCanvas.height));
  dstCanvas.width = Math.max(1, Math.round(srcCanvas.width * scale));
  dstCanvas.height = Math.max(1, Math.round(srcCanvas.height * scale));
  const ctx = dstCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
  ctx.drawImage(srcCanvas, 0, 0, dstCanvas.width, dstCanvas.height);
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
