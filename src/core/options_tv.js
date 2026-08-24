/**
 * Options chain data sourced directly from TradingView Desktop (CDP-driven),
 * as opposed to `core/options.js` which shells out to a Python/Tradier/
 * yfinance subprocess. Genuine market bid/ask/spread/volume/IV per strike,
 * both calls and puts, read from TradingView's own "Option chain" panel
 * (right sidebar Symbol Info card -> "More on options" button).
 *
 * DOM path fully live-verified 2026-07-31 against a real signed-in session
 * (right-sidebar toggle -> Symbol Info widget -> "More on options" -> in-place
 * chain view -> "Back to chart"). The chain is a genuine HTML <table> (not a
 * virtualized div grid): <thead> has 2 rows (group-label row, then the real
 * per-column header row), body split into per-expiration <tbody> sections
 * each starting with a group-separator row. Real native columns confirmed
 * present: Delta/Gamma/Theta/Vega/Rho/Breakeven/IV spread/Bid IV %/Ask IV %
 * per side, in addition to bid/ask/volume/OI/spread/intrinsic/time value —
 * genuine market greeks, not a Black-Scholes approximation.
 *
 * IMPORTANT: the "More on options" and "Back to chart" buttons do NOT
 * respond to plain DOM `el.click()` or `el.dispatchEvent(new MouseEvent(...))`
 * (isTrusted:false) — both silently no-op. They require real CDP-level input
 * via `Input.dispatchMouseEvent` (isTrusted:true), see `realClickAt()`. If a
 * future TradingView update reintroduces "click does nothing" symptoms on a
 * new button in this flow, this is the first thing to check.
 */
import { evaluate, evaluateAsync, safeString, getClient } from '../connection.js';
import { setSymbol as chartSetSymbol } from './chart.js';

const RIGHT_PANEL_SELECTOR = '[class*="layout__area--right"]';
const POLL_INTERVAL_MS = 400;
const POLL_MAX_ATTEMPTS = 15; // ~6s total

async function poll(fn, maxAttempts = POLL_MAX_ATTEMPTS) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Real CDP-level mouse click (Input.dispatchMouseEvent) at fixed page
 * coordinates. Required for at least the "More on options" button — plain
 * DOM `el.click()` and `el.dispatchEvent(new MouseEvent(...))` (isTrusted:
 * false) silently no-op on it, confirmed live 2026-07-31. Real CDP input
 * events land as isTrusted:true, matching genuine user input.
 */
async function realClickAt(x, y) {
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left' });
}

async function isRightPanelOpen() {
  return evaluate(`
    (function() {
      var el = document.querySelector('${RIGHT_PANEL_SELECTOR}');
      return !!(el && el.getBoundingClientRect().width > 100);
    })()
  `);
}

async function ensureRightPanelOpen() {
  if (await isRightPanelOpen()) return;
  await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base"]');
      if (btn) btn.click();
    })()
  `);
  const opened = await poll(isRightPanelOpen);
  if (!opened) throw new Error('Right sidebar did not open (data-name="base" toggle unavailable or unresponsive).');
}


async function isDetailWidgetMounted() {
  return evaluate(`
    (function() {
      var el = document.querySelector('.widgetbar-widget-detail');
      return !!(el && el.getBoundingClientRect().width > 80);
    })()
  `);
}

/**
 * switchWatchlistCdp leaves the right sidebar on the Watchlist page, so
 * .widgetbar-widget-detail is not mounted and "More on options" cannot appear.
 * Click widgetbar tabs until Symbol Info / Details is showing, then scroll it.
 * Live-needed after Friday 2026-08-21 RTH: ok=0 failed=14 all day; 21:36 AH
 * succeeded when Details was already in view.
 */
async function ensureSymbolInfoDetailOpen() {
  if (await isDetailWidgetMounted()) {
    await evaluate(`
      (function() {
        var d = document.querySelector('.widgetbar-widget-detail');
        if (!d) return;
        var sc = d.querySelector('[class*="scroll"]') || d;
        sc.scrollTop = sc.scrollHeight;
      })()
    `);
    return true;
  }
  const nTabs = await evaluate(`
    (function() {
      var bar = document.querySelector('[data-name="widgetbar-pages-with-tabs"]')
        || document.querySelector('[class*="widgetbar-pages"]')
        || document.querySelector('[class*="layout__area--right"]');
      if (!bar) return 0;
      return bar.querySelectorAll('button, [role="tab"]').length;
    })()
  `) || 0;
  for (let i = 0; i < nTabs; i++) {
    await evaluate(`
      (function() {
        var bar = document.querySelector('[data-name="widgetbar-pages-with-tabs"]')
          || document.querySelector('[class*="widgetbar-pages"]')
          || document.querySelector('[class*="layout__area--right"]');
        if (!bar) return;
        var tabs = bar.querySelectorAll('button, [role="tab"]');
        if (tabs[${i}]) tabs[${i}].click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 350));
    if (await isDetailWidgetMounted()) {
      await evaluate(`
        (function() {
          var d = document.querySelector('.widgetbar-widget-detail');
          if (!d) return;
          var sc = d.querySelector('[class*="scroll"]') || d;
          sc.scrollTop = sc.scrollHeight;
        })()
      `);
      await new Promise((r) => setTimeout(r, 400));
      return true;
    }
  }
  return await isDetailWidgetMounted();
}


/**
 * TradingView's "Save layout before switching?" prompt (native confirm-style
 * modal, appears whenever the current layout has unsaved changes and
 * something -- our own repeated chartSetSymbol/layout_switch calls included
 * -- asks to switch away from it). It sits above the chain-view DOM and eats
 * every synthetic click while open, so nothing downstream (the "More on
 * options" click, the chain-table poll) can ever succeed until it's cleared.
 * Confirmed live 2026-08-24: it reappears mid-run, well after
 * ensureOptionsChainOpen's own top-of-function checks would have passed, and
 * the resulting failure ("Strike header cell not found") gives no hint that
 * this dialog is the actual blocker. Always click "Don't save" -- this
 * discards only the in-memory chart-layout diff from our own scripted
 * symbol changes, never anything the user saved.
 */
async function dismissSaveLayoutPromptIfPresent() {
  const coords = await evaluate(`
    (function() {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        if ((b.textContent || '').trim() === "Don't save") {
          var r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return { found: false };
    })()
  `);
  if (coords && coords.found) {
    await realClickAt(coords.x, coords.y);
    await new Promise((r) => setTimeout(r, 500));
    return true;
  }
  return false;
}

/**
 * Locate the "More on options" button inside the Symbol Info widget and
 * return its click coordinates (after scrollIntoView). Does not click —
 * caller must use realClickAt(), since plain DOM clicks don't register on
 * this button (see realClickAt's doc comment).
 */
async function findMoreOnOptionsCoords() {
  return evaluate(`
    (function() {
      var detail = document.querySelector('.widgetbar-widget-detail');
      if (!detail) return { found: false, reason: 'detail widget not mounted' };
      var all = detail.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 1) continue;
        var txt = (el.textContent || '').trim();
        // ANCHORED match required -- confirmed live 2026-08-24: the whole
        // Symbol-Info panel wrapper (.widgetbar-widgetbody) has exactly one
        // child, so it also passes the children.length<=1 filter above, and
        // its full concatenated textContent (thousands of chars: company
        // profile, financials, technicals, etc.) legitimately CONTAINS the
        // substring "More on options" from the real button further down the
        // tree. Because querySelectorAll('*') walks in document order and
        // this wrapper precedes the real button, an unanchored substring
        // test (the old /more on options/i.test(txt)) matched the wrapper
        // FIRST and returned its coordinates instead of the button's --
        // clicking the center of an unrelated huge container, landing
        // wherever that happened to scroll to (this produced the earlier
        // "landed on an IV term structure sub-page" false lead). The real
        // button leaf's own trimmed textContent is exactly "More on
        // options" (or "More about options") with nothing else, so anchor
        // the regex to require an exact match end-to-end -- same pattern
        // already used by isOnChainView()/clickBackToChart() in this file.
        if (/^more on options$|^more about options$/i.test(txt)) {
          var container = el.closest('[class*="buttonContainer"]') || el.parentElement;
          container.scrollIntoView({ block: 'center' });
          var rect = container.getBoundingClientRect();
          return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return { found: false, reason: 'button not present (symbol may have no listed options, or widget not yet populated)' };
    })()
  `);
}

async function findAndClickMoreOnOptions() {
  const coords = await findMoreOnOptionsCoords();
  if (!coords.found) return coords;
  await new Promise((r) => setTimeout(r, 300)); // let scrollIntoView settle
  await realClickAt(coords.x, coords.y);
  return { found: true };
}

async function isOnChainView() {
  return evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length <= 1 && /^back to chart$/i.test((el.textContent || '').trim())) return true;
      }
      return false;
    })()
  `);
}

async function clickBackToChart() {
  const coords = await evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length <= 1 && /^back to chart$/i.test((el.textContent || '').trim())) {
          var rect = el.getBoundingClientRect();
          return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return { found: false };
    })()
  `);
  if (!coords.found) return false;
  await realClickAt(coords.x, coords.y);
  return true;
}

/**
 * Ensure the chart is on `symbol` and the options-chain view is open.
 * Idempotent — safe to call repeatedly.
 */
export async function ensureOptionsChainOpen({ symbol }) {
  await dismissSaveLayoutPromptIfPresent();
  await chartSetSymbol({ symbol });
  await dismissSaveLayoutPromptIfPresent();

  const alreadyOpen = await isOnChainView();
  if (!alreadyOpen) {
    await ensureRightPanelOpen();
    await ensureSymbolInfoDetailOpen();

    // The Symbol Info widget can take a moment to populate after a symbol
    // change; poll rather than assume it's instant. Also re-check the save-
    // layout prompt every attempt, not just once up front -- it can appear
    // partway through this poll, not only before it.
    const clickResult = await poll(async () => {
      await dismissSaveLayoutPromptIfPresent();
      const r = await findAndClickMoreOnOptions();
      return r.found ? r : null;
    });

    if (!clickResult) {
      // One nudge: re-issue setSymbol (even to the same value) in case the
      // widget only listens for symbol-change events and missed the first one.
      await chartSetSymbol({ symbol });
      await ensureSymbolInfoDetailOpen();
      const retryResult = await poll(async () => {
        const r = await findAndClickMoreOnOptions();
        return r.found ? r : null;
      });
      if (!retryResult) {
        throw new Error(
          `Could not find "More on options" for ${symbol}. Either this symbol has no listed options, ` +
          `or the Symbol Info widget did not populate (right-sidebar watchlist state issue — see options_tv.js header comment).`
        );
      }
    }

    const opened = await poll(isOnChainView);
    if (!opened) throw new Error(`Clicked "More on options" for ${symbol} but the chain view never appeared.`);
  }

  // The "Expiration" and "Strikes" filter pills reset to TradingView's own
  // defaults ("Next 30 days" / "±6 strikes") every time the chain view is
  // (re)opened for a symbol — confirmed live 2026-08-01 by closing/reopening
  // for a fresh symbol. Widen both to "All expirations"/"All strikes" so
  // every reader (getExpirations/getStrikes/getChain, and therefore the
  // fetch_options_chain_tv.mjs capture job) sees the full chain, not just
  // the narrow default window. Safe to call even when already_open, since
  // it no-ops if the pills already read "All expirations"/"All strikes".
  await ensureAllExpirationsAndStrikes();

  return { success: true, symbol, already_open: alreadyOpen };
}

/**
 * Read the current "Expiration" and "Strikes" filter pill text from the
 * chain-view toolbar (e.g. "Next 30 days", "±6 strikes", "All expirations").
 * Assumes the chain view is already open.
 */
async function readChainFilterPills() {
  return evaluate(`
    (function() {
      function pillText(qa) {
        var btn = document.querySelector('[data-qa-id="ui-lib-pill-active-area-button ' + qa + '"]');
        if (!btn) return null;
        var wrapper = btn.closest('[class*="wrapper-eTfGDaEr"]');
        return wrapper ? wrapper.textContent.trim() : null;
      }
      return { expiration: pillText('series-filter'), strikes: pillText('strikes-filter') };
    })()
  `);
}

/**
 * Click one of the chain-view filter pills (identified by its stable
 * data-qa-id — "series-filter" for Expiration, "strikes-filter" for
 * Strikes) to open its dropdown popover.
 */
async function clickFilterPill(qaId) {
  const coords = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-qa-id="ui-lib-pill-active-area-button ${qaId}"]');
      if (!btn) return { found: false };
      var rect = btn.getBoundingClientRect();
      return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  if (!coords.found) return false;
  await realClickAt(coords.x, coords.y);
  return true;
}

/**
 * Both the Expiration and Strikes popovers offer a "Specific dates"/
 * "Specific strikes" tab (an individual-item checklist) and a "Ranges" tab
 * (preset spans, including "All expirations"/"All strikes"). Click "Ranges"
 * if it isn't already selected — confirmed live 2026-08-01 that Expiration
 * opens on "Specific dates" by default while Strikes opens on "Ranges" by
 * default, so this can't be assumed either way per-dropdown.
 */
async function selectRangesTab() {
  const tab = await evaluate(`
    (function() {
      var pop = document.querySelector('[class*="positioner-hBVkaP2P"]');
      if (!pop) return { found: false };
      var candidates = pop.querySelectorAll('[role="radio"]');
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!/^ranges$/i.test(el.textContent.trim())) continue;
        var rect = el.getBoundingClientRect();
        return {
          found: true,
          checked: el.getAttribute('aria-checked') === 'true' || el.className.indexOf('checked') !== -1,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      }
      return { found: false };
    })()
  `);
  if (!tab.found) return false; // no tab control in this popover
  if (!tab.checked) {
    await realClickAt(tab.x, tab.y);
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
}

/**
 * Click the popover row whose exact leaf text matches `label` (e.g. "All
 * expirations", "All strikes"). Assumes a filter popover is currently open.
 */
async function clickPopoverRowByText(label) {
  const coords = await evaluate(`
    (function() {
      var pop = document.querySelector('[class*="positioner-hBVkaP2P"]');
      if (!pop) return { found: false, reason: 'popover not open' };
      var all = pop.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length !== 0) continue;
        if (el.textContent.trim() !== ${JSON.stringify(label)}) continue;
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      return { found: false, reason: 'row not found in open popover' };
    })()
  `);
  if (!coords.found) return null;
  await realClickAt(coords.x, coords.y);
  return coords;
}

/**
 * Open one chain-view filter pill and select its "Ranges" tab preset
 * matching `optionLabel` (e.g. "All expirations" on "series-filter", "All
 * strikes" on "strikes-filter"). Selecting a row closes the popover
 * automatically (confirmed live 2026-08-01).
 */
async function setChainFilterRange(qaId, optionLabel) {
  const opened = await clickFilterPill(qaId);
  if (!opened) throw new Error(`Chain filter pill not found: ${qaId}`);

  const popoverOpen = await poll(async () => {
    const has = await evaluate(`!!document.querySelector('[class*="positioner-hBVkaP2P"]')`);
    return has ? true : null;
  }, 10);
  if (!popoverOpen) throw new Error(`Popover for ${qaId} did not open`);

  await selectRangesTab();

  const clicked = await poll(() => clickPopoverRowByText(optionLabel), 10);
  if (!clicked) throw new Error(`Could not find "${optionLabel}" option in the ${qaId} dropdown`);
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Widen the chain view's "Expiration" and "Strikes" filters to "All
 * expirations"/"All strikes" if either isn't already set that way. No-op
 * (skips the corresponding dropdown entirely) when a pill already reads
 * "All expirations"/"All strikes", so repeated calls are cheap.
 */
async function ensureAllExpirationsAndStrikes() {
  const before = await readChainFilterPills();
  if (before.expiration && !/all expirations/i.test(before.expiration)) {
    await setChainFilterRange('series-filter', 'All expirations');
  }
  const mid = await readChainFilterPills();
  if (mid.strikes && !/all strikes/i.test(mid.strikes)) {
    await setChainFilterRange('strikes-filter', 'All strikes');
  }
  return readChainFilterPills();
}

export async function closeOptionsChain() {
  if (!(await isOnChainView())) return { success: true, was_open: false };
  await clickBackToChart();
  return { success: true, was_open: true };
}

/**
 * Only the nearest expiration's <tbody> has its data rows populated by
 * default — every other expiration group starts collapsed (class
 * "groupCell-hwGhGWMB" without "groupOpened-hwGhGWMB"). Expand every closed
 * group so we see the full chain, not just the nearest expiration.
 *
 * Confirmed live 2026-07-31, two gotchas:
 * 1. Clicking the group <td> itself (colspan=36) reports an unusable
 *    off-screen rect (x=-640 even after scrollIntoView) — must target its
 *    inner `.groupContent-hwGhGWMB` div instead (same lesson as "More on
 *    options"). Real CDP click required, plain DOM click does not expand it.
 * 2. The table ROW-VIRTUALIZES: expanding group N and then scrolling to
 *    group N+1 can unmount group N's just-rendered rows from the DOM again.
 *    So rows must be read immediately after each group is expanded, not in
 *    one final pass after expanding everything — hence this function reads
 *    and accumulates rows itself rather than being a separate step before
 *    readChainTable(). State (header, strike index, accumulated rows, and
 *    live element references to each group <td>) is stashed on `window`
 *    between separate CDP evaluate() calls, which is safe because they all
 *    execute against the same persistent page context.
 */
async function readFullChain() {
  // Retry, not a one-shot call: when the chain view was already open (no
  // fresh open-transition wait applied), the table can momentarily not be
  // mounted yet — confirmed live 2026-07-31 as a real, reproducible race,
  // not a hypothetical.
  const init = await poll(async () => {
    await dismissSaveLayoutPromptIfPresent();
    const r = await evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      var strikeTh = null;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length === 0 && /^.{0,3}strike$/i.test((el.textContent||'').trim())) { strikeTh = el; break; }
      }
      if (!strikeTh) return { found: false, reason: '"Strike" header cell not found' };
      var table = strikeTh.closest('table');
      if (!table) return { found: false, reason: 'Strike header is not inside a <table>' };
      var thead = table.querySelector('thead');
      if (!thead) return { found: false, reason: 'no <thead>' };
      var headerRows = thead.querySelectorAll('tr');
      var headerRow = headerRows[headerRows.length - 1];
      var headerCells = [];
      for (var h = 0; h < headerRow.children.length; h++) headerCells.push(headerRow.children[h].textContent.trim());
      var strikeIdx = headerCells.findIndex(function(t) { return /strike/i.test(t); });
      if (strikeIdx === -1) return { found: false, reason: 'Strike column not found in header row' };

      window.__tvExtractRow = function(tr) {
        var vals = [];
        for (var c = 0; c < tr.children.length; c++) {
          var cell = tr.children[c];
          var tooltipEl = cell.querySelector('[data-overflow-tooltip-text]');
          // innerText (not textContent) so a merged-column cell's nested
          // ".secondary-*" line (stacked greeks, e.g. delta on line one and
          // gamma on line two -- confirmed live 2026-08-24) keeps its line
          // break instead of collapsing into one unparseable run of digits.
          var raw = tooltipEl ? tooltipEl.getAttribute('data-overflow-tooltip-text') : (cell.innerText || cell.textContent).trim();
          if (raw.length > 1 && raw.length % 2 === 0) {
            var half = raw.length / 2;
            if (raw.slice(0, half) === raw.slice(half)) raw = raw.slice(0, half);
          }
          vals.push(raw.trim());
        }
        return vals;
      };

      window.__tvChainRows = [];
      window.__tvChainGroupTds = []; // live element refs, open AND closed
      var allExpGroups = [];
      var bodies = table.querySelectorAll('tbody');
      var bodySource = bodies.length > 0 ? bodies : [table];
      for (var b = 0; b < bodySource.length; b++) {
        var trs = bodySource[b].querySelectorAll('tr');
        var currentExp = null;
        for (var r = 0; r < trs.length; r++) {
          var tr = trs[r];
          if (tr.children.length !== headerCells.length) {
            var groupTd = tr.querySelector('td[data-cell-id]');
            var cellId = groupTd ? groupTd.getAttribute('data-cell-id') : null;
            var dateMatch = cellId && cellId.match(/;(\\d{4})(\\d{2})(\\d{2})$/);
            if (dateMatch) {
              currentExp = dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3];
              allExpGroups.push(currentExp);
              window.__tvChainGroupTds.push(groupTd);
            }
            continue;
          }
          window.__tvChainRows.push({ expiration: currentExp, cells: window.__tvExtractRow(tr) });
        }
      }

      return { found: true, header: headerCells, strike_index: strikeIdx, all_expiration_groups: allExpGroups, closed_group_count: window.__tvChainGroupTds.filter(function(td){ return td.className.indexOf('groupOpened') === -1; }).length, initial_row_count: window.__tvChainRows.length };
    })()
    `);
    return r.found ? r : null;
  });
  if (!init) return { found: false, reason: '"Strike" header cell not found after retries — chain table did not mount' };

  // Expand every closed group, reading its rows immediately afterward
  // (before scrolling elsewhere risks virtualizing them back out).
  for (let i = 0; i < 30; i++) {
    const next = await evaluate(`
      (function() {
        for (var i = 0; i < window.__tvChainGroupTds.length; i++) {
          var td = window.__tvChainGroupTds[i];
          if (td.className.indexOf('groupOpened') === -1) {
            var inner = td.querySelector('.groupContent-hwGhGWMB') || td;
            inner.scrollIntoView({ block: 'center' });
            var r = inner.getBoundingClientRect();
            return { idx: i, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      })()
    `);
    if (!next) break;
    await new Promise((r) => setTimeout(r, 300));
    await realClickAt(next.x, next.y);
    await new Promise((r) => setTimeout(r, 700));

    await evaluate(`
      (function() {
        var td = window.__tvChainGroupTds[${next.idx}];
        var tbody = td.closest('tbody');
        if (!tbody) return 0;
        var headerLen = ${init.header.length};
        var trs = tbody.querySelectorAll('tr');
        var exp = null;
        var added = 0;
        for (var r = 0; r < trs.length; r++) {
          var tr = trs[r];
          if (tr.children.length !== headerLen) {
            var groupTd = tr.querySelector('td[data-cell-id]');
            var cellId = groupTd ? groupTd.getAttribute('data-cell-id') : null;
            var dateMatch = cellId && cellId.match(/;(\\d{4})(\\d{2})(\\d{2})$/);
            if (dateMatch) exp = dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3];
            continue;
          }
          window.__tvChainRows.push({ expiration: exp, cells: window.__tvExtractRow(tr) });
          added++;
        }
        return added;
      })()
    `);
  }

  const rows = await evaluate(`window.__tvChainRows`);
  return { found: true, header: init.header, strike_index: init.strike_index, all_expiration_groups: init.all_expiration_groups, rows };
}

/**
 * Read the chain <table> as real table markup (confirmed live 2026-07-31 —
 * this is a genuine HTML table, not a virtualized div grid). Structure:
 * <thead> has 2 rows (a "Calls"/"Puts" group-label row, then the real
 * per-column header row with ~36 <th> cells including "Strike"); the table
 * body is split into per-expiration <tbody> sections, each starting with a
 * group-separator row (fewer cells than the header, e.g. "July 31" / "0 DTE")
 * followed by real data rows (cell count matching the header).
 *
 * Column mapping is header-text-driven (not hardcoded positions) so it
 * self-adapts if TradingView reorders/adds columns.
 */
async function readChainTable() {
  return evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      var strikeTh = null;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length === 0 && /^.{0,3}strike$/i.test((el.textContent||'').trim())) { strikeTh = el; break; }
      }
      if (!strikeTh) return { found: false, reason: '"Strike" header cell not found' };

      var table = strikeTh.closest('table');
      if (!table) return { found: false, reason: 'Strike header is not inside a <table>' };

      var thead = table.querySelector('thead');
      if (!thead) return { found: false, reason: 'no <thead>' };
      var headerRows = thead.querySelectorAll('tr');
      var headerRow = headerRows[headerRows.length - 1]; // last row = real per-column headers
      var headerCells = [];
      for (var h = 0; h < headerRow.children.length; h++) headerCells.push(headerRow.children[h].textContent.trim());
      var strikeIdx = headerCells.findIndex(function(t) { return /strike/i.test(t); });
      if (strikeIdx === -1) return { found: false, reason: 'Strike column not found in header row' };

      var expirationRows = [];
      var allGroups = []; // every group date seen, open or collapsed
      var currentExpiration = null;
      var bodies = table.querySelectorAll('tbody');
      var bodySource = bodies.length > 0 ? bodies : [table];
      for (var b = 0; b < bodySource.length; b++) {
        var trs = bodySource[b].querySelectorAll('tr');
        for (var r = 0; r < trs.length; r++) {
          var tr = trs[r];
          var cellCount = tr.children.length;
          if (cellCount !== headerCells.length) {
            // Group-separator row (e.g. "July 31" / "0 DTE"). The real ISO
            // date lives in the group <td>'s data-cell-id attribute
            // ("EXCHANGE:SYMBOL;SYMBOL;YYYYMMDD") — far more reliable than
            // parsing display text, which concatenates "July 31" + "0 DTE"
            // with no separator via textContent.
            // Only a real expiration-group row has a data-cell-id ending in
            // a YYYYMMDD date suffix. TradingView also interleaves an
            // unrelated "current spot price" marker row (also a wide
            // colspan cell, e.g. "TSLA 311.21 USD +2.36 +0.76%") among the
            // strikes — it does NOT match this date pattern, so it's
            // correctly skipped rather than misread as a new expiration.
            var groupTd = tr.querySelector('td[data-cell-id]');
            var cellId = groupTd ? groupTd.getAttribute('data-cell-id') : null;
            var dateMatch = cellId && cellId.match(/;(\\d{4})(\\d{2})(\\d{2})$/);
            if (dateMatch) {
              currentExpiration = dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3];
              allGroups.push(currentExpiration);
            }
            continue;
          }
          var vals = [];
          for (var c = 0; c < tr.children.length; c++) {
            var cell = tr.children[c];
            // Prefer the clean tooltip-text attribute (avoids a visually-hidden
            // accessibility duplicate node inside the same cell that otherwise
            // makes textContent read as "297.5297.5"). Otherwise innerText, not
            // textContent, so a merged-column cell's nested ".secondary-*" line
            // (stacked greeks, e.g. delta then gamma) keeps its line break.
            var tooltipEl = cell.querySelector('[data-overflow-tooltip-text]');
            var raw = tooltipEl ? tooltipEl.getAttribute('data-overflow-tooltip-text') : (cell.innerText || cell.textContent).trim();
            // Fallback safety net: collapse an exact self-repeated string
            // ("297.5297.5" -> "297.5") in case some column lacks the tooltip attr.
            if (raw.length > 1 && raw.length % 2 === 0) {
              var half = raw.length / 2;
              if (raw.slice(0, half) === raw.slice(half)) raw = raw.slice(0, half);
            }
            vals.push(raw.trim());
          }
          expirationRows.push({ expiration: currentExpiration, cells: vals });
        }
      }

      return { found: true, header: headerCells, strike_index: strikeIdx, row_count: expirationRows.length, rows: expirationRows.slice(0, 500), all_expiration_groups: allGroups };
    })()
  `);
}

// TradingView renders negative numbers with a Unicode minus-like glyph
// (math minus U+2212 and/or dash variants), not ASCII hyphen-minus.
// parseFloat doesn't recognize those, so every negative cell silently
// became null. Confirmed live 2026-07-31: tv_option_chain had zero
// negative values in ANY column despite theta requiring one for nearly
// every real contract (100% null on both calls and puts), and put-side
// delta/rho (negative by convention) were 0% populated while call-side
// delta/rho (positive by convention) were fully populated -- gamma/vega
// (same sign both sides) were unaffected. See
// project_tradingview_options_chain_mcp_2026_07_31 memory / RELIABILITY.md.
const MINUS_VARIANTS = /[‐‑‒–—−]/g;

function parseNum(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  // Placeholder "no value" cells render as a lone dash/em-dash/minus glyph.
  if (/^[-‐‑‒–—−]$/.test(trimmed)) return null;
  const cleaned = trimmed.replace(MINUS_VARIANTS, '-').replace(/[,%]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// TradingView's chain table currently renders bid and ask as ONE merged
// column ("Bid × Ask", cell text like "7.05 × 7.20") instead of separate
// "Bid"/"Ask" columns -- confirmed live 2026-08-24 via a raw-cell dump
// (header: [...,"Bid × Ask",...], sample cell "0.01 × 0.02"). Before this
// fix, assignCell's generic path stored the whole thing under one garbage
// key ("bid_×_ask") via parseNum, which only captures the leading number
// (the bid) and drops the ask entirely -- fetch_options_chain_tv.mjs's DB
// writer reads `side.bid`/`side.ask` explicitly (readFullChain.js:244-245),
// so neither ever populated, mid/spread came out null for every contract,
// and expected_move.py's straddle calc (needs mid > 0 on both legs) always
// returned zero usable expirations. This is a distinct bug from the
// 2026-08-24 11:22am "More on options" click-target fix (93c21ba) -- that
// fix got the chain table to open at all; this fixes what's actually inside
// it once open.
const BID_ASK_RE = /bid.*ask/i;

// The Greeks columns are OFF by default in TradingView's column picker
// (confirmed live 2026-08-24: cc_emit_filter.py's hard theta requirement
// rejected 100% of covered-call candidates -- theta was never captured
// because the column simply wasn't enabled, not a parsing bug). Enabled via
// the chain table's "Customize columns" panel (header icon, top-right of
// each side, "Shift C"); the setting is a durable TradingView Desktop
// preference that survives closing/reopening the chain view. Once enabled,
// TradingView renders them as TWO merged columns, each with a stacked
// 2-line cell rather than a single value: "Delta\nGamma" (header text
// "DeltaGamma") and "Theta • Vega\nRho" (header text "Theta • VegaRho") --
// the first line is plain text, the second line lives in a nested
// ".secondary-*" <div>, which is why the raw-cell extraction above now uses
// innerText (preserves the line break) instead of textContent (which
// concatenated both lines into one unparseable run, e.g. "0.160" for
// delta=0.16/gamma=0).
const DELTA_GAMMA_RE = /delta.*gamma/i;
const THETA_VEGA_RHO_RE = /theta.*vega.*rho/i;

/**
 * Turn a raw `readChainTable()` result into structured {expiration, strike,
 * call, put} rows, splitting each row at the Strike column. Column names on
 * each side come directly from the header text, lightly normalized.
 */
function structureRows(tableResult) {
  const { header, strike_index: strikeIdx, rows } = tableResult;
  const leftNames = header.slice(0, strikeIdx).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rightNames = header.slice(strikeIdx + 1).map((h) => h.toLowerCase().replace(/\s+/g, '_'));

  function assignCell(target, rawHeader, name, rawText) {
    if (BID_ASK_RE.test(rawHeader)) {
      // Split "7.05 × 7.20" (also tolerate an ASCII "x") into bid/ask.
      const parts = String(rawText || '').split(/[×x]/i);
      target.bid = parseNum(parts[0]);
      target.ask = parseNum(parts[1]);
      return;
    }
    if (THETA_VEGA_RHO_RE.test(rawHeader)) {
      // Line 1: "theta • vega" (bullet-separated). Line 2 (nested div): rho.
      const lines = String(rawText || '').split('\n');
      const [thetaStr, vegaStr] = String(lines[0] || '').split('•');
      target.theta = parseNum(thetaStr);
      target.vega = parseNum(vegaStr);
      target.rho = parseNum(lines[1]);
      return;
    }
    if (DELTA_GAMMA_RE.test(rawHeader)) {
      // Line 1: delta. Line 2 (nested div): gamma.
      const lines = String(rawText || '').split('\n');
      target.delta = parseNum(lines[0]);
      target.gamma = parseNum(lines[1]);
      return;
    }
    target[name] = parseNum(rawText);
  }

  return rows.map(({ expiration, cells }) => {
    const strike = parseNum(cells[strikeIdx]);
    const call = {};
    leftNames.forEach((name, i) => assignCell(call, header[i], name, cells[i]));
    const put = {};
    rightNames.forEach((name, i) => assignCell(put, header[strikeIdx + 1 + i], name, cells[strikeIdx + 1 + i]));
    return { expiration, strike, call, put };
  }).filter((r) => r.strike !== null);
}

/**
 * Expiration group-header rows (with the real ISO date) exist in the DOM
 * whether or not that group is expanded — only its per-strike data rows
 * require expansion. So this reads instantly with no clicking needed,
 * unlike getStrikes/getChain which expand every group first.
 */
export async function getExpirations({ symbol }) {
  await ensureOptionsChainOpen({ symbol });
  // Retry: if the chain view was already open, no fresh-open settle wait
  // applies, and the table can momentarily not be mounted yet (same race
  // documented on readFullChain).
  const table = await poll(async () => {
    const r = await readChainTable();
    return r.found ? r : null;
  }) || await readChainTable();
  if (!table.found) throw new Error(`Could not read chain table: ${table.reason}`);
  const seen = new Set();
  const expirations = [];
  for (const exp of table.all_expiration_groups) {
    if (!seen.has(exp)) { seen.add(exp); expirations.push(exp); }
  }
  return {
    success: true,
    symbol,
    expirations,
    note: 'ensureOptionsChainOpen widens the "Expiration" filter to "All expirations" before this reads the table, so this covers every listed expiration, not just a default window.',
  };
}

export async function getStrikes({ symbol, expiration }) {
  await ensureOptionsChainOpen({ symbol });
  const table = await readFullChain();
  if (!table.found) throw new Error(`Could not read chain table: ${table.reason}`);
  let structured = structureRows(table);
  if (expiration) structured = structured.filter((r) => r.expiration === expiration);
  return {
    success: true,
    symbol,
    expiration: expiration || null,
    strikes: structured.map((r) => r.strike),
  };
}

export async function getChain({ symbol, expiration, strike }) {
  await ensureOptionsChainOpen({ symbol });
  const table = await readFullChain();
  if (!table.found) throw new Error(`Could not read chain table: ${table.reason}`);
  let structured = structureRows(table);
  if (expiration) structured = structured.filter((r) => r.expiration === expiration);
  if (strike != null) {
    const target = Number(strike);
    structured = structured.filter((r) => Math.abs(r.strike - target) < 1e-6);
  }
  return {
    success: true,
    symbol,
    expiration: expiration || null,
    header_raw: table.header,
    rows: structured,
  };
}
