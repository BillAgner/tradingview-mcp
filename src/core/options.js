/**
 * Options chain core logic. Wraps a Python subprocess that calls the
 * trade-vision skill's options_screen.py — Python has better libraries
 * (yfinance, urllib) than Node for fetching options data.
 *
 * Returns structured JSON for the MCP tools to format.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Resolve the path to the trade-vision skill scripts directory.
 */
function scriptsDir() {
  return 'C:/Data/Hermes/skills/trade-vision/scripts';
}

/**
 * Resolve the Python interpreter (Hermes venv).
 * Note: C:/Data/Hermes 0.17.0/.venv also exists but lacks numpy/yfinance —
 * `venv` (no dot) is the one with the packages options_screen.py needs.
 */
function pythonExe() {
  return 'C:/Data/Hermes 0.17.0/venv/Scripts/python.exe';
}

/**
 * Run a Python script with JSON args. Returns parsed stdout.
 */
function runPython(script, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const argsJson = JSON.stringify(args);
    const proc = spawn(pythonExe(), [path.join(scriptsDir(), script), '--json-args', argsJson], {
      windowsHide: true,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`script ${script} exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        // Last non-empty line of stdout should be the JSON result
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        resolve(JSON.parse(lastLine));
      } catch (err) {
        reject(new Error(`failed to parse Python output: ${err.message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Wrap a Python call to handle errors uniformly.
 */
async function pyCall(script, args) {
  try {
    return { success: true, ...(await runPython(script, args)) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getChain({ symbol, minDte, maxDte, prefer, spotOverride }) {
  return await pyCall('mcp_options_helper.py', {
    action: 'chain',
    symbol,
    min_dte: minDte,
    max_dte: maxDte,
    prefer,
    spot_override: spotOverride ?? null,
  });
}

export async function getExpirations({ symbol, prefer }) {
  return await pyCall('mcp_options_helper.py', {
    action: 'expirations',
    symbol,
    prefer,
  });
}

export async function screenOptions({ symbol, minBufferPct, maxBufferPct, maxDte, maxDelta, prefer }) {
  return await pyCall('mcp_options_helper.py', {
    action: 'screen',
    symbol,
    min_buffer_pct: minBufferPct,
    max_buffer_pct: maxBufferPct,
    max_dte: maxDte,
    max_delta: maxDelta,
    prefer,
  });
}

export async function computeGreeks({ spot, strike, daysToExpiry, iv, rfr }) {
  return await pyCall('mcp_options_helper.py', {
    action: 'greeks',
    spot,
    strike,
    days_to_expiry: daysToExpiry,
    iv,
    rfr,
  });
}