// Local tests for apps-script/Code.gs against in-memory mocks of the Apps Script services.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { API_SECRET, WEBSITE_SECRET, makeContext, post, rowObj, dataRowCount } = require('./support/gas-mock');

function appPayload(overrides = {}) {
  return Object.assign({
    token: API_SECRET,
    call_id: 'A1B2C3D4-0000-4000-8000-000000000001',
    date_time: '2026-10-02T21:32:00Z',
    customer_phone: '916-555-0199',
    caller_type: 'Private Cash',
    payer_name: 'Cash / Customer',
    service_requested: 'Standard Tow',
    vehicle_year: '2021',
    vehicle_make: 'Tesla',
    vehicle_model: 'Model 3',
    drivetrain: 'Electric Vehicle (EV)',
    vehicle_condition: 'No Keys',
    scene_location: 'Highway / Freeway Shoulder',
    start_location: 'I-80 Eastbound',
    pickup_address: 'I-80 & Madison Ave, Sacramento',
    dropoff_address: '123 Auto Body Way',
    quoted_price: 285.0,
    outcome: '1 - Won / Booked',
    decline_reason: '',
    notes_comments: 'Customer stuck on shoulder.',
  }, overrides);
}

function callRail(overrides = {}) {
  return Object.assign({
    id: 'CAL123',
    customer_phone_number: '+19165550199',
    start_time: '2026-10-02T14:40:00.000-07:00', // 21:40Z, 8 min after the app call
    duration: '145',
    recording: 'https://api.callrail.com/v3/a/ACC1/calls/CAL123/recording.json',
    keywords: 'emergency tow truck',
    campaign: 'Sacramento_Towing_HighIntent',
    source: 'Google Ads',
  }, overrides);
}

const CR_QUERY = { source: 'callrail', token: API_SECRET };

// --- Tests ------------------------------------------------------------------

test('setup writes headers and reference data incl. Website Form', () => {
  const env = makeContext();
  assert.equal(env.sheet.data[0].length, 29);
  assert.ok(!env.sheet.data[0].includes('Urgency_Level'));
  const leadCol = env.ref.data[0].indexOf('Lead_Source');
  assert.ok(env.ref.data.some((r) => r[leadCol] === 'Website Form'));
});

test('auth: wrong token, missing token, and website secret cannot be used for app', () => {
  const env = makeContext();
  assert.equal(post(env, appPayload({ token: 'nope' })).code, 'UNAUTHORIZED');
  assert.equal(post(env, appPayload({ token: undefined })).code, 'UNAUTHORIZED');
  assert.equal(post(env, appPayload({ token: WEBSITE_SECRET })).code, 'UNAUTHORIZED');
  assert.equal(post(env, { phone: '9165550100' }, { source: 'website', token: API_SECRET }).code, 'UNAUTHORIZED');
  assert.equal(dataRowCount(env), 0);
});

test('app: creates a row with normalized values and computed miles', () => {
  const env = makeContext();
  const res = post(env, appPayload({ customer_phone: '(916) 555-0199', decline_reason: 'Price Too High' }));
  assert.equal(res.ok, true);
  assert.equal(res.action, 'created');
  assert.deepEqual(res.warnings, []);
  const r = rowObj(env, res.row);
  assert.equal(r.Call_ID, 'A1B2C3D4-0000-4000-8000-000000000001');
  assert.equal(r.Customer_Phone, '916-555-0199');
  assert.equal(r.Quoted_Price, 285);
  assert.equal(r.Vehicle_Year, 2021);
  assert.equal(r.Decline_Reason, 'N/A - Won', 'won calls force N/A - Won');
  assert.equal(r.Deadhead_Est_Miles, 10);
  assert.equal(r.Loaded_Miles, 10);
  assert.equal(r.Date_Time.toISOString(), '2026-10-02T21:32:00.000Z');
  assert.ok(env.mapsCalls.includes('Rio Linda, CA -> I-80 & Madison Ave, Sacramento'));
  assert.equal(r.Call_Recording_URL, '');
});

test('app: retry with same call_id updates instead of duplicating', () => {
  const env = makeContext();
  post(env, appPayload());
  const res = post(env, appPayload({ quoted_price: '$300.00' }));
  assert.equal(res.action, 'updated');
  assert.equal(dataRowCount(env), 1);
  assert.equal(rowObj(env, 2).Quoted_Price, 300);
});

test('app: customer_phone must have at least 10 digits, ignoring formatting', () => {
  const env = makeContext();
  const expected = { ok: false, code: 'BAD_REQUEST', error: 'customer_phone is required and must be at least 10 digits.' };
  for (const bad of ['', '   ', '916-555-019', '(916) 555-01', 'call me', '+1 (916) 555']) {
    assert.deepEqual(post(env, appPayload({ customer_phone: bad })), expected, JSON.stringify(bad));
  }
  const noPhone = appPayload();
  delete noPhone.customer_phone;
  assert.deepEqual(post(env, noPhone), expected, 'missing key');
  assert.equal(dataRowCount(env), 0, 'rejected syncs never create a row');

  for (const [i, good] of ['9165550199', '916-555-0199', '(916) 555-0199', '+1 916-555-0199', '916.555.0199'].entries()) {
    const res = post(env, appPayload({ call_id: `ok-${i}`, customer_phone: good }));
    assert.equal(res.ok, true, good);
    assert.equal(rowObj(env, res.row).Customer_Phone, '916-555-0199', `${good} is stored in one canonical format`);
  }
});

test('phone rule is for dispatcher syncs only: website leads and CallRail are unchanged', () => {
  const env = makeContext();
  const web = post(env, { token: WEBSITE_SECRET, notes_comments: 'no phone given' }, { source: 'website' });
  assert.equal(web.ok, true);
  const cr = post(env, callRail({ customer_phone_number: '' }), CR_QUERY);
  assert.equal(cr.ok, true);
  assert.ok(cr.warnings.length > 0);
});

test('timestamps are stored as whole seconds in yyyy-mm-dd hh:mm:ss, never with milliseconds', () => {
  const env = makeContext();
  env.sheet.formats = {}; // as in a sheet created before setup() ran
  const col = (h) => env.sheet.data[0].indexOf(h) + 1;

  // 1. iOS date_time carrying milliseconds
  const app = post(env, appPayload({ date_time: '2026-10-02T15:56:04.788Z' }));
  const dt = rowObj(env, app.row).Date_Time;
  assert.equal(dt.getUTCMilliseconds(), 0);
  assert.equal(dt.toISOString(), '2026-10-02T15:56:04.000Z');
  assert.equal(env.sheet.formats[col('Date_Time')], 'yyyy-mm-dd hh:mm:ss');

  // 2. no date_time at all -> server clock, still whole seconds
  const noDate = appPayload({ call_id: 'no-date' });
  delete noDate.date_time;
  const serverTime = rowObj(env, post(env, noDate).row).Date_Time;
  assert.equal(serverTime.getUTCMilliseconds(), 0);

  // 3. CallRail start_time with milliseconds (new row)
  const cr = post(env, callRail({ customer_phone_number: '+12795550123', start_time: '2026-10-02T14:40:00.999-07:00' }), CR_QUERY);
  assert.equal(rowObj(env, cr.row).Date_Time.toISOString(), '2026-10-02T21:40:00.000Z');

  // 4. AI_Processed_At is written from the server clock
  post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, caller_tone: 'Calm' }, { source: 'ai' });
  const processed = rowObj(env, cr.row).AI_Processed_At;
  assert.equal(processed.getUTCMilliseconds(), 0);
  assert.equal(env.sheet.formats[col('AI_Processed_At')], 'yyyy-mm-dd hh:mm:ss');

  // 5. the worker's pending list has no fractional seconds either
  const pending = post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' });
  for (const item of pending.items) assert.doesNotMatch(item.date_time, /\.\d/);
});

test('app: missing call_id is rejected', () => {
  const env = makeContext();
  const res = post(env, appPayload({ call_id: '' }));
  assert.equal(res.code, 'BAD_REQUEST');
});

test('app: unknown chip values are stored but flagged', () => {
  const env = makeContext();
  const res = post(env, appPayload({ drivetrain: 'Hover' }));
  assert.equal(res.ok, true);
  assert.equal(rowObj(env, res.row).Drivetrain, 'Hover');
  assert.match(res.warnings[0], /Drivetrain/);
});

test('app: new chip values are accepted without warnings', () => {
  const env = makeContext();
  const res = post(env, appPayload({
    payer_name: 'Triple A (AAA)',
    drivetrain: 'Hybrid',
    service_requested: 'Winch Out + Tow',
    vehicle_condition: 'Mechanical / Electrical Issue',
  }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  const r = rowObj(env, res.row);
  assert.equal(r.Payer_Name, 'Triple A (AAA)');
  assert.equal(r.Drivetrain, 'Hybrid');
  assert.equal(r.Service_Requested, 'Winch Out + Tow');
  assert.equal(r.Vehicle_Condition, 'Mechanical / Electrical Issue');
  assert.match(post(env, appPayload({ call_id: 'old', vehicle_condition: 'Collision / Wheel Damaged' })).warnings[0], /Vehicle_Condition/);
});

test('app: lead_source and urgency_level are not app fields (stale builds cannot write them)', () => {
  const env = makeContext();
  const res = post(env, appPayload({ lead_source: 'Google Ads', urgency_level: 'Standard' }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  const r = rowObj(env, res.row);
  assert.equal(r.Lead_Source, '');
  assert.ok(!('Urgency_Level' in r), 'column retired');
  assert.ok(!r.Notes_Comments.includes('Google Ads'), 'ignored, not appended to notes');
});

test('callrail after app: merges marketing data without touching dispatcher fields', () => {
  const env = makeContext();
  post(env, appPayload());
  const before = rowObj(env, 2);
  const res = post(env, callRail(), CR_QUERY);
  assert.equal(res.action, 'merged');
  assert.equal(res.call_id, before.Call_ID);
  assert.equal(dataRowCount(env), 1);
  const after = rowObj(env, 2);
  assert.equal(after.Search_Keyword, 'emergency tow truck');
  assert.equal(after.Campaign_Name, 'Sacramento_Towing_HighIntent');
  assert.equal(after.Call_Duration_Sec, 145);
  assert.equal(after.Call_Recording_URL, callRail().recording);
  assert.equal(after.Lead_Source, 'Google Ads', 'CallRail attribution fills the blank Lead_Source');
  for (const h of ['Call_ID', 'Customer_Phone', 'Quoted_Price', 'Outcome', 'Notes_Comments']) {
    assert.deepEqual(after[h], before[h], `${h} untouched`);
  }
});

test('callrail maps tracking source to Lead_Source', () => {
  const cases = [
    [{ source: 'Google Ads' }, 'Google Ads'],
    [{ source: 'Google AdWords' }, 'Google Ads'],
    [{ source: 'Google Paid', medium: 'cpc' }, 'Google Ads'],
    [{ source: 'Bing', medium: 'PPC' }, 'Google Ads'],
    [{ source: 'Google Organic', medium: 'organic' }, 'Google Maps / Organic'],
    [{ source: 'Google My Business' }, 'Google Maps / Organic'],
    [{ source: 'Google Maps' }, 'Google Maps / Organic'],
    [{ source: 'Direct' }, 'Repeat / Direct'],
    [{ source: 'Organic Search' }, 'Repeat / Direct'],
    [{ source: 'Referral' }, 'Repeat / Direct'],
    [{ source: 'Motor Club Referral' }, 'Motor Club Referral'],
    [{ source: 'AAA Auto Club' }, 'Motor Club Referral'],
    [{ source: 'Facebook', medium: 'social' }, 'Other'],
    [{ source: 'Yelp' }, 'Other'],
  ];
  cases.forEach(([attrib, expected], i) => {
    const env = makeContext();
    const res = post(env, callRail({ customer_phone_number: `+1279555${String(i).padStart(4, '0')}`, ...attrib }), CR_QUERY);
    assert.equal(rowObj(env, res.row).Lead_Source, expected, JSON.stringify(attrib));
  });
});

test('callrail with no attribution leaves Lead_Source blank for the AI fallback', () => {
  const env = makeContext();
  const call = callRail();
  delete call.source;
  const res = post(env, call, CR_QUERY);
  assert.equal(rowObj(env, res.row).Lead_Source, '');
});

test('callrail fills a blank Lead_Source on merge but never overwrites an existing one', () => {
  const env = makeContext();
  post(env, appPayload());
  assert.equal(rowObj(env, 2).Lead_Source, '', 'app never sets it');
  post(env, callRail({ source: 'Google Ads' }), CR_QUERY);
  assert.equal(rowObj(env, 2).Lead_Source, 'Google Ads');
  // A website lead keeps "Website Form" when the same person then phones in.
  const web = post(env, { token: WEBSITE_SECRET, phone: '916-555-0777', date_time: '2026-10-02T21:20:00Z' }, { source: 'website' });
  const merged = post(env, callRail({ customer_phone_number: '+19165550777', source: 'Direct',
    recording: 'https://api.callrail.com/v3/a/ACC1/calls/CAL777/recording.json' }), CR_QUERY);
  assert.equal(merged.row, web.row);
  assert.equal(rowObj(env, web.row).Lead_Source, 'Website Form');
});

test('ai: fills Lead_Source only when blank, and only with a picklist value', () => {
  const env = makeContext();
  // CallRail had no attribution -> blank, AI may fill it.
  const call = callRail();
  delete call.source;
  const cr = post(env, call, CR_QUERY);
  const pending = post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' });
  assert.equal(pending.items[0].lead_source, '');

  const bad = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, lead_source: 'Billboard' }, { source: 'ai' });
  assert.equal(bad.ok, true);
  assert.match(bad.warnings[0], /picklist/);
  assert.equal(rowObj(env, cr.row).Lead_Source, '');

  const good = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, lead_source: 'Repeat / Direct', caller_tone: 'Calm' }, { source: 'ai' });
  assert.deepEqual(good.warnings, []);
  assert.equal(rowObj(env, cr.row).Lead_Source, 'Repeat / Direct');
  assert.equal(rowObj(env, cr.row).Caller_Tone, 'Calm');

  // Already set (by CallRail or an earlier AI pass): the AI value is ignored.
  const again = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, lead_source: 'Google Ads' }, { source: 'ai' });
  assert.match(again.warnings[0], /already set/);
  assert.equal(rowObj(env, cr.row).Lead_Source, 'Repeat / Direct');
});

test('ai: CallRail attribution is never overwritten by the AI', () => {
  const env = makeContext();
  const cr = post(env, callRail({ source: 'Google Ads' }), CR_QUERY);
  const res = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, lead_source: 'Other' }, { source: 'ai' });
  assert.match(res.warnings[0], /already set/);
  assert.equal(rowObj(env, cr.row).Lead_Source, 'Google Ads');
});

test('callrail keyword: `keywords` wins, `utm_term` is the fallback, other fields are never used', () => {
  const kw = (n, extra) => {
    const env = makeContext();
    const res = post(env, callRail({ customer_phone_number: `+1279555${String(n).padStart(4, '0')}`, ...extra }), CR_QUERY);
    return rowObj(env, res.row).Search_Keyword;
  };
  assert.equal(kw(1, {}), 'emergency tow truck', 'documented `keywords` field');
  assert.equal(kw(2, { keywords: 'flatbed near me', utm_term: 'something else' }), 'flatbed near me');
  assert.equal(kw(3, { keywords: '', utm_term: 'tow near me' }), 'tow near me');
  assert.equal(kw(4, { keywords: ['cheap tow', 'tow truck'] }), 'cheap tow, tow truck');
  // `keywords_spotted` = words detected in the call audio, not what the visitor searched for.
  assert.equal(kw(5, { keywords: '', keywords_spotted: [{ keyword: 'flat tire' }] }), '');
});

test('callrail keyword: absent, empty and unfilled-template values are stored as blank without errors', () => {
  const env = makeContext();
  const blank = (n, extra) => {
    const call = callRail({ customer_phone_number: `+1279555${String(n).padStart(4, '0')}`, ...extra });
    if ('keywords' in extra === false) delete call.keywords;
    const res = post(env, call, CR_QUERY);
    assert.equal(res.ok, true, JSON.stringify(extra));
    assert.equal(rowObj(env, res.row).Search_Keyword, '', JSON.stringify(extra));
  };
  blank(1, {});                                   // GMB / Performance Max / organic: no keyword at all
  blank(2, { keywords: '' });
  blank(3, { keywords: null });
  blank(4, { keywords: [] });
  blank(5, { keywords: '', utm_term: '{keyword}' });      // ValueTrack placeholder never filled in
  blank(6, { keywords: '', utm_term: '(not set)' });
  blank(7, { keywords: '   ' });
});

test('callrail keyword: a later webhook without a keyword never erases an existing one', () => {
  const env = makeContext();
  post(env, callRail(), CR_QUERY);
  const again = post(env, callRail({ keywords: '', duration: '150' }), CR_QUERY);
  assert.equal(again.action, 'updated');
  const r = rowObj(env, again.row);
  assert.equal(r.Search_Keyword, 'emergency tow truck');
  assert.equal(r.Call_Duration_Sec, 150);
});

test('callrail webhooks log what arrived (keys and attribution, never phone or keyword text)', () => {
  const env = makeContext();
  const logs = [];
  env.ctx.console.log = (m) => logs.push(String(m));
  post(env, callRail({ source: 'Google My Business', medium: 'organic', keywords: undefined }), CR_QUERY);
  post(env, callRail({ customer_phone_number: '+12795550123', keywords: 'secret search words' }), CR_QUERY);
  const lines = logs.filter((l) => l.startsWith('CallRail webhook '));
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0].slice('CallRail webhook '.length));
  assert.equal(first.keyword_from, 'none');
  assert.equal(first.source, 'Google My Business');
  assert.match(first.payload_keys, /customer_phone_number/);
  assert.equal(JSON.parse(lines[1].slice('CallRail webhook '.length)).keyword_from, 'keywords');
  const all = lines.join('\n');
  assert.ok(!all.includes('secret search words'), 'keyword text is not logged');
  assert.ok(!all.includes('916-555') && !all.includes('9165550199'), 'phone numbers are not logged');
});

test('callrail lead source ignores source_name (the tracking number label), only `source` counts', () => {
  const env = makeContext();
  const call = callRail();
  delete call.source;
  call.source_name = 'Direct Line - Main Number';
  const res = post(env, call, CR_QUERY);
  assert.equal(rowObj(env, res.row).Lead_Source, '', 'left blank for the AI fallback, not mapped to Repeat / Direct');
});

// --- junk calls: unanswered / dropped calls never reach the AI -------------------------------

const NA = 'N/A';

function liveRow(env, extra = {}, n = 1) {
  const call = callRail({ customer_phone_number: `+1279555${String(n).padStart(4, '0')}`, ...extra });
  const res = post(env, call, CR_QUERY);
  assert.equal(res.ok, true);
  return { res, row: rowObj(env, res.row) };
}

test('callrail: an unanswered call is recorded as N/A and never queued for the AI', () => {
  for (const [i, answered] of [false, 'false', 0, 'no'].entries()) {
    const env = makeContext();
    const { res, row } = liveRow(env, { answered, source: 'Google Ads' }, i);
    assert.equal(res.ai_skipped, 'not_answered', JSON.stringify(answered));
    assert.equal(row.Caller_Tone, NA);
    assert.equal(row.Mentioned_Damage, NA);
    assert.equal(Object.prototype.toString.call(row.AI_Processed_At), '[object Date]', 'stamped as processed');
    assert.equal(row.Lead_Source, 'Google Ads', 'marketing attribution of a missed call is still real');
    assert.equal(row.Call_Recording_URL, callRail().recording);
    assert.equal(post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' }).count, 0, 'worker never sees it');
  }
});

test('callrail: a short call is junk, judged by recording_duration first and duration as the fallback', () => {
  const cases = [
    // [fields, expected ai_skipped]
    [{ answered: true, duration: '8' }, 'too_short'],
    [{ answered: true, duration: '14' }, 'too_short'],
    [{ answered: true, duration: '15' }, undefined],
    [{ answered: true, duration: '145' }, undefined],
    // ringing inflates `duration`; the recording's length is the better estimate of talk time
    [{ answered: true, duration: '40', recording_duration: '9' }, 'too_short'],
    [{ answered: true, duration: '12', recording_duration: '30' }, undefined],
    [{ answered: true, duration: '60', recording_duration: '15' }, undefined],
    [{ answered: true, duration: '60', recording_duration: '14' }, 'too_short'],
    [{ answered: true, duration: '60', recording_duration: 0 }, 'too_short'],
    // not enough information to judge: leave it to the worker
    [{ answered: true }, undefined],
  ];
  cases.forEach(([fields, expected], i) => {
    const env = makeContext();
    const call = callRail({ customer_phone_number: `+1279555${String(i).padStart(4, '0')}`, ...fields });
    if (!('duration' in fields)) delete call.duration;
    const res = post(env, call, CR_QUERY);
    assert.equal(res.ai_skipped, expected, JSON.stringify(fields));
    const row = rowObj(env, res.row);
    assert.equal(row.Caller_Tone, expected ? NA : '', JSON.stringify(fields));
  });
});

test('callrail: a normal answered call is left for the AI', () => {
  const env = makeContext();
  const { res, row } = liveRow(env, { answered: true, duration: '145' });
  assert.equal(res.ai_skipped, undefined);
  assert.equal(row.Caller_Tone, '');
  assert.equal(row.AI_Processed_At, '');
  assert.equal(post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' }).count, 1);
});

test('callrail: voicemails are analyzed, because answered=false can still hold a real customer message', () => {
  const env = makeContext();
  // CallRail marks the call unanswered but a message was left: not auto-skipped on `answered`.
  const left = liveRow(env, { answered: false, voicemail: true, duration: '75' }, 1);
  assert.equal(left.res.ai_skipped, undefined);
  assert.equal(left.row.Caller_Tone, '');
  // ...but a voicemail that is just a hang-up is still too short to be a conversation.
  const hangup = liveRow(env, { answered: false, voicemail: true, duration: '6' }, 2);
  assert.equal(hangup.res.ai_skipped, 'too_short');
});

test('callrail: a dispatcher-logged outcome proves a conversation, so the junk verdict is not applied', () => {
  const env = makeContext();
  post(env, appPayload()); // dispatcher took the call and logged Won
  const res = post(env, callRail({ answered: false }), CR_QUERY);
  assert.equal(res.action, 'merged');
  assert.equal(res.ai_skipped, undefined);
  const row = rowObj(env, res.row);
  assert.equal(row.Caller_Tone, '');
  assert.equal(row.AI_Processed_At, '');
  assert.equal(row.Search_Keyword, 'emergency tow truck', 'the CallRail data still merges');
});

test('callrail: junk rows merge into an outcome-less row, fill only blank AI cells, and repeats are idempotent', () => {
  const env = makeContext();
  const web = post(env, { token: WEBSITE_SECRET, phone: '916-555-0199', date_time: '2026-10-02T21:20:00Z' }, { source: 'website' });
  const first = post(env, callRail({ answered: false }), CR_QUERY);
  assert.equal(first.row, web.row);
  assert.equal(first.ai_skipped, 'not_answered');
  const again = post(env, callRail({ answered: false, duration: '3' }), CR_QUERY);
  assert.equal(again.action, 'updated');
  assert.equal(dataRowCount(env), 1);

  // A result the AI already produced is never replaced by N/A.
  const env2 = makeContext();
  const done = post(env2, callRail(), CR_QUERY);
  post(env2, { token: API_SECRET, action: 'update', call_id: done.call_id, caller_tone: 'Calm', mentioned_damage: 'flat tire' }, { source: 'ai' });
  const late = post(env2, callRail({ answered: false }), CR_QUERY);
  assert.equal(late.ai_skipped, undefined);
  const row = rowObj(env2, done.row);
  assert.equal(row.Caller_Tone, 'Calm');
  assert.equal(row.Mentioned_Damage, 'flat tire');
});

test('callrail: the junk reason is logged without the phone number', () => {
  const env = makeContext();
  const logs = [];
  env.ctx.console.log = (m) => logs.push(String(m));
  liveRow(env, { answered: false });
  const line = logs.find((l) => l.startsWith('CallRail webhook '));
  const diag = JSON.parse(line.slice('CallRail webhook '.length));
  assert.equal(diag.not_live, 'not_answered');
  assert.equal(diag.answered, false);
  assert.ok(!line.includes('916') && !line.includes('279555'));
});

test('ai: N/A is a valid Caller_Tone and Mentioned_Damage for the worker to record', () => {
  const env = makeContext();
  const cr = post(env, callRail(), CR_QUERY);
  const res = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, caller_tone: 'N/A', mentioned_damage: 'N/A' }, { source: 'ai' });
  assert.deepEqual(res.warnings, []);
  const row = rowObj(env, cr.row);
  assert.equal(row.Caller_Tone, 'N/A');
  assert.equal(row.Mentioned_Damage, 'N/A');
  assert.equal(post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' }).count, 0);
});

test('callrail retry (same recording) is idempotent', () => {
  const env = makeContext();
  post(env, appPayload());
  post(env, callRail(), CR_QUERY);
  const res = post(env, callRail({ duration: '150' }), CR_QUERY);
  assert.equal(res.action, 'updated');
  assert.equal(dataRowCount(env), 1);
  assert.equal(rowObj(env, 2).Call_Duration_Sec, 150);
});

test('callrail with no matching phone creates a row with blank dispatcher fields', () => {
  const env = makeContext();
  const res = post(env, callRail({ customer_phone_number: '+12795550123' }), CR_QUERY);
  assert.equal(res.action, 'created');
  const r = rowObj(env, res.row);
  assert.equal(r.Customer_Phone, '279-555-0123');
  assert.equal(r.Call_ID, res.call_id);
  assert.equal(r.Date_Time.toISOString(), '2026-10-02T21:40:00.000Z');
  assert.equal(r.Call_Recording_URL, callRail().recording);
  assert.equal(r.Lead_Source, 'Google Ads');
  for (const h of ['Caller_Type', 'Quoted_Price', 'Outcome', 'Decline_Reason']) {
    assert.equal(r[h], '', `${h} blank`);
  }
});

test('callrail outside the 60-minute window does not merge', () => {
  const env = makeContext();
  post(env, appPayload());
  const res = post(env, callRail({ start_time: '2026-10-02T16:00:00-07:00' }), CR_QUERY); // 23:00Z, +88 min
  assert.equal(res.action, 'created');
  assert.equal(dataRowCount(env), 2);
});

test('second CallRail call from same phone does not overwrite the first call data', () => {
  const env = makeContext();
  post(env, appPayload());
  post(env, callRail(), CR_QUERY);
  const res = post(env, callRail({
    recording: 'https://api.callrail.com/v3/a/ACC1/calls/CAL999/recording.json',
    start_time: '2026-10-02T14:55:00-07:00',
  }), CR_QUERY);
  assert.equal(res.action, 'created');
  assert.equal(rowObj(env, 2).Call_Recording_URL, callRail().recording);
});

test('callrail picks the eligible row closest in time', () => {
  const env = makeContext();
  post(env, appPayload({ call_id: 'early', date_time: '2026-10-02T21:00:00Z' }));
  post(env, appPayload({ call_id: 'late', date_time: '2026-10-02T21:38:00Z' }));
  const res = post(env, callRail(), CR_QUERY); // 21:40Z
  assert.equal(res.call_id, 'late');
});

test('app after callrail: claims the orphan row, keeps CallRail columns', () => {
  const env = makeContext();
  const cr = post(env, callRail(), CR_QUERY);
  assert.equal(cr.action, 'created');
  const res = post(env, appPayload());
  assert.equal(res.action, 'merged');
  assert.equal(res.row, cr.row);
  assert.equal(dataRowCount(env), 1);
  const r = rowObj(env, res.row);
  assert.equal(r.Call_ID, 'A1B2C3D4-0000-4000-8000-000000000001', 'app call_id becomes canonical');
  assert.equal(r.Outcome, '1 - Won / Booked');
  assert.equal(r.Search_Keyword, 'emergency tow truck');
  assert.equal(r.Call_Recording_URL, callRail().recording);
  // A later retry of the same sync finds it by call_id.
  assert.equal(post(env, appPayload()).action, 'updated');
  assert.equal(dataRowCount(env), 1);
});

test('app does not claim a row that already has an Outcome', () => {
  const env = makeContext();
  post(env, appPayload({ call_id: 'first' }));
  const res = post(env, appPayload({ call_id: 'second', date_time: '2026-10-02T21:50:00Z' }));
  assert.equal(res.action, 'created');
  assert.equal(dataRowCount(env), 2);
});

test('legacy sheet rows (text dates, 7-digit phones, numeric ids) still match', () => {
  const env = makeContext((sheet) => {
    const header = sheet.data[0];
    const row = new Array(header.length).fill('');
    row[header.indexOf('Call_ID')] = 1001;
    row[header.indexOf('Date_Time')] = '2026-10-02 14:30:00';
    row[header.indexOf('Customer_Phone')] = '555-0101';
    row[header.indexOf('Outcome')] = '1 - Won / Booked';
    sheet.data.push(row);
  });
  const res = post(env, callRail({ customer_phone_number: '555-0101', start_time: '2026-10-02 14:45:00' }), CR_QUERY);
  assert.equal(res.action, 'merged');
  assert.equal(res.call_id, '1001');
});

test('website form (form-encoded): aliases phone, defaults lead source, keeps extras, blocks formulas', () => {
  const env = makeContext();
  const e = {
    parameter: {
      source: 'website', token: WEBSITE_SECRET, phone: '+1 (916) 555-0142',
      name: 'Jane', message: '=HYPERLINK("http://evil")', service_requested: 'Lockout',
    },
    postData: { contents: 'source=website&token=x&phone=...', type: 'application/x-www-form-urlencoded' },
  };
  const res = JSON.parse(env.ctx.doPost(e).content);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.action, 'created');
  const r = rowObj(env, res.row);
  assert.equal(r.Customer_Phone, '916-555-0142');
  assert.equal(r.Lead_Source, 'Website Form');
  assert.equal(r.Service_Requested, 'Lockout');
  assert.match(r.Notes_Comments, /name: Jane/);
  assert.ok(!r.Notes_Comments.startsWith('='));
  assert.ok(r.Call_ID.length > 10);
  assert.equal(r.Outcome, '');

  const formula = post(env, { notes_comments: '=1+1', phone: '9165550143' }, { source: 'website', token: WEBSITE_SECRET });
  assert.equal(rowObj(env, formula.row).Notes_Comments, "'=1+1");
});

test('website lead then dispatcher call: app claims the website row', () => {
  const env = makeContext();
  const web = post(env, { token: WEBSITE_SECRET, phone: '916-555-0199', date_time: '2026-10-02T21:20:00Z' }, { source: 'website' });
  const res = post(env, appPayload());
  assert.equal(res.action, 'merged');
  assert.equal(res.row, web.row);
});

test('maps failure leaves miles blank with a warning but still saves', () => {
  const env = makeContext();
  const res = post(env, appPayload({ dropoff_address: 'nowhere' }));
  assert.equal(res.ok, true);
  assert.equal(rowObj(env, res.row).Loaded_Miles, '');
  assert.equal(rowObj(env, res.row).Deadhead_Est_Miles, 10);
  assert.match(res.warnings.join(), /Loaded_Miles/);
});

test('ai: pending lists unprocessed recordings; update writes only AI columns', () => {
  const env = makeContext();
  post(env, appPayload());
  post(env, callRail(), CR_QUERY);
  post(env, appPayload({ call_id: 'no-audio', customer_phone: '916-555-0000' }));

  const pending = post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' });
  assert.equal(pending.count, 1);
  assert.equal(pending.items[0].call_id, 'A1B2C3D4-0000-4000-8000-000000000001');
  assert.equal(pending.items[0].call_recording_url, callRail().recording);

  const before = rowObj(env, 2);
  const upd = post(env, {
    token: API_SECRET, action: 'update', call_id: pending.items[0].call_id,
    caller_tone: 'Stressed', mentioned_damage: ['front bumper', 'flat tire'],
    quoted_price: 1, outcome: '0 - Lost / Declined', // must be ignored
  }, { source: 'ai' });
  assert.equal(upd.ok, true);
  const after = rowObj(env, 2);
  assert.equal(after.Caller_Tone, 'Stressed');
  assert.equal(after.Mentioned_Damage, 'front bumper, flat tire');
  assert.equal(Object.prototype.toString.call(after.AI_Processed_At), '[object Date]');
  const aiCols = ['Caller_Tone', 'Mentioned_Damage', 'AI_Processed_At'];
  for (const h of env.sheet.data[0].filter((c) => !aiCols.includes(c))) assert.deepEqual(after[h], before[h], `${h} untouched`);

  assert.equal(post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' }).count, 0);
});

test('ai: update falls back to recording URL when call_id was re-keyed', () => {
  const env = makeContext();
  const cr = post(env, callRail(), CR_QUERY);
  post(env, appPayload()); // re-keys the orphan's call_id
  const res = post(env, {
    token: API_SECRET, action: 'update', call_id: cr.call_id,
    call_recording_url: callRail().recording, caller_tone: 'Calm',
  }, { source: 'ai' });
  assert.equal(res.ok, true);
  assert.equal(res.call_id, 'A1B2C3D4-0000-4000-8000-000000000001');
  assert.equal(post(env, { token: API_SECRET, action: 'update', call_id: 'missing', caller_tone: 'x' }, { source: 'ai' }).code, 'NOT_FOUND');
});

test('ai: never overwrites Caller_Tone or Mentioned_Damage that are already set', () => {
  const env = makeContext();
  const cr = post(env, callRail(), CR_QUERY);
  const first = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id,
    caller_tone: 'Calm', mentioned_damage: ['dented door'] }, { source: 'ai' });
  assert.deepEqual(first.warnings, []);

  const second = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id,
    caller_tone: 'Angry', mentioned_damage: ['totalled'] }, { source: 'ai' });
  assert.equal(second.ok, true);
  assert.equal(second.warnings.length, 2);
  const r = rowObj(env, cr.row);
  assert.equal(r.Caller_Tone, 'Calm');
  assert.equal(r.Mentioned_Damage, 'dented door');

  const pending = post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' });
  assert.equal(pending.count, 0, 'processed rows leave the queue');
});

test('ai: pending reports current AI cells so the worker can ask only for blanks', () => {
  const env = makeContext();
  const cr = post(env, callRail({ source: 'Google Ads' }), CR_QUERY);
  env.sheet.data[cr.row - 1][env.sheet.data[0].indexOf('Mentioned_Damage')] = 'typed by hand';
  const item = post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' }).items[0];
  assert.equal(item.lead_source, 'Google Ads');
  assert.equal(item.mentioned_damage, 'typed by hand');
  assert.equal(item.caller_tone, '');
});

test('ai: Caller_Tone must be in the picklist; arrays and "None" are stored as text', () => {
  const env = makeContext();
  const cr = post(env, callRail(), CR_QUERY);
  const res = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id,
    caller_tone: 'Hysterical', mentioned_damage: 'None' }, { source: 'ai' });
  assert.match(res.warnings[0], /Caller_Tone/);
  const r = rowObj(env, cr.row);
  assert.equal(r.Caller_Tone, '');
  assert.equal(r.Mentioned_Damage, 'None');
});

test('ai: mark_processed retires a row without writing values; empty updates are rejected', () => {
  const env = makeContext();
  const cr = post(env, callRail(), CR_QUERY);
  assert.equal(post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id }, { source: 'ai' }).code, 'BAD_REQUEST');
  const res = post(env, { token: API_SECRET, action: 'update', call_id: cr.call_id, mark_processed: true }, { source: 'ai' });
  assert.equal(res.ok, true);
  assert.equal(post(env, { token: API_SECRET, action: 'pending' }, { source: 'ai' }).count, 0);
});

test('unknown source and malformed JSON are handled', () => {
  const env = makeContext();
  assert.equal(post(env, appPayload(), { source: 'bogus' }).code, 'BAD_REQUEST');
  const res = JSON.parse(env.ctx.doPost({ parameter: {}, postData: { contents: '{not json' } }).content);
  assert.equal(res.code, 'UNAUTHORIZED');
});
