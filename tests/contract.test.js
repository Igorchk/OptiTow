// Guards against key/value drift between SCHEMA.md, the Apps Script and the iOS app.
// Run: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function loadGs() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(read('apps-script/Code.gs') + '\nthis.__out = { APP_FIELDS, ENUMS, HEADERS };', ctx);
  return ctx.__out;
}

function swiftStructProps(source, structName) {
  const body = source.split(`struct ${structName}`)[1].split('\n}')[0];
  return [...body.matchAll(/^\s*let (\w+):/gm)].map((m) => m[1]);
}

function swiftArray(source, name) {
  const m = source.match(new RegExp(`static let ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `ChipOptions.${name} not found`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

function swiftString(source, name) {
  return source.match(new RegExp(`static let ${name} = "([^"]*)"`))[1];
}

test('iOS SyncPayload keys == Apps Script APP_FIELDS keys + token', () => {
  const { APP_FIELDS } = loadGs();
  const payload = swiftStructProps(read('ios/OptiTow/Models/CallRecord.swift'), 'SyncPayload');
  assert.deepEqual([...payload].sort(), ['token', ...Object.keys(APP_FIELDS)].sort());
});

test('SCHEMA.md example payload keys == iOS SyncPayload keys', () => {
  const json = read('SCHEMA.md').match(/```json\s*([\s\S]*?\})/)[1];
  const schemaKeys = Object.keys(JSON.parse(json));
  const payload = swiftStructProps(read('ios/OptiTow/Models/CallRecord.swift'), 'SyncPayload');
  assert.deepEqual([...payload].sort(), [...schemaKeys].sort());
});

test('iOS chip strings == Apps Script ENUMS', () => {
  const { ENUMS } = loadGs();
  const src = read('ios/OptiTow/Catalog/ChipOptions.swift');
  const pairs = {
    callerType: 'Caller_Type',
    payerName: 'Payer_Name',
    serviceRequested: 'Service_Requested',
    drivetrain: 'Drivetrain',
    vehicleCondition: 'Vehicle_Condition',
    sceneLocation: 'Scene_Location',
  };
  for (const [swift, header] of Object.entries(pairs)) {
    assert.deepEqual(swiftArray(src, swift), [...ENUMS[header]], header);
  }
  assert.deepEqual([swiftString(src, 'outcomeWon'), swiftString(src, 'outcomeLost')], [...ENUMS.Outcome]);
  // The app offers the four real reasons; the server fills "N/A - Won" itself.
  assert.deepEqual(swiftArray(src, 'declineReason'), [...ENUMS.Decline_Reason].filter((r) => r !== 'N/A - Won'));
});

test('vehicles.json has 15 makes, Tesla models per APP_SPEC', () => {
  const vehicles = JSON.parse(read('ios/OptiTow/Resources/vehicles.json'));
  assert.equal(vehicles.length, 15);
  assert.equal(new Set(vehicles.map((v) => v.make)).size, 15);
  const tesla = vehicles.find((v) => v.make === 'Tesla');
  assert.deepEqual(tesla.models, ['Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck']);
  for (const v of vehicles) assert.ok(v.models.length > 0 && !v.models.includes('Other'), v.make);
});

test('column layout: 29 columns, Urgency_Level retired, dispatcher block is columns 1-21', () => {
  const { APP_FIELDS, HEADERS } = loadGs();
  assert.equal(HEADERS.length, 29);
  assert.equal(new Set(HEADERS).size, 29);
  assert.ok(!HEADERS.includes('Urgency_Level'));
  // Everything the app/website may write (plus the two computed mileage columns) is exactly the
  // first 21 columns; everything after is automated, starting with Lead_Source.
  const dispatcher = [...Object.values(APP_FIELDS), 'Loaded_Miles', 'Deadhead_Est_Miles'];
  assert.deepEqual([...dispatcher].sort(), [...HEADERS].slice(0, 21).sort());
  assert.deepEqual([...HEADERS].slice(21, 26), ['Lead_Source', 'Search_Keyword', 'Campaign_Name', 'Call_Duration_Sec', 'Call_Recording_URL']);
  assert.deepEqual([...HEADERS].slice(26), ['Caller_Tone', 'Mentioned_Damage', 'AI_Processed_At']);
});

test('worker/schema.py picklists == Apps Script ENUMS (Caller_Tone, Lead_Source)', () => {
  const { ENUMS } = loadGs();
  const py = read('worker/schema.py');
  const literal = (name) => {
    const m = py.match(new RegExp(`${name} = Literal\\[([^\\]]*)\\]`));
    assert.ok(m, `${name} Literal not found in schema.py`);
    return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(literal('CallerTone'), [...ENUMS.Caller_Tone]);
  assert.deepEqual(literal('LeadSource'), [...ENUMS.Lead_Source]);
});

test('worker only writes keys the Apps Script AI endpoint accepts', () => {
  const gs = read('apps-script/Code.gs');
  const body = gs.split('function applyAiResult_')[1].split('\n}\n')[0];
  const accepted = [...body.matchAll(/body\.([a-z_]+)/g)].map((m) => m[1]);
  // The fields declared on the worker's Enrichment model.
  const workerFields = [...read('worker/schema.py').matchAll(/^    (\w+): .*Field\(/gm)].map((m) => m[1]);
  assert.deepEqual([...workerFields].sort(), ['caller_tone', 'lead_source', 'mentioned_damage']);
  for (const key of [...workerFields, 'mark_processed', 'call_id', 'call_recording_url']) {
    assert.ok(accepted.includes(key), `${key} is read by applyAiResult_`);
  }
});
