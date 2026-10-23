// Keeps the dispatch payload in step with the FastField form: every field key it sends must exist in
// the form, with the types and lists the form defines. The form is described by
// tests/support/fastfield-form-fields.json, exported from "Recovery Towing-18.xlsx". When the form
// changes, export it again and replace that file: these tests then say what the dispatch no longer
// matches. Run: npm test
'use strict';

const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const form = require('./support/fastfield-form-fields.json');
const { makeContext } = require('./support/gas-mock');

const WON = '1 - Won / Booked';

/** The merge fields a won call produces, as { key: value }. */
function dispatchFields(call, props = {}) {
  const env = makeContext();
  Object.assign(env.props, props);
  const payload = env.ctx.buildFastFieldPayload_(
    Object.assign({ call_id: 'J', outcome: WON, vehicle_year: 2022, quoted_price: 150,
      pickup_address: '965 Riverside Ave, Roseville, CA 95678',
      dropoff_address: '123 Main St, Sacramento, CA 95814' }, call),
    98765, { field: 'recipients', value: '797771' });
  return Object.fromEntries(payload.mergeFields.map((e) => [e.fieldKey, e.value]));
}

test('form keys: every merge field the dispatch sends exists in the FastField form', () => {
  const sent = Object.keys(dispatchFields({ pickup_coords: '38.7, -121.3', dropoff_coords: '38.5, -121.4' }));
  const unknown = sent.filter((key) => !(key in form.fields));
  assert.deepEqual(unknown, [], 'keys the form does not have');
});

test('form keys: year and both ZIPs go, as text, to the Formatted Input fields numeric_1, numeric_2 and numeric_3', () => {
  for (const key of ['numeric_1', 'numeric_2', 'numeric_3']) {
    assert.equal(form.fields[key].type, 'Formatted Input', key);
  }
  assert.equal(form.fields.numeric_1.name, 'Year');
  assert.equal(form.fields.numeric_2.name, 'ZIP');
  assert.equal(form.fields.numeric_3.name, 'ZIP');
  const f = dispatchFields({});
  assert.deepEqual([f.numeric_1, f.numeric_2, f.numeric_3], ['2022', '95678', '95814']);
  for (const key of ['numeric_1', 'numeric_2', 'numeric_3']) assert.equal(typeof f[key], 'string', key);
  // The Card Amount really is a Numeric field, so it stays a number.
  assert.equal(form.fields.numeric_4.type, 'Numeric');
  assert.equal(typeof f.numeric_4, 'number');
});

test('form keys: the address, problem, service, amount and notes keys are the ones the receipt prints', () => {
  const expected = {
    alpha_9: 'Address', alpha_10: 'City', alpha_11: 'State', alpha_13: 'Address', alpha_14: 'City',
    alpha_15: 'State', listpicker_1: 'Problem Reported', listpicker_2: 'Service Performed',
    numeric_4: 'Card Amount', multiline_1: 'Internal Notes', alpha_1: 'Job Number', formattedinput_1: 'Phone',
    alpha_16: 'Pickup Coordinates', alpha_17: 'Dropoff Coordinates',
  };
  for (const [key, name] of Object.entries(expected)) assert.equal(form.fields[key].name, name, key);
});

// A field the form marks Required has to be filled by someone. These are filled by the device or the
// driver, never by a dispatch; anything required that is neither sent nor listed here fails the test.
const FILLED_ON_THE_DEVICE = {
  // Hidden, and filled by the form's own rule from the driver's GPS fields (location_1).
  alpha_16: (field) => field.hidden === true && /\$location_1/.test(field.rule || ''),
  signature_1: (field) => field.type === 'Signature',
  datepicker_1: (field) => field.type === 'Date',
};

test('form keys: every field the form requires is sent by the dispatch or filled on the driver\'s device', () => {
  const required = Object.keys(form.fields).filter((key) => form.fields[key].required);
  assert.ok(required.length > 0);
  const sent = dispatchFields({ pickup_coords: '38.7, -121.3' });
  const unaccounted = required.filter((key) => !(key in sent) && !(key in FILLED_ON_THE_DEVICE));
  assert.deepEqual(unaccounted, [], 'required by the form but neither sent nor filled on the device');
  for (const key of required.filter((k) => !(k in sent))) {
    assert.ok(FILLED_ON_THE_DEVICE[key](form.fields[key]), key + ' is listed as device-filled but the form no longer says so');
  }
});

test('form keys: the coordinates a record carries go to the hidden Pickup / Dropoff Coordinates fields', () => {
  const f = dispatchFields({ pickup_coords: ' 38.700000, -121.300000 ', dropoff_coords: { lat: 38.5, lng: -121.4 } });
  assert.equal(f.alpha_16, '38.700000, -121.300000');
  assert.equal(f.alpha_17, '38.500000, -121.400000');
  const none = dispatchFields({});
  assert.ok(!('alpha_16' in none) && !('alpha_17' in none), 'no coordinates, no keys');
  const bad = dispatchFields({ pickup_coords: { lat: 'x', lng: 1 }, dropoff_coords: 7 });
  assert.ok(!('alpha_16' in bad) && !('alpha_17' in bad));
});

test('form keys: Problem Reported is always one of the form\'s five choices', () => {
  const choices = form.lists.listpicker_1;
  for (const call of [{}, { vehicle_condition: 'Collision' }, { vehicle_condition: 'Flat Tire' },
    { vehicle_condition: 'No Keys' }, { service_requested: 'Winch Out + Tow' }]) {
    assert.ok(choices.includes(dispatchFields(call).listpicker_1), JSON.stringify(call));
  }
});

test('form keys: every service the app offers goes as a value on the form\'s Service Performed list', () => {
  const appServices = [...vm.runInContext('ENUMS', makeContext().ctx).Service_Requested];
  assert.ok(appServices.includes('Flatbed / Specialty'), 'the app still offers it');
  const list = form.lists.listpicker_2;
  const notOnTheList = appServices.filter((s) => !list.includes(dispatchFields({ service_requested: s }).listpicker_2));
  assert.deepEqual(notOnTheList, []);
  assert.equal(dispatchFields({ service_requested: 'Flatbed / Specialty' }).listpicker_2, 'Standard Tow');
  assert.equal(dispatchFields({ service_requested: 'Winch Out + Tow' }).listpicker_2, 'Winch Out + Tow', 'listed values are untouched');
});

test('form keys: a year and ZIPs moved to other fields via the FASTFIELD_*_FIELD properties are still sent as text', () => {
  const f = dispatchFields({}, { FASTFIELD_YEAR_FIELD: 'alpha_3' });
  assert.ok(!('numeric_1' in f));
  assert.equal(f.alpha_3, '2022');
});
