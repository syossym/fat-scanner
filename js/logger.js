/**
 * Lightweight on-device Technical Logger for Fat100.
 * Adopts any early boot/CDN/module errors captured in window.__fat100Logs,
 * keeps the latest 200 structured entries in memory + sessionStorage,
 * and notifies subscribers (such as the Settings -> Technical Log viewer).
 */

export const APP_VERSION = 'v1.2.1';
const STORAGE_KEY = 'fat100_tech_log_v1';
const MAX_ENTRIES = 200;

const listeners = new Set();
let entries = [];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function safeSerialize(detail) {
  if (detail === undefined || detail === null || detail === '') return '';
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) {
    return [detail.name + ': ' + detail.message, detail.stack].filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function loadInitialEntries() {
  const merged = [];
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) merged.push(...parsed);
    }
  } catch {
    // ignore private browsing restrictions
  }

  if (Array.isArray(window.__fat100Logs) && window.__fat100Logs.length > 0) {
    for (const item of window.__fat100Logs) {
      merged.push({
        ts: item.ts || Date.now(),
        level: item.level || 'INFO',
        tag: item.tag || 'BOOT',
        message: String(item.message || ''),
        detail: item.detail ? String(item.detail) : '',
      });
    }
    window.__fat100Logs.length = 0;
  }

  entries = merged.slice(-MAX_ENTRIES);
}

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // ignore quota errors
  }
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(entries);
    } catch {
      // never let a listener break logging
    }
  }
}

export function logEvent(level, tag, message, detail) {
  const entry = {
    ts: Date.now(),
    level: String(level || 'INFO').toUpperCase(),
    tag: String(tag || 'APP').toUpperCase(),
    message: String(message || ''),
    detail: safeSerialize(detail),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
  persist();
  notify();
  return entry;
}

export const logger = {
  info: (tag, msg, detail) => logEvent('INFO', tag, msg, detail),
  ocr: (tag, msg, detail) => logEvent('OCR', tag, msg, detail),
  warn: (tag, msg, detail) => logEvent('WARN', tag, msg, detail),
  error: (tag, msg, detail) => logEvent('ERR', tag, msg, detail),
  getEntries: () => entries,
  clear() {
    entries = [];
    persist();
    notify();
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  formatForExport(extraMeta = {}) {
    const header = [
      `=== Fat100 Technical Log (${APP_VERSION}) ===`,
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `UA: ${navigator.userAgent}`,
      `Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x`,
      ...Object.entries(extraMeta).map(([k, v]) => `${k}: ${v}`),
      '----------------------------------------',
    ];

    const body = entries.map((e) => {
      const base = `[${formatTimestamp(e.ts)}] [${e.level}] [${e.tag}] ${e.message}`;
      return e.detail ? `${base}\n  ${e.detail.replace(/\n/g, '\n  ')}` : base;
    });

    return [...header, ...body].join('\n');
  },
  formatTimestamp,
};

loadInitialEntries();

// Attach global runtime error traps so any uncaught failure lands right in the Technical Log
window.addEventListener('error', (ev) => {
  const msg = ev?.message || 'Unhandled script error';
  const loc = ev?.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '';
  const stack = ev?.error?.stack || '';
  logEvent('ERR', 'WINDOW', msg, [loc, stack].filter(Boolean).join('\n'));
});

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev?.reason;
  const msg = reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection');
  logEvent('ERR', 'PROMISE', msg, reason instanceof Error ? reason.stack : '');
});
