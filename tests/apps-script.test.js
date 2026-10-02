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
  assert.equal(env.sheet.data[0].length, 30);
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

test('app: lead_source and urgency_level are no longer app-owned (stale builds cannot write them)', () => {
  const env = makeContext();
  const res = post(env, appPayload({ lead_source: 'Google Ads', urgency_level: 'Standard' }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  const r = rowObj(env, res.row);
  assert.equal(r.Lead_Source, '');
  assert.equal(r.Urgency_Level, '');
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
  for (const h of ['Call_ID', 'Customer_Phone', 'Lead_Source', 'Quoted_Price', 'Outcome', 'Notes_Comments']) {
    assert.deepEqual(after[h], before[h], `${h} untouched`);
  }
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
  for (const h of ['Caller_Type', 'Lead_Source', 'Quoted_Price', 'Outcome', 'Decline_Reason']) {
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
    const row = new Array(30).fill('');
    row[0] = 1001; row[1] = '2026-10-02 14:30:00'; row[2] = '555-0101'; row[20] = '1 - Won / Booked';
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
  for (const h of env.sheet.data[0].slice(0, 27)) assert.deepEqual(after[h], before[h], `${h} untouched`);

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

test('unknown source and malformed JSON are handled', () => {
  const env = makeContext();
  assert.equal(post(env, appPayload(), { source: 'bogus' }).code, 'BAD_REQUEST');
  const res = JSON.parse(env.ctx.doPost({ parameter: {}, postData: { contents: '{not json' } }).content);
  assert.equal(res.code, 'UNAUTHORIZED');
});
