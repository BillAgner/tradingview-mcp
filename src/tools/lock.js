import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/lock.js';

export function registerLockTools(server) {
  server.tool(
    'tv_lock_status',
    'Check whether the shared TradingView Desktop CDP lock is currently held, by whom, and why — before deciding whether to acquire it. Read-only, never blocks.',
    {},
    async () => {
      try { return jsonResult(core.currentLockStatus()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'tv_lock_acquire',
    'Claim exclusive use of TradingView Desktop for a short sequence of upcoming tool calls (e.g. switching symbols, opening the options chain, reading several values, then returning to the prior view). TradingView Desktop is a single shared resource across every Hermes profile — acquire this before any multi-step interactive sequence so another profile cannot change the chart out from under you mid-sequence. Do NOT acquire it for a single one-off read-only call. Always call tv_lock_release when your sequence is done, even on error. If acquisition fails because it is already held, back off and retry shortly rather than proceeding — do not assume the chart is in the state you expect. The lock self-expires after ttl_seconds regardless of whether you release it, so it can never block the system forever, but that expiry is a safety net, not a substitute for releasing it yourself.',
    {
      profile: z.string().describe('Your own Hermes profile name (e.g. "tradestrategist"), so other profiles can see who is holding the lock.'),
      reason: z.string().describe('Short human-readable description of what you are about to do, e.g. "reading TSLA 0DTE chain for morning report"'),
      ttl_seconds: z.coerce.number().optional().describe('Max seconds to hold the lock (default 60, hard-capped at 300). Pick the smallest value that comfortably covers your sequence.'),
    },
    async ({ profile, reason, ttl_seconds }) => {
      try {
        return jsonResult(core.acquireExplicit({ reason, profile, ttlSeconds: ttl_seconds }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'tv_lock_release',
    'Release a lock you previously acquired with tv_lock_acquire, using the token it returned. Call this as soon as your sequence is done — do not wait for it to expire.',
    {
      token: z.string().describe('The token returned by tv_lock_acquire'),
    },
    async ({ token }) => {
      try { return jsonResult(core.releaseExplicit(token)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
