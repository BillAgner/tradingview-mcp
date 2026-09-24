/**
 * Shared mutex for the one TradingView Desktop CDP session, coordinating
 * across every process that can touch it: the Python capture scripts under
 * C:/Data/Hermes/scripts, the .mjs OHLC/ATR scripts (ohlc_atr_lib.mjs's
 * acquireCaptureLock/releaseCaptureLock), and every one of this machine's
 * ~28 Hermes profiles, each of which can spin up its own tradingview-mcp
 * server.js and drive the SAME chart page with zero prior coordination.
 *
 * Reuses the exact lock file and JSON shape ohlc_atr_lib.mjs already writes
 * (pid/watchlists/startedAt) rather than inventing a second mechanism — this
 * file just adds fields that file never reads, so both stay compatible.
 * Added 2026-09-21 after confirming (not inferring) that connection.js had
 * zero mutual exclusion and zero release path: profiles with the
 * `tradingview` MCP tool enabled (28 of ~29) were found holding CDP clients
 * open for 1-2+ days with no cron job driving them.
 *
 * Two lock tiers, one file:
 *  - "automatic": taken internally around a single mutating operation
 *    (withLock). Short-lived, sized to the operation.
 *  - "agent": taken explicitly via the tv_lock_acquire/tv_lock_release MCP
 *    tools so an agent can hold exclusivity across several tool calls in a
 *    row. Hard-capped well under the script tier's staleness window so a
 *    crashed or forgetful agent can never block the system for long.
 *
 * Deadlock safety is the whole point of the TTL: a lock older than its own
 * ttlMs is always treated as abandoned and silently taken over (matching the
 * stale-takeover behavior ohlc_atr_lib.mjs already has in production) —
 * nothing here can block forever.
 */
import fs from 'fs';

const LOCK_PATH = process.env.TV_LOCK_PATH_OVERRIDE || 'C:/Data/Hermes/skills/tradingview-desktop/scripts/.tv_capture.lock';
const SCRIPT_STALE_MS = 20 * 60 * 1000; // matches ohlc_atr_lib.mjs; untouched for script-held locks with no ttlMs of their own
const AGENT_DEFAULT_TTL_MS = 60 * 1000;
const AGENT_MAX_TTL_MS = 5 * 60 * 1000;
const AUTOMATIC_WAIT_MS = 90 * 1000; // mirrors fetch_options_chain_tv.py's wait-then-proceed policy
const AUTOMATIC_POLL_MS = 1000;

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function isStale(info) {
  if (!info || typeof info.startedAt !== 'number') return true;
  const ttl = typeof info.ttlMs === 'number' ? info.ttlMs : SCRIPT_STALE_MS;
  return Date.now() - info.startedAt >= ttl;
}

function writeLock(info) {
  fs.writeFileSync(LOCK_PATH, JSON.stringify(info));
}

function releaseIfOwnedByToken(token) {
  const info = readLock();
  if (info && info.token === token) {
    try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
    return true;
  }
  return false;
}

function logEvent(msg) {
  process.stderr.write(`[tv-lock] ${new Date().toISOString()} ${msg}\n`);
}

export function currentLockStatus() {
  const info = readLock();
  if (!info) return { held: false };
  const stale = isStale(info);
  return { held: !stale, stale, info };
}

// Tracks a lock this PROCESS currently owns via withLock, so nested
// automatic calls within the same process (e.g. one tool calling another
// internally) don't wait on themselves.
let activeAutomaticToken = null;

/**
 * Run `fn` holding the shared lock. Waits briefly if held by someone else,
 * then proceeds regardless (best-effort — matches the existing Python
 * wait_if_locked policy) so a hung interactive agent can never deadlock a
 * cron job. Re-entrant within the same process.
 */
export async function withLock(reason, fn, { waitMs = AUTOMATIC_WAIT_MS, ttlMs = AGENT_DEFAULT_TTL_MS } = {}) {
  const existing = readLock();
  if (existing && existing.token === activeAutomaticToken && !isStale(existing)) {
    return fn(); // already held by us further up the call stack
  }

  const deadline = Date.now() + waitMs;
  let info = readLock();
  while (info && !isStale(info) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, AUTOMATIC_POLL_MS));
    info = readLock();
  }
  if (info && !isStale(info)) {
    logEvent(`proceeding without exclusivity after ${waitMs}ms wait; held by pid=${info.pid} kind=${info.holderKind} reason=${info.reason}`);
  } else if (info && isStale(info)) {
    logEvent(`taking over stale lock (holder pid=${info.pid} reason=${info.reason})`);
  }

  const token = `auto-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeLock({ pid: process.pid, holderKind: 'automatic', reason, token, startedAt: Date.now(), ttlMs });
  const prevActive = activeAutomaticToken;
  activeAutomaticToken = token;
  try {
    return await fn();
  } finally {
    activeAutomaticToken = prevActive;
    releaseIfOwnedByToken(token);
  }
}

/** Explicit acquire for the tv_lock_acquire tool. Does not wait — an agent
 *  that finds it held should back off and retry itself. */
export function acquireExplicit({ reason, profile, ttlSeconds }) {
  const info = readLock();
  if (info && !isStale(info)) {
    return { acquired: false, holder: info };
  }
  const ttlMs = Math.min(Math.max((Number(ttlSeconds) || AGENT_DEFAULT_TTL_MS / 1000) * 1000, 1000), AGENT_MAX_TTL_MS);
  const token = `agent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeLock({ pid: process.pid, holderKind: 'agent', profile: profile || null, reason: reason || null, token, startedAt: Date.now(), ttlMs });
  logEvent(`agent lock acquired pid=${process.pid} profile=${profile || '?'} reason=${reason || '?'} ttlMs=${ttlMs}`);
  return { acquired: true, token, ttlMs, expiresAt: Date.now() + ttlMs };
}

export function releaseExplicit(token) {
  const released = releaseIfOwnedByToken(token);
  if (released) logEvent(`agent lock released token=${token}`);
  return { released };
}

/**
 * Release whatever automatic lock THIS process currently holds, if any.
 * Call on process termination (SIGINT/SIGTERM/exit).
 *
 * WHY THIS MATTERS (2026-09-21, confirmed live): pre-existing lock readers
 * (fetch_options_chain_tv.py's _lock_holder(), the TSLA dense-snap script's
 * equivalent, ohlc_atr_lib.mjs) predate ttlMs and don't know it exists --
 * they all use a hardcoded 20-minute staleness window regardless of what
 * ttlMs says. withLock()'s own isStale() check correctly treats a short-
 * lived automatic lock as dead within seconds of its real ttlMs, but if the
 * process holding it is killed before withLock's `finally` runs, those
 * OLDER readers still see the file and wait out the full 20 minutes before
 * concluding it's abandoned -- confirmed live: a killed options_tv_chain
 * call blocked a real TSLA dense-snap cron job on exactly this. Calling
 * this on termination closes that window by deleting the file outright
 * instead of leaving it for another consumer's slower staleness check.
 */
export function releaseActive() {
  if (!activeAutomaticToken) return { released: false };
  const released = releaseIfOwnedByToken(activeAutomaticToken);
  activeAutomaticToken = null;
  if (released) logEvent('released active lock on process termination');
  return { released };
}
