/**
 * Options chain tools — pulls options data from Tradier (preferred) or yfinance (fallback).
 * Designed for short-dated covered-call screening.
 *
 * Tools exposed:
 * - options_chain       → full short-dated options chain for a symbol
 * - options_expirations → list available expirations with DTE
 * - options_screen      → screen by strike buffer, DTE range, delta range
 * - options_greeks      → compute BS greeks for a hypothetical option
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/options.js';

export function registerOptionsTools(server) {
  server.tool(
    'options_chain',
    'Get full options chain for short-dated covered calls. Pulls from Tradier (preferred) or yfinance (fallback). Returns calls with bid/ask/IV/volume/OI.',
    {
      symbol: z.string().describe('Ticker symbol, e.g. TSLA'),
      min_dte: z.coerce.number().optional().describe('Minimum days to expiry (default 0)'),
      max_dte: z.coerce.number().optional().describe('Maximum days to expiry (default 7)'),
      prefer: z.enum(['auto', 'tradier', 'yfinance']).optional().describe('Backend preference (default auto: tradier if TRADIER_API_KEY set, else yfinance)'),
      spot_override: z.coerce.number().optional().describe('Override spot price (skip auto-detection)'),
    },
    async ({ symbol, min_dte, max_dte, prefer, spot_override }) => {
      try {
        return jsonResult(await core.getChain({ symbol, minDte: min_dte ?? 0, maxDte: max_dte ?? 7, prefer: prefer ?? 'auto', spotOverride: spot_override }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'options_expirations',
    'List available option expiration dates with DTE for a symbol.',
    {
      symbol: z.string().describe('Ticker symbol'),
      prefer: z.enum(['auto', 'tradier', 'yfinance']).optional().describe('Backend preference'),
    },
    async ({ symbol, prefer }) => {
      try {
        return jsonResult(await core.getExpirations({ symbol, prefer: prefer ?? 'auto' }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'options_screen',
    'Screen short-dated options by strike buffer (min/max % above spot) and delta range. Returns filtered calls ranked by score.',
    {
      symbol: z.string().describe('Ticker symbol'),
      min_buffer_pct: z.coerce.number().optional().describe('Min % OTM (default 2.0)'),
      max_buffer_pct: z.coerce.number().optional().describe('Max % OTM (default 15.0)'),
      max_dte: z.coerce.number().optional().describe('Max days to expiry (default 7)'),
      max_delta: z.coerce.number().optional().describe('Max delta (default 0.50, filters out high-ITM strikes)'),
      prefer: z.enum(['auto', 'tradier', 'yfinance']).optional().describe('Backend preference'),
    },
    async ({ symbol, min_buffer_pct, max_buffer_pct, max_dte, max_delta, prefer }) => {
      try {
        return jsonResult(await core.screenOptions({
          symbol,
          minBufferPct: min_buffer_pct ?? 2.0,
          maxBufferPct: max_buffer_pct ?? 15.0,
          maxDte: max_dte ?? 7,
          maxDelta: max_delta ?? 0.50,
          prefer: prefer ?? 'auto',
        }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'options_greeks',
    'Compute Black-Scholes call price + greeks (delta, gamma, theta, vega) for a hypothetical option.',
    {
      spot: z.coerce.number().describe('Underlying spot price'),
      strike: z.coerce.number().describe('Strike price'),
      days_to_expiry: z.coerce.number().describe('Days to expiration (e.g. 5 for weekly)'),
      iv: z.coerce.number().describe('Annualized implied volatility as decimal (e.g. 0.50 for 50%)'),
      rfr: z.coerce.number().optional().describe('Risk-free rate annual decimal (default 0.045)'),
    },
    async ({ spot, strike, days_to_expiry, iv, rfr }) => {
      try {
        return jsonResult(await core.computeGreeks({ spot, strike, daysToExpiry: days_to_expiry, iv, rfr: rfr ?? 0.045 }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}