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

test('SCHEMA.md example payload keys == iOS SyncPayload keys', (t) => {
  const schemaPath = path.join(root, '..', 'SCHEMA.md');
  if (!fs.existsSync(schemaPath)) return t.skip('SCHEMA.md lives outside the repo');
  const json = fs.readFileSync(schemaPath, 'utf8').match(/```json\s*([\s\S]*?\})/)[1];
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
    leadSource: 'Lead_Source',
    serviceRequested: 'Service_Requested',
    drivetrain: 'Drivetrain',
    vehicleCondition: 'Vehicle_Condition',
    sceneLocation: 'Scene_Location',
    urgencyLevel: 'Urgency_Level',
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
