// In-memory mocks of the Apps Script services that run apps-script/Code.gs under Node.
// Shared by the test suite and the local mock webhook server.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'Code.gs'), 'utf8');
const API_SECRET = 'test-api-secret';
const WEBSITE_SECRET = 'test-website-secret';

// --- Mocks ------------------------------------------------------------------

class MockSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.maxRows = 1000;
    this.formats = {};
  }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) {
      if ((this.data[r - 1] || []).some((v) => v !== '' && v !== undefined)) return r;
    }
    return 0;
  }
  getLastColumn() {
    return this.data.reduce((m, row) => {
      let last = 0;
      (row || []).forEach((v, i) => { if (v !== '' && v !== undefined) last = i + 1; });
      return Math.max(m, last);
    }, 0);
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  setFrozenRows() {}
  clearContents() { this.data = []; }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error('Bad range');
    if (row + numRows - 1 > this.maxRows) throw new Error('Range exceeds max rows');
    const sheet = this;
    const cell = (r, c) => ((sheet.data[r - 1] || [])[c - 1] ?? '');
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(cell(row + r, col + c));
          out.push(line);
        }
        return out;
      },
      getValue() { return cell(row, col); },
      setValues(values) {
        assert.equal(values.length, numRows, 'setValues row count');
        values.forEach((line, r) => {
          assert.equal(line.length, numCols, 'setValues column count');
          while (sheet.data.length < row + r) sheet.data.push([]);
          line.forEach((v, c) => { sheet.data[row + r - 1][col + c - 1] = v; });
        });
        return this;
      },
      setNumberFormat(f) { sheet.formats[col] = f; return this; },
    };
  }
}

function makeContext(seed) {
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new MockSheet(n)),
    setSpreadsheetTimeZone() {},
  };
  const cache = new Map();
  const cacheTtls = new Map();
  const mapsCalls = [];
  // console.warn / console.error output, for tests that assert on logging.
  const logs = { warn: [], error: [] };
  // Script Properties, editable by a test; FASTFIELD_* are unset by default (FastField off).
  const props = { API_SECRET, WEBSITE_SECRET };
  // Every UrlFetchApp request, and what to answer with (a test can replace `respond`).
  const fetchCalls = [];
  // Whether the sheet lock is held right now, how long each acquisition was willing to wait, and a
  // hook for a test to refuse a particular wait.
  const lock = { held: false, waits: [], deny: () => false };
  const logger = [];
  const fetcher = { respond: () => ({ code: 200, body: JSON.stringify({ dispatchId: 'FF-1001' }) }) };
  const geocodeCalls = [];
  const ctx = {
    console: { log() {}, warn: (...a) => logs.warn.push(a.join(' ')), error: (...a) => logs.error.push(a.join(' ')) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: {
      getScriptLock: () => ({
        tryLock: (ms) => {
          lock.waits.push(ms);
          if (lock.deny(ms)) return false;
          lock.held = true;
          return true;
        },
        releaseLock() { lock.held = false; },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] || null,
      }),
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetchCalls.push({ url, options, lockHeld: lock.held });
        const answer = fetcher.respond(url, options);
        if (answer instanceof Error) throw answer;
        return {
          getResponseCode: () => answer.code,
          getContentText: () => answer.body,
          getAllHeaders: () => answer.headers || { 'Content-Type': 'application/json' },
        };
      },
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v, ttl) => { cache.set(k, v); cacheTtls.set(k, ttl); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    Logger: { log: (...a) => logger.push(a.join(' ')) },
    ScriptApp: { getService: () => ({ getUrl: () => 'http://127.0.0.1:8787/exec' }) },
    HtmlService: {
      createHtmlOutput: (html) => {
        const out = { kind: 'html', html, title: '', meta: {} };
        out.setTitle = (t) => { out.title = t; return out; };
        out.addMetaTag = (n, c) => { out.meta[n] = c; return out; };
        return out;
      },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (alg, s) => [...crypto.createHash(alg).update(s).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
    },
    Maps: {
      DirectionFinder: { Mode: { DRIVING: 'driving' } },
      // Deterministic fake: the address embeds the coordinates. lat 0 has no address; lat 1 throws.
      newGeocoder: () => ({
        reverseGeocode(lat, lng) {
          geocodeCalls.push([lat, lng]);
          if (lat === 1) throw new Error('geocoder quota');
          if (lat === 0) return { status: 'ZERO_RESULTS', results: [] };
          return { status: 'OK', results: [{ formatted_address: `${lat} ${lng} Mock St, Sacramento, CA 95814, USA` }] };
        },
      }),
      newDirectionFinder() {
        const q = {};
        const f = {
          setOrigin(o) { q.o = o; return f; },
          setDestination(d) { q.d = d; return f; },
          setRegion() { return f; },
          setMode() { return f; },
          getDirections() {
            mapsCalls.push(`${q.o} -> ${q.d}`);
            if (q.d === 'nowhere') return { routes: [] };
            // Deterministic fake distance: 16093.44 m = 10.0 mi
            return { routes: [{ legs: [{ distance: { value: 16093.44 } }] }] };
          },
        };
        return f;
      },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ setMimeType: () => ({ content: s }) }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  ctx.setup();
  if (seed) seed(sheets['Call Log']);
  return {
    ctx, sheet: sheets['Call Log'], ref: sheets['Reference Data'], mapsCalls,
    props, fetchCalls, fetcher, logs, lock, logger,
    cache, cacheTtls, geocodeCalls,
    /** Simulates the 15 minutes passing. */
    expireCache: () => cache.clear(),
  };
}

function post(env, body, query = {}) {
  const e = { parameter: query, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } };
  return JSON.parse(env.ctx.doPost(e).content);
}

/** doGet with query parameters. Returns parsed JSON for the health check, or the HTML output. */
function get(env, query = {}) {
  const out = env.ctx.doGet({ parameter: query });
  return out.kind === 'html' ? out : JSON.parse(out.content);
}

function rowObj(env, rowNum) {
  const header = env.sheet.data[0];
  const row = env.sheet.data[rowNum - 1] || [];
  return Object.fromEntries(header.map((h, i) => [h, row[i] ?? '']));
}

function dataRowCount(env) { return env.sheet.getLastRow() - 1; }

module.exports = { API_SECRET, WEBSITE_SECRET, MockSheet, makeContext, post, get, rowObj, dataRowCount };
