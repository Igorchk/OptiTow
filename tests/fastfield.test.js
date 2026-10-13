// FastField dispatch (outbound task for a won call) and the return webhook (receipt PDF link),
// plus the 31 -> 33 column self-migration. Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { API_SECRET, makeContext, post, rowObj, dataRowCount } = require('./support/gas-mock');

const WON = '1 - Won / Booked';
const LOST = '0 - Lost / Declined';
const FF_URL = 'https://api.fastfieldforms.com/services/v3/dispatches';
const FORMS_URL = 'https://api.fastfieldforms.com/services/v3/forms';
const PDF = 'https://reports.fastfieldforms.com/receipts/abc123.pdf';

function configure(env) {
  Object.assign(env.props, {
    FASTFIELD_API_KEY: 'ff-key-123',
    FASTFIELD_FORM_ID: '98765',
    FASTFIELD_USER_ID: 'driver@recoverytowing.example',
  });
  return env;
}

function appPayload(overrides = {}) {
  return Object.assign({
    token: API_SECRET,
    call_id: 'JOB-0001',
    date_time: new Date().toISOString(),
    customer_phone: '916-555-0199',
    service_requested: 'Standard Tow',
    vehicle_year: '2021',
    vehicle_make: 'Tesla',
    vehicle_model: 'Model 3',
    pickup_address: '123 Main St, Sacramento, CA',
    dropoff_address: '456 Auto Body Way, Rocklin, CA',
    quoted_price: 285,
    outcome: WON,
    notes_comments: 'Customer stuck on shoulder.',
  }, overrides);
}

const hook = (body, query = {}) => ({ token: API_SECRET, ...body, ...query });
const FF_QUERY = { source: 'fastfield', token: API_SECRET };

// --- dispatchToFastField_ ----------------------------------------------------

test('dispatch: a won call posts the right request and returns the task id', () => {
  const env = configure(makeContext());
  const id = env.ctx.dispatchToFastField_({
    call_id: 'JOB-0001', outcome: 1, customer_phone: '916-555-0199', vehicle_year: 2021,
    vehicle_make: 'Tesla', vehicle_model: 'Model 3', pickup_address: 'A', dropoff_address: 'B',
    service_requested: 'Standard Tow', notes_comments: 'No keys', quoted_price: 285,
  });
  assert.equal(id, 'FF-1001');
  assert.equal(env.fetchCalls.length, 1);
  const { url, options } = env.fetchCalls[0];
  assert.equal(url, FF_URL);
  assert.equal(options.method, 'post');
  assert.equal(options.contentType, 'application/json');
  assert.equal(options.headers.Authorization, 'Bearer ff-key-123');
  assert.equal(options.muteHttpExceptions, true);
  const payload = JSON.parse(options.payload);
  assert.equal(payload.formId, 98765);
  assert.equal(typeof payload.formId, 'number');
  assert.deepEqual(payload.users, ['driver@recoverytowing.example']);
  assert.equal(payload.autoCreateUsers, false);
  assert.equal(payload.assignedUserId, undefined, 'v1 field is gone');
  assert.equal(payload.fields, undefined, 'v1 field is gone');
  assert.deepEqual(Object.keys(payload).sort(), ['autoCreateUsers', 'formId', 'mergeFields', 'users']);
  assert.deepEqual(Object.keys(payload.mergeFields).sort(),
    ['alpha_1', 'alpha_13', 'alpha_3', 'alpha_4', 'alpha_9', 'formattedinput_1', 'listpicker_2', 'multiline_1', 'numeric_1']);
  assert.deepEqual(payload.mergeFields, {
    alpha_1: 'JOB-0001', multiline_1: 'No keys | Quoted: $285', formattedinput_1: '916-555-0199', numeric_1: 2021,
    alpha_3: 'Tesla', alpha_4: 'Model 3', alpha_9: 'A', alpha_13: 'B', listpicker_2: 'Standard Tow',
  });
});

test('dispatch: the outcome text, a missing year and a missing note all behave', () => {
  const env = configure(makeContext());
  env.ctx.dispatchToFastField_({ call_id: 'J', outcome: WON, quoted_price: 100 });
  const fields = JSON.parse(env.fetchCalls[0].options.payload).mergeFields;
  assert.equal(fields.numeric_1, null);
  assert.equal(fields.multiline_1, 'Quoted: $100', 'no stray separator when there are no notes');
  assert.equal(fields.alpha_3, '');
});

test('dispatch: a lost call is never sent', () => {
  const env = configure(makeContext());
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 0 }), null);
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: LOST }), null);
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J' }), null);
  assert.equal(env.fetchCalls.length, 0);
});

test('dispatch: missing or blank credentials skip quietly with a warning', () => {
  for (const missing of ['FASTFIELD_API_KEY', 'FASTFIELD_FORM_ID', 'FASTFIELD_USER_ID']) {
    const env = configure(makeContext());
    env.props[missing] = '   ';
    assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
    assert.equal(env.fetchCalls.length, 0, missing);
    assert.ok(env.logs.warn.some((w) => w.includes(missing)), missing);
  }
  const bare = makeContext();
  assert.equal(bare.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(bare.fetchCalls.length, 0);
});

test('dispatch: a non-numeric form id is skipped, not sent', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_FORM_ID = 'abc';
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(env.fetchCalls.length, 0);
});

test('dispatch: accepts 200 or 201 and a dispatchId, taskId or id in the reply', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => ({ code: 201, body: JSON.stringify({ taskId: 'T-7' }) });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), 'T-7');
  env.fetcher.respond = () => ({ code: 200, body: JSON.stringify({ id: 4242 }) });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), '4242');
  env.fetcher.respond = () => ({ code: 200, body: JSON.stringify({ dispatchId: 'D-1', id: 'ignored' }) });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), 'D-1');
});

test('dispatch: HTTP errors, bad bodies and thrown fetches return null and log', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => ({ code: 401, body: '{"error":"bad key"}' });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.ok(env.logs.error.some((e) => e.includes('401') && e.includes('bad key')));
  env.fetcher.respond = () => ({ code: 200, body: 'not json' });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  env.fetcher.respond = () => ({ code: 200, body: '{"ok":true}' });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  env.fetcher.respond = () => new Error('DNS error');
  assert.doesNotThrow(() => env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }));
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.ok(env.logs.error.some((e) => e.includes('DNS error')));
});

test('dispatch: the API key is sent only in the header, never logged', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => ({ code: 500, body: 'oops' });
  env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 });
  assert.ok(!env.logs.error.concat(env.logs.warn).some((l) => l.includes('ff-key-123')));
  assert.ok(!env.fetchCalls[0].options.payload.includes('ff-key-123'));
});

// --- the app sync path -------------------------------------------------------

test('app sync: a won call is dispatched and its task id stored in column 32', () => {
  const env = configure(makeContext());
  const res = post(env, appPayload());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(env.fetchCalls.length, 1);
  const row = rowObj(env, res.row);
  assert.equal(row.FastField_Task_ID, 'FF-1001');
  assert.equal(row.Receipt_PDF_URL, '');
  assert.equal(env.sheet.data[0].indexOf('FastField_Task_ID'), 31);
  assert.equal(env.sheet.data[0].indexOf('Receipt_PDF_URL'), 32);
});

test('app sync: a lost call, an unconfigured FastField and a failed dispatch all still save the row', () => {
  const lost = configure(makeContext());
  const a = post(lost, appPayload({ outcome: LOST, decline_reason: 'Price Too High' }));
  assert.equal(a.ok, true);
  assert.equal(lost.fetchCalls.length, 0);
  assert.equal(rowObj(lost, a.row).FastField_Task_ID, '');

  const bare = makeContext();
  const b = post(bare, appPayload());
  assert.equal(b.ok, true);
  assert.equal(bare.fetchCalls.length, 0);
  assert.equal(rowObj(bare, b.row).FastField_Task_ID, '');
  assert.equal(rowObj(bare, b.row).Receipt_PDF_URL, '');

  const failing = configure(makeContext());
  failing.fetcher.respond = () => ({ code: 500, body: 'down' });
  const c = post(failing, appPayload());
  assert.equal(c.ok, true, 'a FastField outage never fails the save');
  assert.equal(rowObj(failing, c.row).FastField_Task_ID, '');
  assert.equal(rowObj(failing, c.row).Call_ID, 'JOB-0001');
});

test('app sync: re-syncing a dispatched call does not dispatch twice; a failed one is retried', () => {
  const env = configure(makeContext());
  post(env, appPayload());
  post(env, appPayload({ notes_comments: 'Updated note' }));
  assert.equal(env.fetchCalls.length, 1, 'already has a task id');
  assert.equal(dataRowCount(env), 1);

  const retry = configure(makeContext());
  retry.fetcher.respond = () => ({ code: 500, body: 'down' });
  const first = post(retry, appPayload());
  assert.equal(rowObj(retry, first.row).FastField_Task_ID, '');
  retry.fetcher.respond = () => ({ code: 200, body: JSON.stringify({ dispatchId: 'FF-2' }) });
  const second = post(retry, appPayload());
  assert.equal(second.row, first.row);
  assert.equal(rowObj(retry, second.row).FastField_Task_ID, 'FF-2');
  assert.equal(retry.fetchCalls.length, 2);
});

test('app sync: an existing task id and receipt are never blanked by a later sync', () => {
  const env = configure(makeContext());
  const first = post(env, appPayload());
  post(env, { ...hook({ alpha_1: 'JOB-0001', pdfUrl: PDF }), }, FF_QUERY);
  post(env, appPayload({ quoted_price: 300 }));
  const row = rowObj(env, first.row);
  assert.equal(row.FastField_Task_ID, 'FF-1001');
  assert.equal(row.Receipt_PDF_URL, PDF);
  assert.equal(row.Quoted_Price, 300);
});

// --- two-phase lock ----------------------------------------------------------

test('lock: FastField is called with the sheet lock released, after the row is already saved', () => {
  const env = configure(makeContext());
  let seenAtFetch = null;
  env.fetcher.respond = () => {
    seenAtFetch = { held: env.lock.held, rows: env.sheet.getLastRow() - 1, row: rowObj(env, 2) };
    return { code: 200, body: JSON.stringify({ dispatchId: 'FF-9' }) };
  };
  const res = post(env, appPayload());
  assert.equal(res.ok, true);
  assert.equal(seenAtFetch.held, false, 'no lock during the network call');
  assert.equal(env.fetchCalls[0].lockHeld, false);
  assert.equal(seenAtFetch.rows, 1, 'the row was written before FastField was asked');
  assert.equal(seenAtFetch.row.Call_ID, 'JOB-0001');
  assert.equal(seenAtFetch.row.FastField_Task_ID, '', 'id is blank until phase 3');
  assert.equal(rowObj(env, res.row).FastField_Task_ID, 'FF-9');
  assert.equal(env.lock.held, false, 'lock released at the end');
});

test('lock: the stamp takes a short lock (5 s) and only writes the task id', () => {
  const env = configure(makeContext());
  post(env, appPayload());
  assert.deepEqual(env.lock.waits, [20000, 5000]);
  const before = rowObj(env, 2);
  assert.equal(before.FastField_Task_ID, 'FF-1001');
  assert.equal(before.Quoted_Price, 285);
});

test('lock: no dispatch means no second lock', () => {
  const env = configure(makeContext());
  post(env, appPayload({ outcome: LOST }));
  assert.deepEqual(env.lock.waits, [20000]);
  const bare = makeContext();
  post(bare, appPayload());
  assert.deepEqual(bare.lock.waits, [20000]);
});

test('lock: a second sync of the same call during the FastField request does not dispatch again', () => {
  const env = configure(makeContext());
  let nested = null;
  env.fetcher.respond = () => {
    if (!nested) nested = post(env, appPayload({ notes_comments: 'edited while FastField was busy' }));
    return { code: 200, body: JSON.stringify({ dispatchId: 'FF-5' }) };
  };
  const res = post(env, appPayload());
  assert.equal(nested.ok, true);
  assert.equal(env.fetchCalls.length, 1, 'only the first request talks to FastField');
  assert.equal(rowObj(env, res.row).FastField_Task_ID, 'FF-5');
  assert.equal(rowObj(env, res.row).Notes_Comments, 'edited while FastField was busy');
  assert.equal(dataRowCount(env), 1);
});

test('lock: another call is saved while FastField is slow, and a failed dispatch frees the next sync', () => {
  const env = configure(makeContext());
  let other = null;
  env.fetcher.respond = () => {
    if (!other) other = post(env, appPayload({ call_id: 'JOB-0002', customer_phone: '916-555-0177', outcome: LOST }));
    return { code: 500, body: 'down' };
  };
  post(env, appPayload());
  assert.equal(other.ok, true, 'the sheet was not locked while FastField was being asked');
  assert.equal(dataRowCount(env), 2);
  env.fetcher.respond = () => ({ code: 200, body: JSON.stringify({ dispatchId: 'FF-6' }) });
  const retry = post(env, appPayload());
  assert.equal(rowObj(env, retry.row).FastField_Task_ID, 'FF-6', 'the in-flight mark was released after the failure');
});

test('lock: the in-flight mark is released even if the request throws', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => new Error('boom');
  const first = post(env, appPayload());
  assert.equal(first.ok, true);
  env.fetcher.respond = () => ({ code: 200, body: JSON.stringify({ dispatchId: 'FF-7' }) });
  assert.equal(rowObj(env, post(env, appPayload()).row).FastField_Task_ID, 'FF-7');
});

test('lock: if the stamp cannot get the lock the call still saves, and the id is logged and warned about', () => {
  const env = configure(makeContext());
  env.lock.deny = (ms) => ms === 5000;
  const res = post(env, appPayload());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rowObj(env, res.row).FastField_Task_ID, '');
  assert.ok(res.warnings.some((w) => w.includes('FF-1001')));
  assert.ok(env.logs.error.some((e) => e.includes('FF-1001')));
  assert.equal(env.lock.held, false);
});

test('lock: the stamp never overwrites a task id that is already there', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => {
    env.sheet.data[1][31] = 'EARLIER-ID';
    return { code: 200, body: JSON.stringify({ dispatchId: 'FF-8' }) };
  };
  const res = post(env, appPayload());
  assert.equal(rowObj(env, res.row).FastField_Task_ID, 'EARLIER-ID');
});

// --- testFastFieldDispatch ---------------------------------------------------

const FORMS = [{ id: 11111, name: 'Inspection' }, { id: 98765, name: 'Recovery Towing Service Form' }];

/** Answers the forms list and the dispatch like FastField would. */
function fastFieldServer(env, { forms = { code: 200, body: JSON.stringify(FORMS) }, dispatch } = {}) {
  env.fetcher.respond = (url) => (url === FORMS_URL
    ? forms
    : (dispatch || { code: 201, body: JSON.stringify({ dispatchId: 'T-55' }), headers: { 'X-Req': 'abc' } }));
}

test('testFastFieldDispatch: verifies the key and form, then sends a marked test task and logs the answer', () => {
  const env = configure(makeContext());
  fastFieldServer(env);
  const before = JSON.stringify(env.sheet.data);
  const result = env.ctx.testFastFieldDispatch();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { dispatchId: 'T-55' });

  assert.equal(env.fetchCalls.length, 2);
  assert.equal(env.fetchCalls[0].url, FORMS_URL);
  assert.equal(env.fetchCalls[0].options.method, 'get');
  assert.equal(env.fetchCalls[0].options.headers.Authorization, 'Bearer ff-key-123');
  assert.equal(env.fetchCalls[1].url, FF_URL);
  const sent = JSON.parse(env.fetchCalls[1].options.payload);
  assert.deepEqual(sent.users, ['driver@recoverytowing.example']);
  assert.equal(sent.autoCreateUsers, false);
  assert.equal(sent.mergeFields.alpha_1, 'TEST-DISPATCH-001');
  assert.equal(sent.mergeFields.alpha_3, 'Honda');
  assert.equal(sent.mergeFields.alpha_4, 'Civic');
  assert.equal(sent.mergeFields.numeric_1, 2022);
  assert.equal(sent.mergeFields.alpha_9, 'Roseville, CA');
  assert.equal(sent.mergeFields.alpha_13, 'Sacramento, CA');
  assert.match(sent.mergeFields.multiline_1, /TEST DISPATCH.*Quoted: \$150/);

  const log = env.logger.join('\n');
  assert.match(log, /HTTP status: 200[\s\S]*Form verified: Recovery Towing Service Form[\s\S]*HTTP status: 201/);
  assert.match(log, /X-Req/);
  assert.match(log, /T-55/);
  assert.ok(!log.includes('ff-key-123'), 'the key is never logged');
  assert.equal(JSON.stringify(env.sheet.data), before, 'the Call Log is untouched');
});

test('testFastFieldDispatch: reads the forms list whether bare or wrapped, and ids as numbers or text', () => {
  for (const body of [FORMS, { forms: FORMS }, { data: FORMS.map((f) => ({ formId: String(f.id), formName: f.name })) }]) {
    const env = configure(makeContext());
    fastFieldServer(env, { forms: { code: 200, body: JSON.stringify(body) } });
    env.ctx.testFastFieldDispatch();
    assert.match(env.logger.join('\n'), /Form verified: Recovery Towing Service Form/);
    assert.equal(env.fetchCalls.length, 2);
  }
});

test('testFastFieldDispatch: a form id that is not in the list shows the available forms and sends nothing', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_FORM_ID = '98766';
  fastFieldServer(env);
  assert.equal(env.ctx.testFastFieldDispatch(), null);
  assert.equal(env.fetchCalls.length, 1, 'no task was dispatched');
  const log = env.logger.join('\n');
  assert.match(log, /"98766" is not among the 2 form/);
  assert.match(log, /11111\s+Inspection/);
  assert.match(log, /98765\s+Recovery Towing Service Form/);
});

test('testFastFieldDispatch: a rejected key stops at step 1 with a hint', () => {
  const env = configure(makeContext());
  fastFieldServer(env, { forms: { code: 401, body: '{"message":"Access denied"}' } });
  assert.equal(env.ctx.testFastFieldDispatch(), null);
  assert.equal(env.fetchCalls.length, 1);
  assert.match(env.logger.join('\n'), /HTTP status: 401[\s\S]*FASTFIELD_API_KEY[\s\S]*Access denied/);
});

test('testFastFieldDispatch: an unreadable forms reply continues to the dispatch with a note', () => {
  const env = configure(makeContext());
  fastFieldServer(env, { forms: { code: 200, body: '<html>ok</html>' } });
  env.ctx.testFastFieldDispatch();
  assert.equal(env.fetchCalls.length, 2);
  assert.match(env.logger.join('\n'), /could not be checked/);
});

test('testFastFieldDispatch: a 400 or 422 on the dispatch logs FastField\'s exact validation message', () => {
  for (const code of [400, 422]) {
    const env = configure(makeContext());
    fastFieldServer(env, { dispatch: { code, body: JSON.stringify({ message: 'Validation failed', errors: [{ field: 'users', error: 'unknown user' }] }) } });
    env.ctx.testFastFieldDispatch();
    const log = env.logger.join('\n');
    assert.match(log, new RegExp('HTTP status: ' + code));
    assert.match(log, /rejected the request as invalid[\s\S]*message: Validation failed[\s\S]*unknown user/);
  }
});

test('testFastFieldDispatch: a missing setting and a network failure are explained', () => {
  const bare = makeContext();
  assert.equal(bare.ctx.testFastFieldDispatch(), null);
  assert.equal(bare.fetchCalls.length, 0);
  assert.match(bare.logger.join('\n'), /Nothing was sent/);

  const down = configure(makeContext());
  down.fetcher.respond = () => new Error('DNS error');
  assert.equal(down.ctx.testFastFieldDispatch(), null);
  assert.match(down.logger.join('\n'), /DNS error/);

  const html = configure(makeContext());
  fastFieldServer(html, { dispatch: { code: 502, body: '<html>bad gateway</html>' } });
  html.ctx.testFastFieldDispatch();
  assert.match(html.logger.join('\n'), /not JSON[\s\S]*bad gateway/);
});

// --- handleFastFieldWebhook_ -------------------------------------------------

test('webhook: rejects a missing or wrong token', () => {
  const env = configure(makeContext());
  post(env, appPayload());
  const before = JSON.stringify(env.sheet.data);
  const none = post(env, { alpha_1: 'JOB-0001', pdfUrl: PDF }, { source: 'fastfield' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'UNAUTHORIZED');
  const wrong = post(env, { alpha_1: 'JOB-0001', pdfUrl: PDF }, { source: 'fastfield', token: 'nope' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'UNAUTHORIZED');
  assert.equal(JSON.stringify(env.sheet.data), before);
});

test('webhook: finds the row by Call_ID and writes only Receipt_PDF_URL', () => {
  const env = configure(makeContext());
  post(env, appPayload({ call_id: 'OTHER-1', customer_phone: '916-555-0111' }));
  const mine = post(env, appPayload());
  const before = env.sheet.data.map((r) => r.slice());
  const res = post(env, { data: { alpha_1: 'JOB-0001', pdfUrl: PDF } }, FF_QUERY);
  assert.deepEqual(res, { ok: true, action: 'receipt_saved', row: mine.row });
  const col = env.sheet.data[0].indexOf('Receipt_PDF_URL');
  assert.equal(col, 32);
  env.sheet.data.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (r === mine.row - 1 && c === col) assert.equal(cell, PDF);
      else assert.equal(cell, before[r][c], `row ${r + 1} column ${c + 1} must be untouched`);
    });
  });
});

test('webhook: the token may ride in the JSON body and fields may be at the root', () => {
  const env = configure(makeContext());
  const mine = post(env, appPayload());
  const res = post(env, { token: API_SECRET, jobId: 'JOB-0001', documentUrl: PDF }, { source: 'fastfield' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rowObj(env, mine.row).Receipt_PDF_URL, PDF);
});

test('webhook: falls back to the last 10 digits of the phone when there is no job number', () => {
  const env = configure(makeContext());
  post(env, appPayload({ call_id: 'OTHER-1', customer_phone: '916-555-0111' }));
  const mine = post(env, appPayload());
  const res = post(env, { data: { formattedinput_1: '(916) 555-0199', pdfUrl: PDF } }, FF_QUERY);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.row, mine.row);
  assert.equal(rowObj(env, mine.row).Receipt_PDF_URL, PDF);
  const plusOne = post(env, { data: { formattedinput_1: '+1 916-555-0111', pdfUrl: PDF + '?b' } }, FF_QUERY);
  assert.equal(plusOne.ok, true);
  assert.equal(rowObj(env, 2).Receipt_PDF_URL, PDF + '?b');
});

test('webhook: the phone fallback ignores calls older than 24 hours and picks the newest recent one', () => {
  const env = configure(makeContext());
  const old = post(env, appPayload({ call_id: 'OLD', date_time: new Date(Date.now() - 30 * 3600e3).toISOString() }));
  const miss = post(env, { data: { formattedinput_1: '916-555-0199', pdfUrl: PDF } }, FF_QUERY);
  assert.equal(miss.ok, false);
  assert.equal(rowObj(env, old.row).Receipt_PDF_URL, '');

  const earlier = post(env, appPayload({ call_id: 'EARLIER', date_time: new Date(Date.now() - 5 * 3600e3).toISOString(), outcome: LOST }));
  const later = post(env, appPayload({ call_id: 'LATER', date_time: new Date(Date.now() - 1 * 3600e3).toISOString(), outcome: LOST }));
  const hit = post(env, { data: { formattedinput_1: '916-555-0199', pdfUrl: PDF } }, FF_QUERY);
  assert.equal(hit.row, later.row);
  assert.equal(rowObj(env, earlier.row).Receipt_PDF_URL, '');
});

test('webhook: an unknown call is a not-found error and writes nothing', () => {
  const env = configure(makeContext());
  post(env, appPayload());
  const before = JSON.stringify(env.sheet.data);
  const res = post(env, { data: { alpha_1: 'NO-SUCH-JOB', pdfUrl: PDF } }, FF_QUERY);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Call record not found');
  assert.equal(JSON.stringify(env.sheet.data), before);
  assert.ok(env.logs.warn.some((w) => w.includes('NO-SUCH-JOB')));
});

test('webhook: a PDF found among attachments is used; a missing or non-https link is rejected', () => {
  const env = configure(makeContext());
  const mine = post(env, appPayload());
  const attach = post(env, { attachments: [
    { url: 'https://x.example/photo.jpg', contentType: 'image/jpeg' },
    { url: 'https://x.example/report', contentType: 'application/pdf' },
  ], jobId: 'JOB-0001' }, FF_QUERY);
  assert.equal(attach.ok, true, JSON.stringify(attach));
  assert.equal(rowObj(env, mine.row).Receipt_PDF_URL, 'https://x.example/report');

  const noLink = post(env, { jobId: 'JOB-0001' }, FF_QUERY);
  assert.equal(noLink.ok, false);
  assert.equal(noLink.code, 'BAD_REQUEST');
  const insecure = post(env, { jobId: 'JOB-0001', pdfUrl: 'http://x.example/a.pdf' }, FF_QUERY);
  assert.equal(insecure.ok, false);
  const script = post(env, { jobId: 'JOB-0001', pdfUrl: 'javascript:alert(1)' }, FF_QUERY);
  assert.equal(script.ok, false);
  const noId = post(env, { pdfUrl: PDF }, FF_QUERY);
  assert.equal(noId.code, 'BAD_REQUEST');
  assert.equal(rowObj(env, mine.row).Receipt_PDF_URL, 'https://x.example/report');
});

test('webhook: repeating the same call is harmless', () => {
  const env = configure(makeContext());
  const mine = post(env, appPayload());
  post(env, { jobId: 'JOB-0001', pdfUrl: PDF }, FF_QUERY);
  const again = post(env, { jobId: 'JOB-0001', pdfUrl: PDF }, FF_QUERY);
  assert.equal(again.ok, true);
  assert.equal(dataRowCount(env), 1);
  assert.equal(rowObj(env, mine.row).Receipt_PDF_URL, PDF);
});

// --- ensureSchema_ -----------------------------------------------------------

test('ensureSchema_: a 31-column sheet gets FastField_Task_ID and Receipt_PDF_URL appended as 32 and 33', () => {
  const env = makeContext();
  post(env, appPayload({ outcome: LOST }));
  const before = JSON.stringify(env.sheet.data[1].slice(0, 31));
  env.sheet.data.forEach((row, i) => { env.sheet.data[i] = row.slice(0, 31); });
  assert.equal(env.sheet.data[0].length, 31);

  const log = env.ctx.ensureSchema_(env.sheet);
  assert.equal(env.sheet.data[0].length, 33);
  assert.deepEqual(env.sheet.data[0].slice(31), ['FastField_Task_ID', 'Receipt_PDF_URL']);
  assert.equal(log.col.FastField_Task_ID, 31);
  assert.equal(log.col.Receipt_PDF_URL, 32);
  assert.equal(log.width, 33);
  assert.equal(JSON.stringify(env.sheet.data[1].slice(0, 31)), before, 'existing data is untouched');
  env.ctx.ensureSchema_(env.sheet);
  assert.equal(env.sheet.data[0].length, 33, 'added once');
});

test('ensureSchema_: any other missing header is still a configuration error', () => {
  const env = makeContext();
  env.sheet.data[0][4] = 'Payer_Nme';
  assert.throws(() => env.ctx.ensureSchema_(env.sheet), /Payer_Name/);
});
