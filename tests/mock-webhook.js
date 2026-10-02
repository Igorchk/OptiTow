// Local stand-in for the Apps Script web app: runs the real apps-script/Code.gs against an
// in-memory sheet so a Debug build of the iOS app can sync end to end.
//
//   node tests/mock-webhook.js [port]
//
// Secrets.plist: WEBHOOK_URL = http://127.0.0.1:8787/exec, API_SECRET = test-api-secret
//
//   GET  /rows           current Call Log rows as JSON
//   POST /__mode/<mode>  ok (default) | busy (answer BUSY) | down (drop connections)
'use strict';

const http = require('node:http');
const { API_SECRET, makeContext, rowObj, dataRowCount } = require('./support/gas-mock');

const port = Number(process.argv[2] || 8787);
const env = makeContext();
let mode = 'ok';

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method === 'GET' && url.pathname === '/rows') {
      const rows = [];
      for (let r = 2; r <= dataRowCount(env) + 1; r++) rows.push(rowObj(env, r));
      return send(res, 200, rows);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/__mode/')) {
      mode = url.pathname.slice('/__mode/'.length);
      console.log(`mode -> ${mode}`);
      return send(res, 200, { mode });
    }
    if (req.method === 'POST' && url.pathname === '/exec') {
      if (mode === 'down') return req.socket.destroy();
      if (mode === 'busy') {
        console.log('POST /exec -> BUSY (simulated)');
        return send(res, 200, { ok: false, code: 'BUSY', error: 'Simulated busy sheet.' });
      }
      const parameter = Object.fromEntries(url.searchParams);
      const out = JSON.parse(env.ctx.doPost({ parameter, postData: { contents: raw } }).content);
      console.log(`POST /exec ${parameter.source || 'app'} -> ${out.ok ? out.action : out.code} ${out.call_id || ''}`);
      if (process.env.LOG_KEYS) console.log('  keys: ' + Object.keys(JSON.parse(raw)).join(','));
      return send(res, 200, out);
    }
    send(res, 404, { error: 'not found' });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Mock webhook on http://127.0.0.1:${port}/exec (API_SECRET=${API_SECRET})`);
});
