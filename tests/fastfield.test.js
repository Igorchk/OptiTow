// FastField dispatch (outbound task for a won call, signed in with a session token) and the return
// webhook (receipt PDF link), plus the 31 -> 33 column self-migration. Run: npm test
'use strict';

const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { API_SECRET, makeContext, post, rowObj, dataRowCount } = require('./support/gas-mock');

// The Azure gateway's 32-character subscription key, the account login, and the session token the
// mock sign-in returns. All made up.
const SUB = '0123456789abcdef0123456789abcdef';
const USER = 'driver@recoverytowing.example';
const PASSWORD = 'p@ss:wörd/9!';
const TOKEN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const WON = '1 - Won / Booked';
const LOST = '0 - Lost / Declined';
const FF_URL = 'https://api.fastfieldforms.com/services/v3/dispatch';
const FORM_DISPATCH_URL = 'https://api.fastfieldforms.com/services/v3/forms/98765/dispatch';
const TASKS_URL = 'https://api.fastfieldforms.com/services/v3/tasks';
const FORMS_URL = 'https://api.fastfieldforms.com/services/v3/forms';
const AUTH_URL = 'https://api.fastfieldforms.com/services/v3/authenticate';
const SESSION_KEY = 'fastfield_session_token';
const PDF = 'https://reports.fastfieldforms.com/receipts/abc123.pdf';

function configure(env) {
  Object.assign(env.props, {
    FASTFIELD_SUBSCRIPTION_KEY: SUB,
    FASTFIELD_FORM_ID: '98765',
    FASTFIELD_USER_ID: USER,
    FASTFIELD_PASSWORD: PASSWORD,
  });
  return env;
}

/** The requests to a FastField address, in order. */
const calls = (env, url) => env.fetchCalls.filter((c) => c.url === url);
const dispatches = (env) => calls(env, FF_URL);
const signIns = (env) => env.fetchCalls.filter((c) => c.url.split('?')[0] === AUTH_URL);

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

/** Every request after sign-in carries the gateway key (both names) and the session token, and no Bearer or password. */
function assertSessionHeaders(call, { sub = SUB, token = TOKEN } = {}) {
  const h = call.options.headers;
  assert.equal(h['Ocp-Apim-Subscription-Key'], sub, 'the gateway gets the subscription key (Azure name)');
  assert.equal(h['FastField-API-Key'], sub, 'and under FastField\'s own name');
  assert.equal(h['X-Gatekeeper-SessionToken'], token, 'FastField gets the session token');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h.Accept, 'application/json');
  assert.equal(h.Authorization, undefined, 'no Basic or Bearer header outside sign-in');
  assert.equal(Object.keys(h).length, 5);
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
  assert.equal(dispatches(env).length, 1);
  const { url, options } = dispatches(env)[0];
  assert.equal(url, FF_URL);
  assert.equal(options.method, 'post');
  assert.equal(options.contentType, 'application/json');
  assertSessionHeaders(dispatches(env)[0]);
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
  const fields = JSON.parse(dispatches(env)[0].options.payload).mergeFields;
  assert.equal(fields.numeric_1, null);
  assert.equal(fields.multiline_1, 'Quoted: $100', 'no stray separator when there are no notes');
  assert.equal(fields.alpha_3, '');
});

test('dispatch: a lost call is never sent', () => {
  const env = configure(makeContext());
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 0 }), null);
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: LOST }), null);
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J' }), null);
  assert.equal(dispatches(env).length, 0);
});

test('dispatch: missing or blank credentials skip quietly with a warning', () => {
  for (const missing of ['FASTFIELD_SUBSCRIPTION_KEY', 'FASTFIELD_FORM_ID', 'FASTFIELD_USER_ID', 'FASTFIELD_PASSWORD']) {
    const env = configure(makeContext());
    env.props[missing] = '   ';
    assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
    assert.equal(dispatches(env).length, 0, missing);
    assert.ok(env.logs.warn.some((w) => w.includes(missing)), missing);
  }
  const bare = makeContext();
  assert.equal(bare.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(dispatches(bare).length, 0);
});

test('dispatch: a non-numeric form id is skipped, not sent', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_FORM_ID = 'abc';
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(dispatches(env).length, 0);
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

test('dispatch: the password, subscription key and session token never appear in a log or in the body', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => ({ code: 500, body: 'oops' });
  env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 });
  const logs = env.logs.error.concat(env.logs.warn).join('\n');
  for (const secret of [PASSWORD, SUB, TOKEN]) {
    assert.ok(!logs.includes(secret), 'not in logs');
    assert.ok(!dispatches(env)[0].options.payload.includes(secret), 'not in the body');
  }
});

// --- the app sync path -------------------------------------------------------

test('app sync: a won call is dispatched and its task id stored in column 32', () => {
  const env = configure(makeContext());
  const res = post(env, appPayload());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(dispatches(env).length, 1);
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
  assert.equal(dispatches(lost).length, 0);
  assert.equal(rowObj(lost, a.row).FastField_Task_ID, '');

  const bare = makeContext();
  const b = post(bare, appPayload());
  assert.equal(b.ok, true);
  assert.equal(dispatches(bare).length, 0);
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
  assert.equal(dispatches(env).length, 1, 'already has a task id');
  assert.equal(dataRowCount(env), 1);

  const retry = configure(makeContext());
  retry.fetcher.respond = () => ({ code: 500, body: 'down' });
  const first = post(retry, appPayload());
  assert.equal(rowObj(retry, first.row).FastField_Task_ID, '');
  retry.fetcher.respond = () => ({ code: 200, body: JSON.stringify({ dispatchId: 'FF-2' }) });
  const second = post(retry, appPayload());
  assert.equal(second.row, first.row);
  assert.equal(rowObj(retry, second.row).FastField_Task_ID, 'FF-2');
  assert.equal(dispatches(retry).length, 2);
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
  assert.equal(dispatches(env)[0].lockHeld, false);
  assert.ok(env.fetchCalls.every((c) => !c.lockHeld), 'signing in happens outside the lock too');
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
  assert.equal(dispatches(env).length, 1, 'only the first request talks to FastField');
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

// --- session sign-in --------------------------------------------------------

const basic = (user, password) => 'Basic ' + Buffer.from(user + ':' + password, 'utf8').toString('base64');

test('session: a cold start signs in with Basic auth plus the subscription key, and caches the token', () => {
  const env = configure(makeContext());
  const token = env.ctx.getFastFieldSessionToken_();
  assert.equal(token, TOKEN);
  assert.equal(signIns(env).length, 1);
  const { options } = signIns(env)[0];
  assert.equal(options.method, 'post');
  assert.equal(options.headers.Authorization, basic(USER, PASSWORD), 'base64(email:password), UTF-8');
  assert.equal(options.headers['Ocp-Apim-Subscription-Key'], SUB);
  assert.equal(options.headers['FastField-API-Key'], SUB);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(options.headers['X-Gatekeeper-SessionToken'], undefined, 'no session yet');
  assert.equal(env.cache.get(SESSION_KEY), TOKEN);
  assert.equal(env.cacheTtls.get(SESSION_KEY), 21600, 'a 24 hour session is cached for the 6 hour maximum');
});

test('session: a hot cache is returned without calling FastField', () => {
  const env = configure(makeContext());
  env.cache.set(SESSION_KEY, 'CACHED-TOKEN');
  assert.equal(env.ctx.getFastFieldSessionToken_(), 'CACHED-TOKEN');
  assert.equal(env.fetchCalls.length, 0);
});

test('session: the second use of a token comes from the cache, so signing in happens once', () => {
  const env = configure(makeContext());
  env.ctx.dispatchToFastField_({ call_id: 'A', outcome: 1 });
  env.ctx.dispatchToFastField_({ call_id: 'B', outcome: 1 });
  assert.equal(signIns(env).length, 1);
  assert.equal(dispatches(env).length, 2);
  dispatches(env).forEach((c) => assertSessionHeaders(c));
  env.expireCache();
  env.ctx.dispatchToFastField_({ call_id: 'C', outcome: 1 });
  assert.equal(signIns(env).length, 2, 'an expired cache signs in again');
});

test('session: the manual override is used without signing in, and stands in for the password', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_SESSION_TOKEN_OVERRIDE = '  "MANUAL-TOKEN"\n';
  delete env.props.FASTFIELD_PASSWORD;
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), 'FF-1001');
  assert.equal(signIns(env).length, 0);
  assertSessionHeaders(dispatches(env)[0], { token: 'MANUAL-TOKEN' });
  assert.equal(env.cache.get(SESSION_KEY) ?? null, null, 'an override is not cached');
});

test('session: the cache is checked before the override', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_SESSION_TOKEN_OVERRIDE = 'MANUAL-TOKEN';
  env.cache.set(SESSION_KEY, 'CACHED-TOKEN');
  assert.equal(env.ctx.getFastFieldSessionToken_(), 'CACHED-TOKEN');
});

test('session: the token is read from the top of the reply or from data, and trimmed', () => {
  const env = configure(makeContext());
  env.fetcher.authRespond = () => ({ code: 200, body: JSON.stringify({ data: { sessionToken: ' NESTED \n' } }) });
  assert.equal(env.ctx.getFastFieldSessionToken_(), 'NESTED');
});

test('session: the cache lifetime follows sessionExpiration, a minute early, within 60 s and 6 h', () => {
  const ttl = (expiration) => {
    const env = configure(makeContext());
    env.fetcher.authRespond = () => ({ code: 200, body: JSON.stringify({ sessionToken: TOKEN, sessionExpiration: expiration }) });
    env.ctx.getFastFieldSessionToken_();
    return env.cacheTtls.get(SESSION_KEY);
  };
  const in2h = ttl(new Date(Date.now() + 2 * 3600e3).toISOString());
  assert.ok(in2h >= 7100 && in2h <= 7140, String(in2h));
  assert.equal(ttl(new Date(Date.now() + 10e3).toISOString()), 60, 'never below a minute');
  assert.equal(ttl(new Date(Date.now() - 3600e3).toISOString()), 60);
  assert.equal(ttl(new Date(Date.now() + 99 * 3600e3).toISOString()), 21600, 'never above 6 hours');
  assert.equal(ttl('not a date'), 21600);
  assert.equal(ttl(undefined), 21600);
});

test('session: Basic auth encodes the exact email and password, including colons and non-ASCII', () => {
  const env = configure(makeContext());
  Object.assign(env.props, { FASTFIELD_USER_ID: 'Ünï@example.com', FASTFIELD_PASSWORD: 'a:b:c é€' });
  env.ctx.getFastFieldSessionToken_();
  assert.equal(signIns(env)[0].options.headers.Authorization, basic('Ünï@example.com', 'a:b:c é€'));
});

test('session: a failed sign-in logs the status and reply, returns null, and caches nothing', () => {
  for (const [code, body] of [[401, '{"statusCode":401,"message":"Access denied due to invalid subscription key."}'], [403, 'no'], [500, '<html>']]) {
    const env = configure(makeContext());
    env.fetcher.authRespond = () => ({ code, body });
    assert.equal(env.ctx.getFastFieldSessionToken_(), null);
    assert.ok(env.logs.error.some((e) => e.includes('sign-in failed') && e.includes(String(code))), String(code));
    assert.equal(env.cache.get(SESSION_KEY) ?? null, null);
    assert.ok(!env.logs.error.join('\n').includes(PASSWORD));
  }
  const noToken = configure(makeContext());
  noToken.fetcher.authRespond = () => ({ code: 200, body: '{"sessionExpiration":"2030-01-01T00:00:00Z"}' });
  assert.equal(noToken.ctx.getFastFieldSessionToken_(), null);
  const down = configure(makeContext());
  down.fetcher.authRespond = () => new Error('DNS error');
  assert.equal(down.ctx.getFastFieldSessionToken_(), null);
  assert.ok(down.logs.error.some((e) => e.includes('DNS error')));
});

test('sign-in request: carries exactly Authorization, FastField-API-Key, Ocp-Apim-Subscription-Key, Content-Type and Accept', () => {
  const env = configure(makeContext());
  env.ctx.getFastFieldSessionToken_();
  const { url, options } = signIns(env)[0];
  assert.equal(url, AUTH_URL, 'no key in the URL');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Authorization', 'Content-Type', 'FastField-API-Key', 'Ocp-Apim-Subscription-Key']);
  assert.equal(options.headers['Ocp-Apim-Subscription-Key'], SUB, 'present and equal to the subscription key');
  assert.equal(options.headers['FastField-API-Key'], SUB, 'present and equal to the subscription key');
  assert.notEqual(options.headers['FastField-API-Key'], '');
  assert.equal(options.headers.Authorization, basic(USER, PASSWORD));
  assert.equal(options.payload, undefined);
  assert.equal(options.contentType, undefined, 'the header carries it; no duplicate option');
  assert.equal(options.muteHttpExceptions, true);
});

test('sign-in request: a missing or blank subscription key is warned about and nothing is sent', () => {
  for (const blank of [undefined, '', '  ', ' "" ']) {
    const env = configure(makeContext());
    if (blank === undefined) delete env.props.FASTFIELD_SUBSCRIPTION_KEY; else env.props.FASTFIELD_SUBSCRIPTION_KEY = blank;
    assert.equal(env.ctx.getFastFieldSessionToken_(), null);
    assert.equal(env.fetchCalls.length, 0);
    assert.ok(env.logs.warn.some((w) => w.includes('FASTFIELD_SUBSCRIPTION_KEY')), JSON.stringify(blank));
  }
});

test('sign-in request: every FastField request after it carries the same subscription key', () => {
  const env = configure(makeContext());
  fastFieldServer(env);
  env.ctx.testFastFieldDispatch();
  assert.equal(env.fetchCalls.length, 3);
  env.fetchCalls.forEach((c) => {
    assert.equal(c.options.headers['Ocp-Apim-Subscription-Key'], SUB, c.url);
    assert.equal(c.options.headers['FastField-API-Key'], SUB, c.url);
  });
  assert.equal(env.fetchCalls[0].options.headers['X-Gatekeeper-SessionToken'], undefined, 'sign-in has no session yet');
  assert.equal(env.fetchCalls[1].options.headers['X-Gatekeeper-SessionToken'], TOKEN);
  assert.equal(env.fetchCalls[2].options.headers['X-Gatekeeper-SessionToken'], TOKEN);
});

test('sign-in request: an exception that mentions a secret is redacted before it is logged', () => {
  const env = configure(makeContext());
  env.fetcher.authRespond = () => new Error('Request failed for https://x?subscription-key=' + SUB + ' as ' + PASSWORD);
  assert.equal(env.ctx.getFastFieldSessionToken_(), null);
  const all = env.logs.error.join('\n') + JSON.stringify(env.ctx.fastFieldSession_ || {});
  assert.ok(!all.includes(SUB) && !all.includes(PASSWORD));
  assert.ok(env.logs.error.some((e) => e.includes('***')));
});

test('session: missing credentials skip the sign-in without a request', () => {
  const env = makeContext();
  assert.equal(env.ctx.getFastFieldSessionToken_(), null);
  assert.equal(env.fetchCalls.length, 0);
  assert.ok(env.logs.warn.some((w) => w.includes('FASTFIELD_PASSWORD')));
});

test('session: no token means no dispatch, but the call is still saved', () => {
  const env = configure(makeContext());
  env.fetcher.authRespond = () => ({ code: 401, body: '{"message":"bad login"}' });
  const res = post(env, appPayload());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(dispatches(env).length, 0);
  assert.equal(rowObj(env, res.row).FastField_Task_ID, '');
  assert.ok(env.logs.warn.some((w) => w.includes('no session token')));
});

test('session: a 401 on the dispatch clears the cache, signs in again and retries once', () => {
  const env = configure(makeContext());
  const tokens = ['TOKEN-OLD', 'TOKEN-NEW'];
  env.fetcher.authRespond = () => ({ code: 200, body: JSON.stringify({ sessionToken: tokens.shift() }) });
  env.fetcher.respond = (url, options) => (options.headers['X-Gatekeeper-SessionToken'] === 'TOKEN-OLD'
    ? { code: 401, body: '{"message":"session expired"}' }
    : { code: 200, body: JSON.stringify({ dispatchId: 'FF-77' }) });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), 'FF-77');
  assert.equal(signIns(env).length, 2);
  assert.equal(dispatches(env).length, 2);
  assertSessionHeaders(dispatches(env)[0], { token: 'TOKEN-OLD' });
  assertSessionHeaders(dispatches(env)[1], { token: 'TOKEN-NEW' });
  assert.equal(env.cache.get(SESSION_KEY), 'TOKEN-NEW', 'the fresh session is cached');
  assert.equal(dispatches(env)[0].options.payload, dispatches(env)[1].options.payload, 'same task retried');
});

test('session: the retry happens only once, and not when signing in again yields the same token', () => {
  const twice = configure(makeContext());
  const tokens = ['T1', 'T2', 'T3'];
  twice.fetcher.authRespond = () => ({ code: 200, body: JSON.stringify({ sessionToken: tokens.shift() }) });
  twice.fetcher.respond = () => ({ code: 401, body: '{"message":"no"}' });
  assert.equal(twice.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(dispatches(twice).length, 2, 'one retry, not a loop');
  assert.equal(signIns(twice).length, 2);

  const same = configure(makeContext());
  same.fetcher.respond = () => ({ code: 401, body: '{"message":"no"}' });
  assert.equal(same.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(dispatches(same).length, 1, 'a fresh sign-in gave the same token, so retrying would change nothing');

  const other = configure(makeContext());
  other.fetcher.respond = () => ({ code: 400, body: '{"message":"bad"}' });
  other.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 });
  assert.equal(signIns(other).length, 1, 'only a 401 triggers a new sign-in');
});

test('session: headers carry the session token only when there is one', () => {
  const env = makeContext();
  assert.deepEqual(JSON.parse(JSON.stringify(env.ctx.getFastFieldHeaders_('SUBKEY', 'SESSION'))), {
    'FastField-API-Key': 'SUBKEY',
    'Ocp-Apim-Subscription-Key': 'SUBKEY',
    'X-Gatekeeper-SessionToken': 'SESSION',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(env.ctx.getFastFieldHeaders_('SUBKEY', ''))), {
    'FastField-API-Key': 'SUBKEY',
    'Ocp-Apim-Subscription-Key': 'SUBKEY',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
});

test('session: a retry still never holds the sheet lock, and the app sync gets its id', () => {
  const env = configure(makeContext());
  const tokens = ['TOKEN-OLD', 'TOKEN-NEW'];
  env.fetcher.authRespond = () => ({ code: 200, body: JSON.stringify({ sessionToken: tokens.shift() }) });
  env.fetcher.respond = (url, options) => (options.headers['X-Gatekeeper-SessionToken'] === 'TOKEN-OLD'
    ? { code: 401, body: '{}' } : { code: 200, body: JSON.stringify({ dispatchId: 'FF-78' }) });
  const res = post(env, appPayload());
  assert.equal(rowObj(env, res.row).FastField_Task_ID, 'FF-78');
  assert.ok(env.fetchCalls.every((c) => !c.lockHeld));
});

// --- testFastFieldDispatch ---------------------------------------------------

const FORMS = [{ id: 11111, name: 'Inspection' }, { id: 98765, name: 'Recovery Towing Service Form' }];

/** Answers the forms list and the dispatch like FastField would (sign-in is answered by authRespond). */
function fastFieldServer(env, { forms = { code: 200, body: JSON.stringify(FORMS) }, dispatch } = {}) {
  env.fetcher.respond = (url) => (url === FORMS_URL
    ? forms
    : (dispatch || { code: 201, body: JSON.stringify({ dispatchId: 'T-55' }), headers: { 'X-Req': 'abc' } }));
}

const logText = (env) => env.logger.join('\n');
const noSecrets = (env) => {
  for (const secret of [PASSWORD, SUB, TOKEN]) assert.ok(!logText(env).includes(secret), 'a secret was logged in full');
};

test('testFastFieldDispatch: signs in, checks the forms with the session, then sends a marked test task', () => {
  const env = configure(makeContext());
  fastFieldServer(env);
  const before = JSON.stringify(env.sheet.data);
  const result = env.ctx.testFastFieldDispatch();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { dispatchId: 'T-55' });

  assert.deepEqual(env.fetchCalls.map((c) => c.url), [AUTH_URL, FORMS_URL, FF_URL], 'three steps, in order');
  assert.equal(env.fetchCalls[0].options.headers.Authorization, basic(USER, PASSWORD));
  assert.equal(env.fetchCalls[1].options.method, 'get');
  assertSessionHeaders(env.fetchCalls[1]);
  assertSessionHeaders(env.fetchCalls[2]);
  const sent = JSON.parse(env.fetchCalls[2].options.payload);
  assert.deepEqual(sent.users, [USER]);
  assert.equal(sent.autoCreateUsers, false);
  assert.equal(sent.mergeFields.alpha_1, 'TEST-DISPATCH-001');
  assert.equal(sent.mergeFields.alpha_3, 'Honda');
  assert.equal(sent.mergeFields.alpha_4, 'Civic');
  assert.equal(sent.mergeFields.numeric_1, 2022);
  assert.equal(sent.mergeFields.alpha_9, 'Roseville, CA');
  assert.equal(sent.mergeFields.alpha_13, 'Sacramento, CA');
  assert.match(sent.mergeFields.multiline_1, /TEST DISPATCH.*Quoted: \$150/);

  const log = logText(env);
  assert.match(log, /Step 1 of 3[\s\S]*Session token \(from a new sign-in\): present, 32 characters, masked 0f1e\.\.\.e1f0, 32-character hex: true/);
  assert.match(log, /Session expires: /);
  assert.match(log, /Step 2 of 3[\s\S]*HTTP status: 200[\s\S]*Gateway cleared & forms verified: Inspection, Recovery Towing Service Form/);
  assert.match(log, /Form verified: Recovery Towing Service Form/);
  assert.match(log, /Step 3 of 3[\s\S]*HTTP status: 201[\s\S]*OK\. FastField created task T-55/);
  assert.match(log, /X-Req/);
  noSecrets(env);
  assert.equal(JSON.stringify(env.sheet.data), before, 'the Call Log is untouched');
});

test('testFastFieldDispatch: says where the session came from, and summarizes the other settings safely', () => {
  const cached = configure(makeContext());
  cached.cache.set(SESSION_KEY, 'CACHED-TOKEN-0123456789');
  fastFieldServer(cached);
  cached.ctx.testFastFieldDispatch();
  assert.match(logText(cached), /Session token \(from a cached session\)/);
  assert.equal(signIns(cached).length, 0);

  const manual = configure(makeContext());
  manual.props.FASTFIELD_SESSION_TOKEN_OVERRIDE = 'MANUAL-TOKEN-0123456789';
  delete manual.props.FASTFIELD_PASSWORD;
  fastFieldServer(manual);
  manual.ctx.testFastFieldDispatch();
  assert.match(logText(manual), /Session token \(from FASTFIELD_SESSION_TOKEN_OVERRIDE\)/);
  assert.match(logText(manual), /FASTFIELD_PASSWORD: MISSING|FASTFIELD_SESSION_TOKEN_OVERRIDE is set/);

  const env = configure(makeContext());
  fastFieldServer(env);
  env.ctx.testFastFieldDispatch();
  const log = logText(env);
  assert.match(log, /FASTFIELD_SUBSCRIPTION_KEY \(Azure gateway key\): present, 32 characters, masked 0123\.\.\.cdef, 32-character hex: true/);
  assert.ok(log.indexOf('FASTFIELD_SUBSCRIPTION_KEY') < log.indexOf('Step 1 of 3'), 'settings summary comes first');
  assert.match(log, new RegExp('FASTFIELD_USER_ID .*: ' + USER.replace('.', '\\.')));
  assert.match(log, new RegExp('FASTFIELD_PASSWORD: present \\(' + [...PASSWORD].length + ' characters\\)'));
  noSecrets(env);

  const odd = configure(makeContext());
  odd.props.FASTFIELD_SUBSCRIPTION_KEY = 'not-a-hex-key-at-all-but-long-enough';
  fastFieldServer(odd);
  odd.ctx.testFastFieldDispatch();
  assert.match(logText(odd), /normally 32 hexadecimal characters/);
});

test('testFastFieldDispatch: a failed sign-in says whether the gateway or the login refused, and stops', () => {
  const gateway = configure(makeContext());
  gateway.fetcher.authRespond = () => ({ code: 401, body: '{"statusCode":401,"message":"Access denied due to invalid subscription key."}' });
  assert.equal(gateway.ctx.testFastFieldDispatch(), null);
  assert.deepEqual(gateway.fetchCalls.map((c) => c.url), [AUTH_URL], 'nothing else is tried');
  assert.match(logText(gateway), /Sign-in failed: HTTP 401[\s\S]*invalid subscription key[\s\S]*gateway\) rejected the SUBSCRIPTION KEY/);
  noSecrets(gateway);

  const login = configure(makeContext());
  login.fetcher.authRespond = () => ({ code: 401, body: '{"message":"Invalid username or password"}' });
  assert.equal(login.ctx.testFastFieldDispatch(), null);
  assert.match(logText(login), /rejected the LOGIN[\s\S]*FASTFIELD_USER_ID[\s\S]*FASTFIELD_PASSWORD/);
  noSecrets(login);

  const notFound = configure(makeContext());
  notFound.fetcher.authRespond = () => ({ code: 404, body: '{"message":"Resource not found"}' });
  notFound.ctx.testFastFieldDispatch();
  assert.match(logText(notFound), /check CONFIG\.FASTFIELD_AUTH_URL/);

  const down = configure(makeContext());
  down.fetcher.authRespond = () => new Error('DNS error');
  assert.equal(down.ctx.testFastFieldDispatch(), null);
  assert.match(logText(down), /Sign-in failed before FastField answered: DNS error/);
});

test('testFastFieldDispatch: a "missing subscription key" at sign-in lists the headers sent and probes how the gateway reads it', () => {
  const env = configure(makeContext());
  const miss = { code: 401, body: '{"statusCode":401,"message":"Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API."}' };
  env.fetcher.authRespond = () => miss;
  assert.equal(env.ctx.testFastFieldDispatch(), null);
  assert.equal(signIns(env).length, 4, 'the real sign-in, then three probes');
  assert.ok(env.fetchCalls.every((c) => c.url.startsWith(AUTH_URL)), 'nothing else is tried');
  const [, ffOnly, ocpOnly, queryOnly] = signIns(env);
  assert.equal(ffOnly.options.headers['FastField-API-Key'], SUB);
  assert.equal(ffOnly.options.headers['Ocp-Apim-Subscription-Key'], undefined);
  assert.equal(ocpOnly.options.headers['Ocp-Apim-Subscription-Key'], SUB);
  assert.equal(ocpOnly.options.headers['FastField-API-Key'], undefined);
  assert.equal(queryOnly.url, AUTH_URL + '?subscription-key=' + SUB);
  assert.equal(queryOnly.options.headers['Ocp-Apim-Subscription-Key'], undefined);
  assert.equal(queryOnly.options.headers['FastField-API-Key'], undefined);
  const log = logText(env);
  assert.match(log, /NO subscription key on the sign-in request[\s\S]*Authorization, FastField-API-Key and Ocp-Apim-Subscription-Key \(each 32 characters\), Content-Type, Accept/);
  assert.match(log, /FastField-API-Key header only \(headers sent: Authorization, FastField-API-Key, Accept\): HTTP 401/);
  assert.match(log, /Every placement was refused/);
  noSecrets(env);
});

test('testFastFieldDispatch: the sign-in probe reports a placement the gateway accepts', () => {
  const env = configure(makeContext());
  env.fetcher.authRespond = (url) => (url.includes('subscription-key=')
    ? { code: 200, body: JSON.stringify({ sessionToken: TOKEN }) }
    : { code: 401, body: '{"message":"Access denied due to missing subscription key."}' });
  assert.equal(env.ctx.testFastFieldDispatch(), null);
  const log = logText(env);
  assert.match(log, /\?subscription-key= query parameter[^\n]*HTTP 200 \(accepted: a session was issued\)/);
  assert.match(log, /The gateway accepts the subscription key via: \?subscription-key= query parameter/);
  noSecrets(env);
});

test('testFastFieldDispatch: a missing setting sends nothing', () => {
  const bare = makeContext();
  assert.equal(bare.ctx.testFastFieldDispatch(), null);
  assert.equal(bare.fetchCalls.length, 0);
  assert.match(logText(bare), /Nothing was sent/);
  const noPassword = configure(makeContext());
  delete noPassword.props.FASTFIELD_PASSWORD;
  assert.equal(noPassword.ctx.testFastFieldDispatch(), null);
  assert.equal(noPassword.fetchCalls.length, 0);
});

test('testFastFieldDispatch: a forms 401 says whether the gateway or the session refused, and clears a bad cached session', () => {
  const expired = configure(makeContext());
  expired.cache.set(SESSION_KEY, 'STALE-TOKEN-0123456789');
  fastFieldServer(expired, { forms: { code: 401, body: '{"message":"Session expired"}' } });
  assert.equal(expired.ctx.testFastFieldDispatch(), null);
  assert.deepEqual(expired.fetchCalls.map((c) => c.url), [FORMS_URL], 'no dispatch');
  assert.match(logText(expired), /FastField rejected the session token[\s\S]*Run again to sign in afresh/);
  assert.equal(expired.cache.get(SESSION_KEY) ?? null, null, 'the stale session is cleared');

  const gateway = configure(makeContext());
  fastFieldServer(gateway, { forms: { code: 401, body: '{"message":"Access denied due to invalid subscription key."}' } });
  gateway.ctx.testFastFieldDispatch();
  assert.match(logText(gateway), /The gateway rejected the subscription key/);

  const override = configure(makeContext());
  override.props.FASTFIELD_SESSION_TOKEN_OVERRIDE = 'MANUAL-TOKEN-0123456789';
  fastFieldServer(override, { forms: { code: 401, body: '{"message":"Session expired"}' } });
  override.ctx.testFastFieldDispatch();
  assert.match(logText(override), /replace FASTFIELD_SESSION_TOKEN_OVERRIDE/);
});

test('testFastFieldDispatch: reads the forms list whether bare or wrapped, and ids as numbers or text', () => {
  for (const body of [FORMS, { forms: FORMS }, { data: FORMS.map((f) => ({ formId: String(f.id), formName: f.name })) }]) {
    const env = configure(makeContext());
    fastFieldServer(env, { forms: { code: 200, body: JSON.stringify(body) } });
    env.ctx.testFastFieldDispatch();
    assert.match(logText(env), /Form verified: Recovery Towing Service Form/);
    assert.equal(dispatches(env).length, 1);
  }
});

test('testFastFieldDispatch: a form id that is not in the list shows the available forms and sends nothing', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_FORM_ID = '98766';
  fastFieldServer(env);
  assert.equal(env.ctx.testFastFieldDispatch(), null);
  assert.equal(dispatches(env).length, 0, 'no task was dispatched');
  assert.match(logText(env), /"98766" is not among the 2 form/);
  assert.match(logText(env), /11111\s+Inspection/);
  assert.match(logText(env), /98765\s+Recovery Towing Service Form/);
});

test('testFastFieldDispatch: an unreadable forms reply continues to the dispatch with a note', () => {
  const env = configure(makeContext());
  fastFieldServer(env, { forms: { code: 200, body: '<html>ok</html>' } });
  env.ctx.testFastFieldDispatch();
  assert.equal(dispatches(env).length, 1);
  assert.match(logText(env), /could not be checked/);
});

test('dispatch: the address is the singular /v3/dispatch, built from the v3 base', () => {
  const config = vm.runInContext('CONFIG', makeContext().ctx);
  assert.equal(config.FASTFIELD_DISPATCH_URL, 'https://api.fastfieldforms.com/services/v3/dispatch');
  assert.equal(config.FASTFIELD_FORMS_URL, 'https://api.fastfieldforms.com/services/v3/forms');
  assert.equal(config.FASTFIELD_AUTH_URL, 'https://api.fastfieldforms.com/services/v3/authenticate');
  assert.equal(config.FASTFIELD_TASKS_URL, 'https://api.fastfieldforms.com/services/v3/tasks');
  const plural = configure(makeContext());
  plural.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 });
  assert.ok(plural.fetchCalls.every((c) => !c.url.endsWith('/dispatches')), 'the plural path is never used');
  assert.equal(dispatches(plural).length, 1);
});

test('route discovery: a 404 on /dispatch tries /forms/{id}/dispatch, then /tasks, logging each status and body', () => {
  const env = configure(makeContext());
  const body404 = '{"statusCode":404,"message":"Resource not found"}';
  env.fetcher.respond = (url) => {
    if (url === FORMS_URL) return { code: 200, body: JSON.stringify(FORMS) };
    return { code: 404, body: body404 };
  };
  env.ctx.testFastFieldDispatch();
  const posts = env.fetchCalls.filter((c) => c.options.method === 'post' && c.url !== AUTH_URL).map((c) => c.url);
  assert.deepEqual(posts, [FF_URL, FORM_DISPATCH_URL, TASKS_URL], 'primary first, then the two alternatives in order');
  const log = logText(env);
  assert.match(log, /HTTP status: 404/);
  assert.match(log, /POST https:\/\/api\.fastfieldforms\.com\/services\/v3\/forms\/98765\/dispatch: HTTP 404 \{"statusCode":404,"message":"Resource not found"\}/);
  assert.match(log, /POST https:\/\/api\.fastfieldforms\.com\/services\/v3\/tasks: HTTP 404 \{"statusCode":404/);
  assert.match(log, /Every route was a 404/);
  // the alternatives carry the same session, keys and body
  const [, , forms2, tasks] = env.fetchCalls.slice(-4);
  for (const call of [forms2, tasks]) {
    assertSessionHeaders(call);
    assert.equal(JSON.parse(call.options.payload).mergeFields.alpha_1, 'TEST-DISPATCH-001');
  }
  noSecrets(env);
});

test('route discovery: stops at the first route that is not a 404, so no extra test task is created', () => {
  const accepted = configure(makeContext());
  accepted.fetcher.respond = (url) => {
    if (url === FORMS_URL) return { code: 200, body: JSON.stringify(FORMS) };
    if (url === FORM_DISPATCH_URL) return { code: 201, body: JSON.stringify({ id: 'T-31' }) };
    return { code: 404, body: '{"message":"Resource not found"}' };
  };
  accepted.ctx.testFastFieldDispatch();
  assert.ok(!accepted.fetchCalls.some((c) => c.url === TASKS_URL), 'did not go on to /tasks');
  assert.match(logText(accepted), /gateway ACCEPTED https:\/\/api\.fastfieldforms\.com\/services\/v3\/forms\/98765\/dispatch \(task T-31 created/);

  const known = configure(makeContext());
  known.fetcher.respond = (url) => {
    if (url === FORMS_URL) return { code: 200, body: JSON.stringify(FORMS) };
    if (url === FORM_DISPATCH_URL) return { code: 404, body: '{"message":"Resource not found"}' };
    if (url === TASKS_URL) return { code: 422, body: '{"message":"users is required"}' };
    return { code: 404, body: '{"message":"Resource not found"}' };
  };
  known.ctx.testFastFieldDispatch();
  assert.match(logText(known), /gateway KNOWS https:\/\/api\.fastfieldforms\.com\/services\/v3\/tasks \(HTTP 422, not 404\)[\s\S]*users is required/);
});

test('route discovery: runs only after a 404 on the primary route, never on other answers', () => {
  for (const code of [201, 400, 401, 403, 500]) {
    const env = configure(makeContext());
    fastFieldServer(env, { dispatch: { code, body: '{"message":"x"}' } });
    env.ctx.testFastFieldDispatch();
    assert.ok(!env.fetchCalls.some((c) => c.url === FORM_DISPATCH_URL || c.url === TASKS_URL), String(code));
  }
});

test('route discovery: a network failure on an alternative is logged and the next one is tried', () => {
  const env = configure(makeContext());
  env.fetcher.respond = (url) => {
    if (url === FORMS_URL) return { code: 200, body: JSON.stringify(FORMS) };
    if (url === FORM_DISPATCH_URL) return new Error('socket closed');
    return { code: 404, body: '{}' };
  };
  env.ctx.testFastFieldDispatch();
  assert.match(logText(env), /forms\/98765\/dispatch: request failed \(socket closed\)/);
  assert.ok(env.fetchCalls.some((c) => c.url === TASKS_URL));
});

test('route discovery: a real app sync never probes other routes', () => {
  const env = configure(makeContext());
  env.fetcher.respond = () => ({ code: 404, body: '{"message":"Resource not found"}' });
  const res = post(env, appPayload());
  assert.equal(res.ok, true);
  assert.deepEqual(env.fetchCalls.filter((c) => c.url !== AUTH_URL).map((c) => c.url), [FF_URL]);
  assert.equal(rowObj(env, res.row).FastField_Task_ID, '');
});

test('testFastFieldDispatch: a 400 or 422 on the dispatch logs FastField\'s exact validation message', () => {
  for (const code of [400, 422]) {
    const env = configure(makeContext());
    fastFieldServer(env, { dispatch: { code, body: JSON.stringify({ message: 'Validation failed', errors: [{ field: 'users', error: 'unknown user' }] }) } });
    env.ctx.testFastFieldDispatch();
    assert.match(logText(env), new RegExp('HTTP status: ' + code));
    assert.match(logText(env), /rejected the request as invalid[\s\S]*message: Validation failed[\s\S]*unknown user/);
  }
});

test('testFastFieldDispatch: a dispatch 401 retries once with a fresh session and says so', () => {
  const env = configure(makeContext());
  const tokens = [TOKEN, 'ffffffffffffffffffffffffffffffff'];
  env.fetcher.authRespond = () => ({ code: 200, body: JSON.stringify({ sessionToken: tokens.shift() }) });
  env.fetcher.respond = (url, options) => {
    if (url === FORMS_URL) return { code: 200, body: JSON.stringify(FORMS) };
    return options.headers['X-Gatekeeper-SessionToken'] === TOKEN
      ? { code: 401, body: '{}' } : { code: 201, body: JSON.stringify({ id: 'T-9' }) };
  };
  env.ctx.testFastFieldDispatch();
  assert.match(logText(env), /fresh session was started and the dispatch retried once[\s\S]*HTTP status: 201[\s\S]*created task T-9/);
});

test('testFastFieldDispatch: a network failure and a non-JSON reply are explained', () => {
  const down = configure(makeContext());
  down.fetcher.respond = () => new Error('DNS error');
  assert.equal(down.ctx.testFastFieldDispatch(), null);
  assert.match(logText(down), /Request failed before FastField answered: DNS error/);

  const html = configure(makeContext());
  fastFieldServer(html, { dispatch: { code: 502, body: '<html>bad gateway</html>' } });
  html.ctx.testFastFieldDispatch();
  assert.match(logText(html), /not JSON[\s\S]*bad gateway/);
});

// --- sanitized properties ----------------------------------------------------

test('sanitize: trims whitespace, newlines, tabs and surrounding quotes, and nothing else', () => {
  const { sanitizeProperty_ } = makeContext().ctx;
  assert.equal(sanitizeProperty_('  abc123 \n'), 'abc123');
  assert.equal(sanitizeProperty_('\tabc\r\n'), 'abc');
  assert.equal(sanitizeProperty_('"abc"'), 'abc');
  assert.equal(sanitizeProperty_("'abc'"), 'abc');
  assert.equal(sanitizeProperty_(' "abc" \n'), 'abc');
  assert.equal(sanitizeProperty_('"\'abc\'"'), 'abc');
  assert.equal(sanitizeProperty_('"abc'), 'abc');
  assert.equal(sanitizeProperty_('a"b c'), 'a"b c', 'characters inside are left alone');
  assert.equal(sanitizeProperty_(''), '');
  assert.equal(sanitizeProperty_('   '), '');
  assert.equal(sanitizeProperty_('""'), '');
  assert.equal(sanitizeProperty_(null), '');
  assert.equal(sanitizeProperty_(undefined), '');
});

test('sanitize: pasted FastField settings are cleaned before use', () => {
  const env = makeContext();
  Object.assign(env.props, {
    FASTFIELD_SUBSCRIPTION_KEY: ' \'' + SUB + '\'\n',
    FASTFIELD_FORM_ID: " '98765' ",
    FASTFIELD_USER_ID: '\t"' + USER + '" \n',
    FASTFIELD_PASSWORD: '  "' + PASSWORD + '"\n',
  });
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), 'FF-1001');
  assert.equal(signIns(env)[0].options.headers.Authorization, basic(USER, PASSWORD));
  assert.equal(signIns(env)[0].options.headers['Ocp-Apim-Subscription-Key'], SUB);
  assertSessionHeaders(dispatches(env)[0]);
  const payload = JSON.parse(dispatches(env)[0].options.payload);
  assert.equal(payload.formId, 98765);
  assert.deepEqual(payload.users, [USER]);
});

test('sanitize: a property that is only whitespace or quotes counts as missing', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_SUBSCRIPTION_KEY = ' "" \n';
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), null);
  assert.equal(env.fetchCalls.length, 0);
  assert.ok(env.logs.warn.some((w) => w.includes('FASTFIELD_SUBSCRIPTION_KEY')));
});

test('dispatch: the old FASTFIELD_API_KEY is no longer used or needed', () => {
  const env = configure(makeContext());
  env.props.FASTFIELD_API_KEY = 'legacy-user-token';
  assert.equal(env.ctx.dispatchToFastField_({ call_id: 'J', outcome: 1 }), 'FF-1001');
  assert.ok(!JSON.stringify(env.fetchCalls).includes('legacy-user-token'));
});

test('sanitize: API_SECRET with stray whitespace or quotes in Script Properties still authorizes the clean token', () => {
  for (const stored of [API_SECRET + '\n', ' "' + API_SECRET + '" ', "'" + API_SECRET + "'"]) {
    const env = makeContext();
    env.props.API_SECRET = stored;
    const res = post(env, { token: API_SECRET, call_id: 'X1', customer_phone: '916-555-0150' });
    assert.equal(res.ok, true, JSON.stringify(stored) + ' ' + JSON.stringify(res));
  }
  const env = makeContext();
  env.props.API_SECRET = '  ';
  assert.equal(post(env, { token: API_SECRET, call_id: 'X1', customer_phone: '916-555-0150' }).code, 'SERVER_MISCONFIGURED');
});

test('testFastFieldDispatch: classifies other key formats, flags inner whitespace, and masks a short key', () => {
  const info = makeContext().ctx.describeKey_;
  assert.equal(info('abc', 'abc').masked, '(too short to show safely)');
  assert.equal(info('x', 'ZXhhbXBsZQ.ZXhhbXBsZQ.ZXhhbXBsZQ').format, 'JWT-like (three dot-separated parts)');
  assert.equal(info('x', 'AbC123xyz456QwErTy').format, 'alphanumeric');
  assert.equal(info('x', 'ABCDEF0123').format, 'hexadecimal, 10 characters');
  assert.equal(info('x', 'ab cd-ef!').format, 'other');
  assert.equal(info('ab\ncd', 'ab\ncd').hasInternalWhitespace, true);
  assert.equal(info('clean', 'clean').hadSurroundingWhitespace, false);
  assert.equal(info('clean', 'clean').hadSurroundingQuotes, false);
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
