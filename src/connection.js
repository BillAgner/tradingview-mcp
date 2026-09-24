import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// A profile's tradingview-mcp process is a long-lived gateway child (runs for
// the life of the profile session -- days, in practice) and previously never
// let go of its CDP client once connected. Auto-disconnect after this much
// inactivity so an idle session doesn't hold a live browser connection
// indefinitely; getClient()/connect() transparently reconnect on next use.
const IDLE_DISCONNECT_MS = 10 * 60 * 1000;
let idleTimer = null;

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    disconnect().catch(() => {});
  }, IDLE_DISCONNECT_MS);
  idleTimer.unref?.();
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * JS expression (evaluated in-page) that detects a blocking modal dialog —
 * TradingView's "Save layout before switching?", unsaved-script warnings,
 * login prompts, etc. These are native browser-UI confirmations meant for a
 * human to click through; a CDP-driven agent has no way to notice one is up
 * except that whatever it just tried to do silently didn't happen (see the
 * layoutSwitch bug this was built to prevent a repeat of). Exposed via
 * health.healthCheck()/health.uiState() so agents see it on their very next
 * status check, and dismissible via ui.dismissDialog().
 *
 * Heuristic, not exact: matches visible [role="dialog"] first (the strongest
 * signal), falling back to [class*="dialog"|"modal"|"popup"] elements that
 * are reasonably dialog-sized and contain at least one <button> — this
 * excludes small hover tooltips (no buttons) and normal dropdown menus
 * (usually <div>/<li> items, not <button>, and no role="dialog").
 */
export const DIALOG_DETECT_JS = `
  (function() {
    function describe(el) {
      var buttons = [];
      var btns = el.querySelectorAll('button');
      for (var b = 0; b < btns.length; b++) {
        var t = btns[b].textContent.trim();
        if (t && btns[b].offsetParent !== null) buttons.push(t);
      }
      var heading = el.querySelector('h1, h2, h3, [class*="title"]');
      var title = heading ? heading.textContent.trim() : '';
      var fullText = (el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 300);
      return { present: true, title: title, message: fullText, buttons: buttons };
    }

    // Persistent docked panels (Pine editor, watchlist, strategy tester, widget
    // bar) legitimately match "dialog|modal|popup"-ish class substrings in
    // TradingView's minified CSS but are not blocking overlays — exclude
    // anything living inside one of them.
    var EXCLUDE_CONTAINERS = '[class*="layout__area"], [class*="pine-editor"], .monaco-editor,' +
      ' [data-name="widgetbar-wrap"], [data-name="backtesting"]';

    function isRealOverlay(el) {
      if (el.closest(EXCLUDE_CONTAINERS)) return false;
      var rect = el.getBoundingClientRect();
      // True modals are centered overlays, not edge-docked panels — a panel
      // docked to the right/bottom has a center far from the viewport's.
      var elCenterX = rect.left + rect.width / 2;
      var elCenterY = rect.top + rect.height / 2;
      var viewCenterX = window.innerWidth / 2;
      var viewCenterY = window.innerHeight / 2;
      if (Math.abs(elCenterX - viewCenterX) > window.innerWidth * 0.2) return false;
      if (Math.abs(elCenterY - viewCenterY) > window.innerHeight * 0.3) return false;
      return true;
    }

    var viaRole = document.querySelector('[role="dialog"]');
    if (viaRole && viaRole.offsetParent !== null && isRealOverlay(viaRole)) return describe(viaRole);

    var selectors = ['[class*="dialog"]', '[class*="modal"]', '[class*="popup"]'];
    var best = null, bestArea = 0;
    var seen = [];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (seen.indexOf(el) !== -1) continue;
        seen.push(el);
        if (el.offsetParent === null) continue;
        var rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 100) continue;
        if (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.95) continue;
        if (el.querySelectorAll('button').length === 0) continue;
        if (!isRealOverlay(el)) continue;
        var area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
    }
    if (!best) return { present: false };
    return describe(best);
  })()
`;

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  armIdleTimer();
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
