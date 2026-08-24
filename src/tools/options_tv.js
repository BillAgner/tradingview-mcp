/**
 * Options chain tools sourced directly from TradingView Desktop via CDP
 * (as opposed to the Python/Tradier/yfinance-backed `options_*` tools in
 * `tools/options.js`). Real market bid/ask/spread/volume/IV, both calls and
 * puts, read from TradingView's own options-chain panel.
 *
 * Tools exposed:
 * - options_tv_expirations → valid expiration dates for a symbol
 * - options_tv_strikes     → strikes available (optionally for one expiration)
 * - options_tv_chain       → full call+put chain data (optionally one strike)
 * - options_tv_close       → return the chart to its normal view
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/options_tv.js';

export function registerOptionsTvTools(server) {
  server.tool(
    'options_tv_expirations',
    'Use ONLY when the user specifically asks what expiration dates exist for a symbol\'s options (e.g. "what expirations does TSLA have"), or you need a valid date string before filtering another call to one specific expiration. Do NOT use this for questions about prices, strikes, bid/ask, or greeks — use options_tv_chain or options_tv_strikes for those instead, even on a first call. Returns dates as "YYYY-MM-DD" strings, read live from TradingView Desktop\'s real options-chain panel (genuine market data, NOT yfinance/Tradier).',
    {
      symbol: z.string().describe('Ticker symbol, e.g. TSLA'),
    },
    async ({ symbol }) => {
      try {
        return jsonResult(await core.getExpirations({ symbol }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'options_tv_strikes',
    'Use when the user asks ONLY which strike prices exist for a symbol\'s options, with no interest in prices/bid-ask/greeks (e.g. "what strikes are available for MSTR"). If they want pricing data at all, use options_tv_chain instead — it already includes every strike\'s data, so calling this first is unnecessary. `expiration` is optional (an exact "YYYY-MM-DD" string, e.g. from options_tv_expirations) — omit it to cover every visible expiration. Read live from TradingView Desktop.',
    {
      symbol: z.string().describe('Ticker symbol, e.g. TSLA'),
      expiration: z.string().optional().describe('An exact "YYYY-MM-DD" date. Omit to get strikes across all visible expirations.'),
    },
    async ({ symbol, expiration }) => {
      try {
        return jsonResult(await core.getStrikes({ symbol, expiration }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'options_tv_chain',
    'THE tool for any options pricing question, AND the tool for "get/show me the options chain" requests in general (that phrase means this tool, not options_tv_expirations). Returns bid, ask, spread, volume, open interest, IV, intrinsic/time value, AND real market greeks (delta/gamma/theta/vega/rho/breakeven) per strike, for both calls and puts. Use this directly for questions like "what\'s the bid/ask on the TSLA $300 call", "give me MSTR\'s options chain", "get the full chain for TSLA", "what are the greeks on this strike" — you do NOT need to call options_tv_expirations or options_tv_strikes first; `expiration` and `strike` are both optional filters here, omit both for the complete chain. Read live from TradingView Desktop (genuine market data, NOT yfinance/Tradier). Each row has `call` and `put` objects with the same field names (e.g. `bid`, `ask`, `delta`, `iv`).',
    {
      symbol: z.string().describe('Ticker symbol, e.g. TSLA'),
      expiration: z.string().optional().describe('Optional: an exact "YYYY-MM-DD" date to narrow to one expiration. Omit for all visible expirations.'),
      strike: z.coerce.number().optional().describe('Optional: filter to a single strike price, e.g. 300'),
    },
    async ({ symbol, expiration, strike }) => {
      try {
        return jsonResult(await core.getChain({ symbol, expiration, strike }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'options_tv_close',
    'Optional cleanup: return the chart from the options-chain view back to the normal chart view ("Back to chart"). Not required between calls — options_tv_expirations/strikes/chain all work correctly whether or not the chain view is already open. Call this when you\'re done with options work and want the chart back to normal (e.g. before other chart tools like chart_get_state).',
    {},
    async () => {
      try {
        return jsonResult(await core.closeOptionsChain());
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
