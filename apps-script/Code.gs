/**
 * OptiTow — Phase 1 middleware (Google Apps Script Web App).
 *
 * One `doPost(e)` endpoint, routed by the `source` query parameter:
 *
 *   (none) / ?source=app   iOS dispatcher app sync        token in JSON body   (API_SECRET)
 *   ?source=website        Website form submission       token in body/query  (WEBSITE_SECRET)
 *   ?source=callrail       CallRail post-call webhook    token in query       (API_SECRET)
 *   ?source=ai             Mac Mini AI worker            token in JSON body   (API_SECRET)
 *   ?source=fastfield      FastField return webhook      token in query       (API_SECRET)
 *   ?source=location       Customer location sharing     request_location / check_location use
 *                          (app) and a public landing    the API_SECRET; submit_location (from
 *                          page (customer's phone)       the landing page) is public but only
 *                                                        accepted for a token the app registered
 *
 * `doGet` answers a health check, or, with `?loc=<token>`, serves the customer's landing page.
 *
 * Apps Script cannot read request headers or set HTTP status codes, so auth is a
 * pre-shared token in the payload/query and every response is HTTP 200 with a JSON
 * body: { ok: true, ... } or { ok: false, code, error }. Clients must check `ok`.
 *
 * Column ownership (a source only ever writes its own columns):
 *   App / website  -> columns 1-21 (Call_ID … Notes_Comments, incl. computed Loaded_Miles /
 *                     Deadhead_Est_Miles); website leads also set Lead_Source = "Website Form"
 *   CallRail       -> Lead_Source (only if blank), Search_Keyword, Campaign_Name,
 *                     Call_Duration_Sec, Call_Recording_URL
 *   AI worker      -> Caller_Tone, Mentioned_Damage, AI_Processed_At, Call_Intent, Admin_Summary
 *                     (status checks and admin inquiries), and Lead_Source only if still blank
 *                     after CallRail
 *   FastField      -> FastField_Task_ID (written by the app sync when a won call is dispatched),
 *                     Receipt_PDF_URL (written by the return webhook when the form is completed)
 */

const CONFIG = Object.freeze({
  CALL_LOG_SHEET: 'Call Log',
  REFERENCE_SHEET: 'Reference Data',
  TIMEZONE: 'America/Los_Angeles',
  DATE_TIME_FORMAT: 'yyyy-mm-dd hh:mm:ss',
  MERGE_WINDOW_MS: 60 * 60 * 1000,
  YARD_ADDRESS: 'Rio Linda, CA',
  LOCK_WAIT_MS: 20000,
  MAPS_CACHE_SECONDS: 6 * 60 * 60,
  AI_PENDING_DEFAULT_LIMIT: 25,
  // Calls with less talk time than this are treated as dropped/unanswered, not as conversations.
  // Keep equal to MIN_LIVE_CALL_SEC in worker/guards.py (a contract test enforces it).
  MIN_LIVE_CALL_SEC: 15,
  ROW_GROWTH: 500,
  // How long a customer's shared location stays readable (and how long a link stays valid).
  LOCATION_TTL_SECONDS: 15 * 60,
  // FastField's v3 API. The one place these addresses live. (v1 does not exist; the gateway answers 404.)
  FASTFIELD_DISPATCH_URL: 'https://api.fastfieldforms.com/services/v3/dispatches',
  FASTFIELD_FORMS_URL: 'https://api.fastfieldforms.com/services/v3/forms',
  FASTFIELD_LOCK_WAIT_MS: 30000,
  // Phase 3 of a dispatch only stamps one cell, so it waits briefly.
  FASTFIELD_STAMP_LOCK_WAIT_MS: 5000,
  // How long a dispatch counts as in flight if its request never finishes.
  FASTFIELD_INFLIGHT_SECONDS: 120,
  // The webhook's phone fallback only considers calls logged this recently.
  FASTFIELD_PHONE_WINDOW_MS: 24 * 60 * 60 * 1000,
});

// Location-sharing link tokens: lowercase letters and digits only, so one can be placed in a URL
// or in page code without escaping.
const LOCATION_TOKEN_RE = /^[a-z0-9]{8,32}$/;

// 33 columns. Columns 1-21 are the dispatcher block (app/website writes, plus the computed miles);
// 22-31 are automated ingestion (CallRail, then the AI worker) and 32-33 are the FastField receipt
// pipeline, so a dispatcher write can never land on an automated column. Lookups are by header name, never by position.
const HEADERS = Object.freeze([
  'Call_ID', 'Date_Time', 'Customer_Phone', 'Caller_Type', 'Payer_Name',
  'Service_Requested', 'Vehicle_Year', 'Vehicle_Make', 'Vehicle_Model', 'Drivetrain',
  'Vehicle_Condition', 'Scene_Location', 'Start_Location', 'Pickup_Address', 'Dropoff_Address',
  'Loaded_Miles', 'Deadhead_Est_Miles', 'Quoted_Price', 'Outcome', 'Decline_Reason',
  'Notes_Comments',
  'Lead_Source', 'Search_Keyword', 'Campaign_Name', 'Call_Duration_Sec', 'Call_Recording_URL',
  'Caller_Tone', 'Mentioned_Damage', 'AI_Processed_At',
  'Call_Intent', 'Admin_Summary',
  'FastField_Task_ID', 'Receipt_PDF_URL',
]);

// Columns added after the first release. A sheet that predates them gets them appended to its header
// row automatically (see getCallLog_), so deploying new code never breaks an existing sheet.
const AUTO_ADDED_HEADERS = Object.freeze(['Call_Intent', 'Admin_Summary', 'FastField_Task_ID', 'Receipt_PDF_URL']);

// JSON key (SCHEMA.md) -> sheet header. These are the dispatcher-owned columns.
// Lead_Source is automated (CallRail, then AI fallback) and is deliberately absent here.
// Urgency_Level was retired from the sheet entirely.
const APP_FIELDS = Object.freeze({
  call_id: 'Call_ID',
  date_time: 'Date_Time',
  customer_phone: 'Customer_Phone',
  caller_type: 'Caller_Type',
  payer_name: 'Payer_Name',
  service_requested: 'Service_Requested',
  vehicle_year: 'Vehicle_Year',
  vehicle_make: 'Vehicle_Make',
  vehicle_model: 'Vehicle_Model',
  drivetrain: 'Drivetrain',
  vehicle_condition: 'Vehicle_Condition',
  scene_location: 'Scene_Location',
  start_location: 'Start_Location',
  pickup_address: 'Pickup_Address',
  dropoff_address: 'Dropoff_Address',
  quoted_price: 'Quoted_Price',
  outcome: 'Outcome',
  decline_reason: 'Decline_Reason',
  notes_comments: 'Notes_Comments',
});

// Columns holding timestamps: whole seconds, shown as yyyy-mm-dd hh:mm:ss.
const DATE_HEADERS = Object.freeze(['Date_Time', 'AI_Processed_At']);

const CALLRAIL_COLUMNS = Object.freeze([
  'Search_Keyword', 'Campaign_Name', 'Call_Duration_Sec', 'Call_Recording_URL',
]);

const OUTCOME_WON = '1 - Won / Booked';
const DECLINE_NA_WON = 'N/A - Won';
// Written to Caller_Tone and Mentioned_Damage for calls with no genuine two-way conversation.
const NOT_APPLICABLE = 'N/A';
const LEAD_SOURCE_WEBSITE = 'Website Form';

// Allowed values (APP_SPEC.md §5–6). Also written to the Reference Data tab by setup().
// Lead_Source is not an app chip; it stays here as the picklist CallRail attribution and the AI
// worker must map into.
const ENUMS = Object.freeze({
  Caller_Type: ['Private Cash', 'Insurance / Motor Club', 'Commercial Fleet', 'Body Shop'],
  Payer_Name: ['Cash / Customer', 'Triple A (AAA)', 'Agero', 'Geico', 'Allstate', 'State Farm', 'Swoop', 'Urgently', 'Other'],
  Lead_Source: ['Google Ads', 'Google Maps / Organic', 'Repeat / Direct', 'Motor Club Referral', LEAD_SOURCE_WEBSITE, 'Other'],
  Service_Requested: ['Standard Tow', 'Flatbed / Specialty', 'Jump Start', 'Tire Change', 'Tire Patch', 'Lockout', 'Winch Out Only', 'Winch Out + Tow'],
  Drivetrain: ['FWD', 'RWD', 'AWD / 4WD', 'Electric Vehicle (EV)', 'Hybrid', 'Unknown'],
  Vehicle_Condition: ['Rolling / Neutral', 'Locked in Park', 'No Keys', 'Flat Tire', 'Ditch / Mud / Winch', 'Collision', 'Wheel Damaged', 'Mechanical / Electrical Issue'],
  Scene_Location: ['Residential Driveway', 'Public Surface Street', 'Highway / Freeway Shoulder', 'Underground Parking Structure', 'Commercial Lot'],
  Outcome: [OUTCOME_WON, '0 - Lost / Declined'],
  Caller_Tone: ['Calm', 'Stressed', 'Frustrated', 'Angry', 'Confused', 'Rushed', 'Price Shopping', 'Cooperative', NOT_APPLICABLE],
  // What a call was about. Only NEW_LEAD is a sales opportunity. Blank = not classified (including
  // calls that were never a conversation).
  Call_Intent: ['NEW_LEAD', 'STATUS_CHECK', 'ADMIN_INQUIRY'],
  Decline_Reason: ['Price Too High', 'ETA Too Long', 'Already Found Help', 'Changed Mind', DECLINE_NA_WON],
});

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doPost(e) {
  try {
    const request = parseRequest_(e);
    // The customer's phone has no secret. Its one call is accepted only for a link token the app
    // registered with an authenticated request, and can do nothing but store a location for it.
    if (!isPublicLocationSubmit_(request)) authorize_(request.source, request.token);

    let result;
    switch (request.source) {
      case 'app':
        result = handleDispatch_(request.body, 'app');
        break;
      case 'website':
        result = handleDispatch_(request.body, 'website');
        break;
      case 'callrail':
        result = handleCallRail_(request.body);
        break;
      case 'ai':
        result = handleAi_(request.body);
        break;
      case 'location':
        result = handleLocation_(request.body);
        break;
      case 'fastfield':
        result = handleFastFieldWebhook_(request.body);
        break;
      default:
        throw new ApiError('BAD_REQUEST', 'Unknown source "' + request.source + '".');
    }
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    if (err instanceof ApiError) {
      return json_({ ok: false, code: err.code, error: err.message });
    }
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: 'INTERNAL', error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Unauthenticated: a health check so a deployment can be verified from a browser, or, with
 * `?loc=<token>`, the page a customer opens from a text message to share their location.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.loc !== undefined) return locationPage_(String(params.loc));
  return json_({ ok: true, service: 'optitow-middleware' });
}

// ---------------------------------------------------------------------------
// Customer location sharing
//
// Flow: the app picks a random link token and registers it (request_location). It texts the
// customer a link to this web app (?loc=<token>). The customer's phone shows a page, asks the
// browser for its position and sends it back (submit_location). The app polls (check_location)
// until the position arrives. Everything lives in the script cache for LOCATION_TTL_SECONDS, so
// nothing about the customer is written to the sheet or kept afterwards.
// ---------------------------------------------------------------------------

function isPublicLocationSubmit_(request) {
  return request.source === 'location' && request.body && request.body.action === 'submit_location';
}

function locationKey_(token) {
  return 'loc_' + token;
}

function requireLocationToken_(body) {
  const token = body.loc == null ? '' : String(body.loc).trim();
  if (!LOCATION_TOKEN_RE.test(token)) {
    throw new ApiError('BAD_REQUEST', 'loc must be 8-32 lowercase letters or digits.');
  }
  return token;
}

function handleLocation_(body) {
  switch (body.action) {
    case 'request_location':
      return requestLocation_(body);
    case 'check_location':
      return checkLocation_(body);
    case 'submit_location':
      return submitLocation_(body);
    default:
      throw new ApiError('BAD_REQUEST', 'Unknown location action "' + body.action + '".');
  }
}

/** App: register a link token so the customer's page has something to answer. */
function requestLocation_(body) {
  const token = requireLocationToken_(body);
  CacheService.getScriptCache().put(
    locationKey_(token), JSON.stringify({ status: 'pending' }), CONFIG.LOCATION_TTL_SECONDS);
  return { status: 'pending' };
}

/** App: has the customer shared yet? An unknown or expired token reads as pending. */
function checkLocation_(body) {
  const token = requireLocationToken_(body);
  const entry = readLocation_(token);
  if (!entry || entry.status !== 'ready') return { status: 'pending' };
  return { status: 'ready', address: entry.address, lat: entry.lat, lng: entry.lng };
}

/** Customer: store the position for a registered token. The first position wins. */
function submitLocation_(body) {
  const token = requireLocationToken_(body);
  const lat = parseCoordinate_(body.lat, 90, 'lat');
  const lng = parseCoordinate_(body.lng, 180, 'lng');

  const entry = readLocation_(token);
  if (!entry) {
    throw new ApiError('NOT_FOUND', 'This link has expired. Ask the dispatcher for a new one.');
  }
  if (entry.status === 'ready') return { already: true };

  CacheService.getScriptCache().put(
    locationKey_(token),
    JSON.stringify({ status: 'ready', address: reverseGeocode_(lat, lng), lat: lat, lng: lng }),
    CONFIG.LOCATION_TTL_SECONDS);
  // Deliberately returns nothing about the position: this endpoint is public.
  return {};
}

function readLocation_(token) {
  const raw = CacheService.getScriptCache().get(locationKey_(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function parseCoordinate_(value, limit, name) {
  const text = value == null ? '' : String(value).trim();
  const n = text === '' ? NaN : Number(text);
  if (!isFinite(n) || Math.abs(n) > limit) {
    throw new ApiError('BAD_REQUEST', name + ' must be a number between -' + limit + ' and ' + limit + '.');
  }
  return n;
}

/** A street address for the position, or '' if Maps has none (the app then shows the coordinates). */
function reverseGeocode_(lat, lng) {
  try {
    const reply = Maps.newGeocoder().reverseGeocode(lat, lng);
    const first = reply && reply.status === 'OK' && reply.results && reply.results[0];
    return first && first.formatted_address ? String(first.formatted_address).replace(/,\s*USA$/, '') : '';
  } catch (err) {
    console.warn('Reverse geocode failed: ' + err);
    return '';
  }
}

/** Embeds a value in page script: JSON, with anything that could end the script block escaped. */
function jsLiteral_(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function locationPage_(token) {
  const valid = LOCATION_TOKEN_RE.test(token);
  const html = valid
    ? LOCATION_PAGE_HTML.replace('__CONFIG__', jsLiteral_({
        token: token,
        endpoint: ScriptApp.getService().getUrl(),
      }))
    : LOCATION_INVALID_HTML;
  return HtmlService.createHtmlOutput(html)
    .setTitle('Recovery Towing')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

const LOCATION_INVALID_HTML =
  '<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;padding:32px;text-align:center">' +
  '<h2>Recovery Towing</h2><p>This link is not valid. Please ask your dispatcher to send a new one.</p></body>';

const LOCATION_PAGE_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Recovery Towing</title>',
  '<style>',
  ':root{color-scheme:light dark;--bg:#e8eaee;--card:#fff;--text:#111;--sub:#555;--btn:#ffcc00;--btn-text:#000}',
  '@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#fff;--sub:#a1a1a6}}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;',
  'background:var(--bg);color:var(--text);font:17px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
  '.card{width:100%;max-width:420px;background:var(--card);border-radius:20px;padding:32px 24px;text-align:center;',
  'box-shadow:0 6px 24px rgba(0,0,0,.08)}',
  'h1{font-size:15px;letter-spacing:.09em;text-transform:uppercase;color:var(--sub);margin:0 0 20px;font-weight:600}',
  'p{margin:0 0 24px}',
  '.lead{font-size:22px;font-weight:700;line-height:1.25}',
  'button{width:100%;min-height:56px;border:0;border-radius:16px;background:var(--btn);color:var(--btn-text);',
  'font:700 18px -apple-system,sans-serif;cursor:pointer}',
  'button:disabled{opacity:.55}',
  '.fine{font-size:13px;color:var(--sub);margin:16px 0 0}',
  '.ok{color:#0a7d33}.err{color:#c0392b}',
  '</style></head><body><main class="card" id="card">',
  '<h1>Recovery Towing</h1>',
  '<p class="lead" id="msg">Tap below so your driver can find your exact spot.</p>',
  '<button id="go" type="button">Share My Exact Location</button>',
  '<p class="fine" id="fine">Your location is used only to find you for this tow.</p>',
  '</main><script>',
  'var CFG = __CONFIG__;',
  'var msg = document.getElementById("msg"), go = document.getElementById("go"), fine = document.getElementById("fine");',
  'var FAIL = "Unable to detect location. Please tell your dispatcher your nearest cross street.";',
  'function done(text, cls){ msg.textContent = text; msg.className = "lead " + (cls || ""); go.style.display = "none"; fine.style.display = "none"; }',
  'function retry(text){ msg.textContent = text; msg.className = "lead err"; go.disabled = false; go.textContent = "Try Again"; }',
  'function send(pos){',
  '  var body = new URLSearchParams({ action: "submit_location", loc: CFG.token, lat: String(pos.coords.latitude), lng: String(pos.coords.longitude) });',
  '  fetch(CFG.endpoint + "?source=location", { method: "POST", body: body })',
  '    .then(function(r){ return r.json(); })',
  '    .then(function(j){',
  '      if (j && j.ok) done("Location received! Our driver has your exact spot.", "ok");',
  '      else if (j && j.code === "NOT_FOUND") done("This link has expired. Please ask your dispatcher to send a new one.", "err");',
  '      else done(FAIL, "err");',
  '    })',
  '    .catch(function(){ done(FAIL, "err"); });',
  '}',
  'go.addEventListener("click", function(){',
  '  if (!navigator.geolocation) { done(FAIL, "err"); return; }',
  '  go.disabled = true; go.textContent = "Finding you\u2026";',
  '  navigator.geolocation.getCurrentPosition(send, function(){ retry(FAIL); },',
  '    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });',
  '});',
  '</script></body></html>',
].join('\n');

// ---------------------------------------------------------------------------
// Request parsing & auth
// ---------------------------------------------------------------------------

function parseRequest_(e) {
  const params = (e && e.parameter) || {};
  const raw = e && e.postData ? e.postData.contents : '';

  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch (_) {
      body = null;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    // Form-encoded posts (HTML forms, legacy CallRail webhooks) arrive via e.parameter.
    body = Object.assign({}, params);
  } else {
    body = Object.assign({}, body);
  }

  const token = body.token != null && body.token !== '' ? body.token : params.token;
  delete body.token;
  if (body.source === params.source) delete body.source;

  return {
    source: String(params.source || 'app').trim().toLowerCase(),
    token: token == null ? '' : String(token),
    body: body,
  };
}

/**
 * A Script Property cleaned of what a paste leaves behind: surrounding whitespace, newlines and tabs,
 * and surrounding quote characters. '' when it is unset or blank. Used for every secret and id the
 * script reads, so an invisible stray character cannot make a correct value fail.
 */
function sanitizeProperty_(value) {
  let s = String(value === undefined || value === null ? '' : value).trim();
  while (/^["']|["']$/.test(s)) s = s.replace(/^["']+|["']+$/g, '').trim();
  return s;
}

function getScriptProperty_(name) {
  return sanitizeProperty_(PropertiesService.getScriptProperties().getProperty(name));
}

function authorize_(source, token) {
  // The website token ships in public page code, so it gets its own secret that can
  // only create website leads — never the API_SECRET used by the app, CallRail and AI.
  const propName = source === 'website' ? 'WEBSITE_SECRET' : 'API_SECRET';
  const expected = getScriptProperty_(propName);
  if (!expected) {
    throw new ApiError('SERVER_MISCONFIGURED', propName + ' is not set in Script Properties.');
  }
  if (!token || !safeEqual_(token, expected)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid token.');
  }
}

function safeEqual_(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// App & website: upsert by call_id, otherwise claim a CallRail/website orphan row
// ---------------------------------------------------------------------------

function handleDispatch_(body, origin) {
  const warnings = [];
  const record = normalizeDispatchRecord_(body, origin, warnings);
  // Maps lookups are slow, so do them before taking the lock.
  const miles = computeMiles_(record, warnings);
  const updates = Object.assign({}, record, miles);

  // Phase 1, under the lock: write the row. FastField_Task_ID stays blank for now.
  const saved = withLock_(function () {
    const log = getCallLog_();
    const index = readIndex_(log);

    let action;
    let rowNum = findByCallId_(index, record.Call_ID);
    if (rowNum) {
      action = 'updated';
    } else {
      // A row with no Outcome hasn't been claimed by a dispatcher yet (CallRail- or
      // website-created). Fill it in instead of creating a duplicate.
      const outcomeCol = log.col.Outcome;
      const match = findMergeCandidate_(log, index, phoneKey_(record.Customer_Phone), record.Date_Time,
        function (row) { return isBlank_(row[outcomeCol]); });
      if (match) {
        rowNum = match.rowNum;
        action = 'merged';
      }
    }

    // A won call becomes a FastField task for the driver, once. A row that already has a task id is
    // never dispatched again (the app re-syncs a call), and so is one whose dispatch is in flight
    // from another request. A failed dispatch leaves the id blank so the next sync retries it.
    const existingTask = rowNum
      ? String(log.sheet.getRange(rowNum, log.col.FastField_Task_ID + 1).getValue()).trim()
      : '';
    const wantsDispatch = origin === 'app' && !existingTask && isWon_(record.Outcome) &&
      claimDispatch_(record.Call_ID);
    if (!rowNum) {
      updates.FastField_Task_ID = '';
      updates.Receipt_PDF_URL = '';
    }

    if (rowNum) {
      writeCells_(log, rowNum, updates);
    } else {
      rowNum = appendRecord_(log, updates);
      action = 'created';
    }
    return { action: action, call_id: record.Call_ID, row: rowNum, dispatch: wantsDispatch };
  });

  // Phase 2, no lock: the FastField request. A slow or hung FastField can no longer hold up
  // CallRail webhooks, the AI worker or location polling.
  if (saved.dispatch) {
    try {
      const taskId = dispatchToFastField_(callDataFromRecord_(record));
      // Phase 3, a brief lock: stamp only the task id on the row.
      if (taskId && !stampFastFieldTask_(record.Call_ID, taskId)) {
        warnings.push('FastField task ' + taskId + ' was created but could not be saved to the row.');
      }
    } finally {
      releaseDispatch_(record.Call_ID);
    }
  }

  return { action: saved.action, call_id: saved.call_id, row: saved.row, warnings: warnings };
}

function normalizeDispatchRecord_(body, origin, warnings) {
  const rec = {};
  Object.keys(APP_FIELDS).forEach(function (key) {
    const value = cleanValue_(body[key]);
    if (value !== '') rec[APP_FIELDS[key]] = value;
  });

  if (origin === 'website') {
    if (!rec.Customer_Phone && cleanValue_(body.phone) !== '') rec.Customer_Phone = cleanValue_(body.phone);
    rec.Lead_Source = LEAD_SOURCE_WEBSITE;
    // Keep anything else the form sent (name, email, message…) in the notes.
    const extras = Object.keys(body)
      .filter(function (k) { return !(k in APP_FIELDS) && k !== 'phone' && k !== 'source'; })
      .map(function (k) { return [k, cleanValue_(body[k])]; })
      .filter(function (kv) { return kv[1] !== '' && typeof kv[1] !== 'object'; })
      .map(function (kv) { return kv[0] + ': ' + kv[1]; });
    if (extras.length) {
      rec.Notes_Comments = [rec.Notes_Comments].concat(extras).filter(Boolean).join(' | ');
    }
  }

  if (!rec.Call_ID) {
    if (origin === 'app') throw new ApiError('BAD_REQUEST', 'call_id is required.');
    rec.Call_ID = Utilities.getUuid();
  }
  rec.Call_ID = String(rec.Call_ID);

  // The phone number is the key for every CallRail merge, so a dispatcher call without a usable
  // one would silently fail to merge and duplicate the call. Formatting is ignored when counting.
  if (origin === 'app' && String(rec.Customer_Phone === undefined ? '' : rec.Customer_Phone).replace(/\D/g, '').length < 10) {
    throw new ApiError('BAD_REQUEST', 'customer_phone is required and must be at least 10 digits.');
  }

  if (rec.Date_Time !== undefined) {
    const parsed = parseDate_(rec.Date_Time);
    if (!parsed) warnings.push('Unparseable date_time "' + rec.Date_Time + '"; used server time.');
    rec.Date_Time = parsed;
  }
  if (!rec.Date_Time) rec.Date_Time = new Date();

  if (rec.Customer_Phone !== undefined) rec.Customer_Phone = formatPhone_(rec.Customer_Phone);

  if (rec.Quoted_Price !== undefined) {
    const price = toNumber_(rec.Quoted_Price);
    if (price === null) {
      warnings.push('Ignored non-numeric quoted_price "' + rec.Quoted_Price + '".');
      delete rec.Quoted_Price;
    } else {
      rec.Quoted_Price = price;
    }
  }

  if (rec.Vehicle_Year !== undefined && /^\d{4}$/.test(String(rec.Vehicle_Year))) {
    rec.Vehicle_Year = Number(rec.Vehicle_Year);
  }

  if (rec.Outcome === OUTCOME_WON) rec.Decline_Reason = DECLINE_NA_WON;

  // Unknown chip values are stored as sent (never drop dispatcher data) but flagged.
  Object.keys(ENUMS).forEach(function (header) {
    if (rec[header] !== undefined && ENUMS[header].indexOf(rec[header]) === -1) {
      warnings.push('Unrecognized ' + header + ' value "' + rec[header] + '".');
    }
  });

  return rec;
}

function computeMiles_(rec, warnings) {
  const out = {};
  if (!rec.Pickup_Address) return out;

  const deadhead = drivingMiles_(CONFIG.YARD_ADDRESS, rec.Pickup_Address);
  if (deadhead === null) warnings.push('Could not route yard -> pickup for Deadhead_Est_Miles.');
  else out.Deadhead_Est_Miles = deadhead;

  if (rec.Dropoff_Address) {
    const loaded = drivingMiles_(rec.Pickup_Address, rec.Dropoff_Address);
    if (loaded === null) warnings.push('Could not route pickup -> dropoff for Loaded_Miles.');
    else out.Loaded_Miles = loaded;
  }
  return out;
}

function drivingMiles_(origin, destination) {
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
    String(origin).toLowerCase() + '|' + String(destination).toLowerCase());
  const key = 'mi:' + Utilities.base64EncodeWebSafe(digest);

  const hit = cache.get(key);
  if (hit !== null) return Number(hit);

  try {
    const directions = Maps.newDirectionFinder()
      .setOrigin(origin)
      .setDestination(destination)
      .setRegion('us')
      .setMode(Maps.DirectionFinder.Mode.DRIVING)
      .getDirections();
    const leg = directions && directions.routes && directions.routes[0] &&
      directions.routes[0].legs && directions.routes[0].legs[0];
    if (!leg || !leg.distance) return null;
    const miles = Math.round((leg.distance.value / 1609.344) * 10) / 10;
    cache.put(key, String(miles), CONFIG.MAPS_CACHE_SECONDS);
    return miles;
  } catch (err) {
    console.warn('Maps routing failed (' + origin + ' -> ' + destination + '): ' + err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CallRail: merge into a recent same-phone row, otherwise create a new row
// ---------------------------------------------------------------------------

function handleCallRail_(body) {
  const warnings = [];
  const call = normalizeCallRail_(body);
  if (!call.phoneKey) warnings.push('No usable customer phone in webhook; created a standalone row.');
  if (!Object.keys(call.fields).length) throw new ApiError('BAD_REQUEST', 'Webhook carried no CallRail data.');
  // An absent keyword is expected for many sources; just record what arrived so gaps can be audited.
  console.log('CallRail webhook ' + JSON.stringify(call.diagnostics));

  return withLock_(function () {
    const log = getCallLog_();
    let action;

    // CallRail retries webhooks, so the recording URL acts as its idempotency key.
    let rowNum = call.fields.Call_Recording_URL
      ? findByColumnValue_(log, 'Call_Recording_URL', call.fields.Call_Recording_URL)
      : 0;
    if (rowNum) {
      action = 'updated';
    } else {
      // Only rows that don't already carry another call's CallRail data are eligible.
      const crCols = CALLRAIL_COLUMNS.map(function (h) { return log.col[h]; });
      const match = findMergeCandidate_(log, readIndex_(log), call.phoneKey, call.time,
        function (row) { return crCols.every(function (c) { return isBlank_(row[c]); }); });
      if (match) {
        rowNum = match.rowNum;
        action = 'merged';
      }
    }

    let callId;
    let aiSkipped = '';
    if (rowNum) {
      const current = log.sheet.getRange(rowNum, 1, 1, log.width).getValues()[0];
      // Never overwrite an existing Lead_Source (e.g. a website lead that then phoned in).
      const updates = Object.assign({}, call.fields);
      if (call.leadSource && isBlank_(current[log.col.Lead_Source])) updates.Lead_Source = call.leadSource;
      if (call.notLiveReason) {
        // A dispatcher outcome proves a real conversation happened, whatever CallRail says, and an
        // already-processed row is left alone.
        if (!isBlank_(current[log.col.Outcome]) || !isBlank_(current[log.col.AI_Processed_At])) {
          console.log('CallRail not-live verdict ignored: row already has a dispatcher outcome or AI result');
        } else {
          Object.assign(updates, notApplicableCells_(log, current));
          aiSkipped = call.notLiveReason;
        }
      }
      writeCells_(log, rowNum, updates);
      callId = String(current[log.col.Call_ID]);
    } else {
      // Dispatcher columns stay blank; only identity + CallRail data are written.
      callId = Utilities.getUuid();
      const record = Object.assign({
        Call_ID: callId,
        Date_Time: call.time,
        Customer_Phone: call.phone,
      }, call.leadSource ? { Lead_Source: call.leadSource } : {}, call.fields);
      if (call.notLiveReason) {
        Object.assign(record, notApplicableCells_(log, null));
        aiSkipped = call.notLiveReason;
      }
      rowNum = appendRecord_(log, record);
      action = 'created';
    }

    const result = { action: action, call_id: callId, row: rowNum, warnings: warnings };
    if (aiSkipped) result.ai_skipped = aiSkipped;
    return result;
  });
}

function normalizeCallRail_(body) {
  // v3 webhooks post the call object flat; tolerate a wrapper and legacy form-encoded names.
  const c = (body.resource && typeof body.resource === 'object') ? body.resource
    : (body.call && typeof body.call === 'object') ? body.call
    : body;

  const pick = function () {
    for (let i = 0; i < arguments.length; i++) {
      const v = cleanValue_(c[arguments[i]]);
      if (v !== '') return v;
    }
    return '';
  };

  const rawPhone = pick('customer_phone_number', 'formatted_customer_phone_number', 'caller_number', 'callernum');
  const time = parseDate_(pick('start_time', 'created_at', 'datetime')) || new Date();

  const fields = {};
  const keyword = extractKeyword_(c);
  if (keyword.value !== '') fields.Search_Keyword = keyword.value;
  const campaign = pick('campaign', 'utm_campaign');
  if (campaign !== '') fields.Campaign_Name = campaign;
  const duration = toNumber_(pick('duration'));
  if (duration !== null) fields.Call_Duration_Sec = duration;
  const recording = pick('recording', 'recording_url', 'recording_player');
  if (recording !== '') fields.Call_Recording_URL = recording;

  // CallRail has no talk-time field and `duration` can include ringing, so the best estimate of
  // real talk time is the recording's length, falling back to `duration`.
  const answered = toBool_(pick('answered'));
  const voicemail = toBool_(pick('voicemail'));
  const recordingSec = toNumber_(pick('recording_duration'));
  const talkSec = recordingSec !== null ? recordingSec : duration;
  const notLiveReason = notLiveReason_(answered, voicemail, talkSec);

  return {
    phone: rawPhone === '' ? '' : formatPhone_(rawPhone),
    phoneKey: phoneKey_(rawPhone),
    time: time,
    fields: fields,
    // Kept apart from `fields`: it is attribution, not call data, and is only filled if blank.
    // Only `source` is the marketing source; CallRail's `source_name` is the tracking number's
    // label, so it must not feed attribution.
    leadSource: mapLeadSource_(pick('source'), pick('medium', 'utm_medium')),
    // Why this is not a live conversation ('' if it is), so AI analysis can be skipped entirely.
    notLiveReason: notLiveReason,
    // What arrived, for the Executions log. Names and low-cardinality attribution only: no phone
    // number and no keyword text.
    diagnostics: {
      keyword_from: keyword.key || 'none',
      source: String(pick('source')).slice(0, 60),
      medium: String(pick('medium', 'utm_medium')).slice(0, 60),
      has_campaign: campaign !== '',
      answered: answered,
      voicemail: voicemail,
      talk_sec: talkSec,
      not_live: notLiveReason || 'no',
      payload_keys: Object.keys(c).sort().join(','),
    },
  };
}

/**
 * Why a CallRail call is not a live conversation, or '' if it is (or if we can't tell).
 *   - `answered: false` means no one picked up (carrier message, ringing out). The exception is a
 *     voicemail: CallRail may report those as unanswered even though the customer left a real
 *     message, so they are judged by length and then by the transcript in the AI worker.
 *   - Less than MIN_LIVE_CALL_SEC of talk time is a dropped call, whatever else CallRail says.
 */
function notLiveReason_(answered, voicemail, talkSec) {
  if (answered === false && voicemail !== true) return 'not_answered';
  if (talkSec !== null && talkSec < CONFIG.MIN_LIVE_CALL_SEC) return 'too_short';
  return '';
}

/** true / false / null (unknown) from booleans, "true"/"false", "yes"/"no" and 1/0. */
function toBool_(v) {
  if (v === true || v === false) return v;
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

/**
 * AI cells for a call with no genuine conversation: tone and damage are N/A (distinct from "None",
 * which means a real call where no damage was mentioned) and the row is stamped as processed so it
 * never reaches the worker. Only blank cells are filled, like every other AI write.
 */
function notApplicableCells_(log, currentRow) {
  const cells = { AI_Processed_At: new Date() };
  ['Caller_Tone', 'Mentioned_Damage'].forEach(function (h) {
    if (!currentRow || isBlank_(currentRow[log.col[h]])) cells[h] = NOT_APPLICABLE;
  });
  return cells;
}

// Where the paid-search keyword can live in a CallRail call. `keywords` is the documented field
// (only populated for paid sources on Website/Session trackers); `utm_term` is the landing-page
// parameter; `search_keywords` is an older name. `keywords_spotted` is deliberately absent: it
// lists words detected in the call audio, not what the visitor searched for.
const CALLRAIL_KEYWORD_KEYS = Object.freeze(['keywords', 'utm_term', 'search_keywords']);

/**
 * First usable keyword among CALLRAIL_KEYWORD_KEYS. Accepts a string or an array, and skips empty
 * values and ad-template placeholders that were never filled in (e.g. "{keyword}", "(not set)").
 * Returns {value: '', key: ''} when there is none, which is normal for Google My Business,
 * Performance Max, organic and direct calls.
 */
function extractKeyword_(c) {
  for (let i = 0; i < CALLRAIL_KEYWORD_KEYS.length; i++) {
    const key = CALLRAIL_KEYWORD_KEYS[i];
    const raw = c[key];
    const text = (Array.isArray(raw) ? raw.map(function (k) { return String(cleanValue_(k)); }).filter(Boolean).join(', ')
      : (raw === undefined || raw === null || typeof raw === 'object') ? '' : String(raw)).trim();
    if (text === '' || /^\{.*\}$/.test(text) || /^\(?(not set|not provided|none)\)?$/i.test(text)) continue;
    return { value: text, key: key };
  }
  return { value: '', key: '' };
}

/**
 * CallRail tracking source/medium -> Lead_Source picklist. First match wins, so the order matters
 * ("Motor Club Referral" must be tested before the generic "referral"). Returns '' when CallRail
 * sent no attribution at all, leaving the cell open for the AI fallback.
 */
function mapLeadSource_(source, medium) {
  const text = (String(source || '') + ' ' + String(medium || ''))
    .toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/\b(google ?ads?|adwords|ppc|cpc|google paid)\b/.test(text)) return 'Google Ads';
  if (/\b(google (organic|my business|business profile|maps)|gmb|maps)\b/.test(text)) return 'Google Maps / Organic';
  if (/\b(motor club|auto club)\b/.test(text)) return 'Motor Club Referral';
  if (/\b(direct|organic search|referral)\b/.test(text)) return 'Repeat / Direct';
  if (/\bwebsite form\b/.test(text)) return LEAD_SOURCE_WEBSITE;
  return 'Other';
}

// ---------------------------------------------------------------------------
// AI worker: list pending recordings, write AI columns only
// ---------------------------------------------------------------------------

function handleAi_(body) {
  const action = String(body.action || '').trim().toLowerCase();
  if (action === 'pending') return listPendingAudio_(body);
  if (action === 'update') return applyAiResult_(body);
  throw new ApiError('BAD_REQUEST', 'AI action must be "pending" or "update".');
}

function listPendingAudio_(body) {
  const limit = Math.max(1, Math.min(500, toNumber_(body.limit) || CONFIG.AI_PENDING_DEFAULT_LIMIT));
  const log = getCallLog_();
  const n = log.sheet.getLastRow() - 1;
  const items = [];
  if (n > 0) {
    const c = log.col;
    const rows = log.sheet.getRange(2, 1, n, log.width).getValues();
    for (let i = 0; i < rows.length && items.length < limit; i++) {
      const r = rows[i];
      if (isBlank_(r[c.Call_Recording_URL]) || !isBlank_(r[c.AI_Processed_At])) continue;
      const time = toDate_(r[c.Date_Time]);
      items.push({
        call_id: String(r[c.Call_ID]),
        date_time: time ? time.toISOString().replace(/\.\d{3}Z$/, 'Z') : '',
        customer_phone: String(r[c.Customer_Phone]),
        call_duration_sec: r[c.Call_Duration_Sec] === '' ? null : r[c.Call_Duration_Sec],
        call_recording_url: String(r[c.Call_Recording_URL]),
        // Current values of the AI-fillable cells. Blank means the AI may fill it.
        lead_source: String(r[c.Lead_Source]),
        caller_tone: String(r[c.Caller_Tone]),
        mentioned_damage: String(r[c.Mentioned_Damage]),
        call_intent: String(r[c.Call_Intent]),
      });
    }
  }
  return { action: 'pending', count: items.length, items: items };
}

function applyAiResult_(body) {
  const callId = cleanValue_(body.call_id);
  const recordingUrl = cleanValue_(body.call_recording_url);
  if (callId === '' && recordingUrl === '') {
    throw new ApiError('BAD_REQUEST', 'call_id or call_recording_url is required.');
  }
  const hasContent = body.caller_tone !== undefined || body.mentioned_damage !== undefined ||
    body.lead_source !== undefined || body.call_intent !== undefined || body.admin_summary !== undefined;
  // `mark_processed` lets the worker retire a row whose AI cells were all filled by hand.
  if (!hasContent && body.mark_processed !== true) {
    throw new ApiError('BAD_REQUEST',
      'caller_tone, mentioned_damage, lead_source, call_intent, admin_summary or mark_processed is required.');
  }

  return withLock_(function () {
    const log = getCallLog_();
    // The recording URL is the fallback because an app sync can re-key a CallRail
    // row's call_id between the worker's "pending" fetch and its "update".
    let rowNum = callId !== '' ? findByCallId_(readIndex_(log), String(callId)) : 0;
    if (!rowNum && recordingUrl !== '') rowNum = findByColumnValue_(log, 'Call_Recording_URL', recordingUrl);
    if (!rowNum) throw new ApiError('NOT_FOUND', 'No row matches that call_id / call_recording_url.');

    // Whitelist: nothing else in the body can reach the sheet. Every AI-fillable cell is
    // fill-only-if-blank, so the AI can never overwrite CallRail attribution or anything a
    // person typed. (To re-run a row, clear its AI cells first.)
    const current = log.sheet.getRange(rowNum, 1, 1, log.width).getValues()[0];
    const updates = { AI_Processed_At: new Date() };
    const warnings = [];
    const offer = function (header, value) {
      if (value === '') return;
      if (!isBlank_(current[log.col[header]])) {
        warnings.push('Ignored ' + header + ': already set.');
      } else {
        updates[header] = value;
      }
    };

    if (body.caller_tone !== undefined) {
      const tone = String(cleanValue_(body.caller_tone));
      if (ENUMS.Caller_Tone.indexOf(tone) === -1) {
        warnings.push('Ignored Caller_Tone "' + tone + '": not in the Caller_Tone picklist.');
      } else {
        offer('Caller_Tone', tone);
      }
    }
    if (body.mentioned_damage !== undefined) {
      const damage = Array.isArray(body.mentioned_damage)
        ? body.mentioned_damage.map(function (d) { return String(cleanValue_(d)); }).filter(Boolean).join(', ')
        : String(cleanValue_(body.mentioned_damage));
      offer('Mentioned_Damage', damage.slice(0, 500));
    }
    // What the call was about. A summary is kept only for an operational call (status check or admin
    // inquiry); for a new lead, or with no intent at all, it is ignored.
    if (body.call_intent !== undefined) {
      const intent = String(cleanValue_(body.call_intent));
      if (ENUMS.Call_Intent.indexOf(intent) === -1) {
        warnings.push('Ignored Call_Intent "' + intent + '": not in the Call_Intent picklist.');
      } else {
        offer('Call_Intent', intent);
      }
    }
    if (body.admin_summary !== undefined) {
      const effectiveIntent = String(updates.Call_Intent || current[log.col.Call_Intent] || '');
      if (effectiveIntent === '' || effectiveIntent === 'NEW_LEAD') {
        warnings.push('Ignored Admin_Summary: only for STATUS_CHECK or ADMIN_INQUIRY calls.');
      } else {
        offer('Admin_Summary', String(cleanValue_(body.admin_summary)).slice(0, 300));
      }
    }
    if (body.lead_source !== undefined) {
      const proposed = String(cleanValue_(body.lead_source));
      if (ENUMS.Lead_Source.indexOf(proposed) === -1) {
        warnings.push('Ignored Lead_Source "' + proposed + '": not in the Lead_Source picklist.');
      } else {
        offer('Lead_Source', proposed);
      }
    }

    writeCells_(log, rowNum, updates);
    return {
      action: 'updated',
      call_id: String(log.sheet.getRange(rowNum, log.col.Call_ID + 1).getValue()),
      row: rowNum,
      warnings: warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// FastField Forms: dispatch a won call to the driver's iPad, and take the finished receipt back
//
// Out: a won call is posted to FastField as a task pre-filled with the job (dispatchToFastField_);
//      the task id lands in FastField_Task_ID.
// In:  when the driver submits the Recovery Towing Service Form, FastField calls
//      ?source=fastfield&token=<API_SECRET>; the report's PDF link is saved to Receipt_PDF_URL.
// ---------------------------------------------------------------------------

const FASTFIELD_REQUIRED = Object.freeze(['FASTFIELD_API_KEY', 'FASTFIELD_FORM_ID', 'FASTFIELD_USER_ID']);

/**
 * Marks a call's dispatch as in flight (called with the sheet lock held). A second request for the
 * same call that arrives while the first is still talking to FastField sees the mark and does not
 * dispatch again. The mark expires by itself in case a request dies mid-way.
 */
function claimDispatch_(callId) {
  const cache = CacheService.getScriptCache();
  const key = 'ffd:' + callId;
  if (cache.get(key) !== null) return false;
  cache.put(key, '1', CONFIG.FASTFIELD_INFLIGHT_SECONDS);
  return true;
}

function releaseDispatch_(callId) {
  CacheService.getScriptCache().remove('ffd:' + callId);
}

/**
 * Phase 3: a short lock just long enough to write the task id on the call's row (found again by
 * Call_ID, since rows can move while FastField was answering). Never overwrites an id already there.
 * Returns whether the id was saved; a busy sheet or a vanished row is logged with the id, not thrown,
 * because the call itself is already saved.
 */
function stampFastFieldTask_(callId, taskId) {
  try {
    return withLock_(function () {
      const log = getCallLog_();
      const rowNum = findByCallId_(readIndex_(log), callId);
      if (!rowNum) {
        console.error('FastField task ' + taskId + ' created but call "' + callId + '" is not in the sheet.');
        return false;
      }
      const cell = log.sheet.getRange(rowNum, log.col.FastField_Task_ID + 1);
      if (String(cell.getValue()).trim() === '') writeCells_(log, rowNum, { FastField_Task_ID: taskId });
      return true;
    }, CONFIG.FASTFIELD_STAMP_LOCK_WAIT_MS);
  } catch (err) {
    console.error('FastField task ' + taskId + ' created for call "' + callId + '" but not saved to the sheet: ' + err);
    return false;
  }
}

function isWon_(outcome) {
  return outcome === 1 || String(outcome === undefined || outcome === null ? '' : outcome).trim() === '1' ||
    String(outcome === undefined || outcome === null ? '' : outcome).trim() === OUTCOME_WON;
}

/** The sheet record (header keys) back to the app's snake_case keys. */
function callDataFromRecord_(rec) {
  const out = {};
  Object.keys(APP_FIELDS).forEach(function (key) {
    if (rec[APP_FIELDS[key]] !== undefined) out[key] = rec[APP_FIELDS[key]];
  });
  return out;
}

/** The three FastField settings, or null (with a warning) when any is missing or blank. */
function fastFieldConfig_() {
  const config = {};
  const missing = [];
  FASTFIELD_REQUIRED.forEach(function (name) {
    const value = getScriptProperty_(name);
    if (value) config[name] = value;
    else missing.push(name);
  });
  if (missing.length) {
    console.warn('FastField dispatch skipped: ' + missing.join(', ') + ' not set in Script Properties.');
    return null;
  }
  return config;
}

/**
 * Every header FastField's gateway (Azure API Management) may look for a key in. The gateway
 * answered a Bearer-only request with "missing subscription key", so the key goes in each place a
 * key is commonly read from; the extra headers are harmless where unused.
 */
function getFastFieldHeaders_(apiKey) {
  return {
    'Ocp-Apim-Subscription-Key': apiKey,
    'Authorization': 'Bearer ' + apiKey,
    'x-api-key': apiKey,
    'fastfield-api-key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/**
 * Sends a won call to FastField as a pre-filled task and reports everything about the answer:
 * { code, headers, text, parsed, id, error }. Returns null, after logging why, when nothing was
 * sent (not won, or FastField not configured). Shared by dispatchToFastField_ and the manual
 * testFastFieldDispatch diagnostic.
 */
function sendFastFieldDispatch_(callData) {
  if (!callData || !isWon_(callData.outcome)) return null;
  const config = fastFieldConfig_();
  if (!config) return null;
  const formId = Number(config.FASTFIELD_FORM_ID);
  if (!isFinite(formId)) {
    console.warn('FastField dispatch skipped: FASTFIELD_FORM_ID is not a number.');
    return null;
  }

  const notes = callData.notes_comments === undefined || callData.notes_comments === null
    ? '' : String(callData.notes_comments).trim();
  const quote = callData.quoted_price ? 'Quoted: $' + callData.quoted_price : '';
  const text = function (v) { return v === undefined || v === null ? '' : v; };
  const payload = {
    formId: formId,
    users: [config.FASTFIELD_USER_ID],
    autoCreateUsers: false,
    mergeFields: {
      alpha_1: callData.call_id,
      multiline_1: [notes, quote].filter(Boolean).join(' | '),
      formattedinput_1: text(callData.customer_phone),
      numeric_1: Number(callData.vehicle_year) || null,
      alpha_3: text(callData.vehicle_make),
      alpha_4: text(callData.vehicle_model),
      alpha_9: text(callData.pickup_address),
      alpha_13: text(callData.dropoff_address),
      listpicker_2: text(callData.service_requested),
    },
  };

  const result = { code: 0, headers: {}, text: '', parsed: null, id: '', error: '' };
  try {
    const response = UrlFetchApp.fetch(CONFIG.FASTFIELD_DISPATCH_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: getFastFieldHeaders_(config.FASTFIELD_API_KEY),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    result.code = response.getResponseCode();
    result.text = String(response.getContentText());
    if (typeof response.getAllHeaders === 'function') result.headers = response.getAllHeaders();
    try { result.parsed = JSON.parse(result.text); } catch (_) { result.parsed = null; }
    const found = result.parsed && (result.parsed.dispatchId || result.parsed.taskId || result.parsed.id);
    if (found) result.id = String(found);
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  }
  return result;
}

/**
 * Posts a won call to FastField as a pre-filled task. Returns the task id, or null when the call
 * was not won, FastField is not configured, or the request failed; the caller records the call
 * either way, so nothing here throws.
 */
function dispatchToFastField_(callData) {
  const result = sendFastFieldDispatch_(callData);
  if (!result) return null;
  if (result.error) {
    console.error('FastField dispatch error: ' + result.error);
    return null;
  }
  if (result.code !== 200 && result.code !== 201) {
    console.error('FastField dispatch failed: HTTP ' + result.code + ' ' + result.text.slice(0, 500));
    return null;
  }
  if (!result.id) {
    console.error('FastField dispatch answered HTTP ' + result.code + ' without a dispatchId, taskId or id: ' + result.text.slice(0, 500));
    return null;
  }
  return result.id;
}

/** A GET to FastField: { code, headers, text, parsed, error }. `headers` are the request headers. */
function fastFieldGet_(url, headers) {
  const result = { code: 0, headers: {}, text: '', parsed: null, error: '' };
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: headers,
      muteHttpExceptions: true,
    });
    result.code = response.getResponseCode();
    result.text = String(response.getContentText());
    if (typeof response.getAllHeaders === 'function') result.headers = response.getAllHeaders();
    try { result.parsed = JSON.parse(result.text); } catch (_) { result.parsed = null; }
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  }
  return result;
}

/** The forms in a /forms reply, whether it is a bare array or wrapped in forms / data / items / results. */
function fastFieldFormList_(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const keys = ['forms', 'data', 'items', 'results'];
  for (let i = 0; i < keys.length; i++) {
    if (Array.isArray(parsed[keys[i]])) return parsed[keys[i]];
  }
  return null;
}

function fastFieldFormId_(form) {
  const id = form && (form.id !== undefined ? form.id : (form.formId !== undefined ? form.formId : form.form_id));
  return id === undefined || id === null ? '' : String(id);
}

function fastFieldFormName_(form) {
  return String((form && (form.name || form.formName || form.title)) || '(no name)');
}

/** FastField's own explanation of a rejected request, from message / error / errors in the reply. */
function describeFastFieldError_(result) {
  const parsed = result.parsed;
  const parts = [];
  if (parsed && typeof parsed === 'object') {
    ['message', 'error', 'errors', 'detail', 'title'].forEach(function (key) {
      const v = parsed[key];
      if (v === undefined || v === null || v === '') return;
      parts.push(key + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
    });
  }
  return parts.length ? parts.join(' | ') : result.text.slice(0, 1000);
}

/**
 * What a key looks like, without revealing it: its length, a masked form, whether it is 32-character
 * hex, and anything a paste may have added (surrounding whitespace or quotes, whitespace inside).
 * `raw` is the property as stored, `key` the cleaned value that is actually sent.
 */
function describeKey_(raw, key) {
  const stored = String(raw === undefined || raw === null ? '' : raw);
  let format = 'other';
  if (/^[0-9a-f]{32}$/i.test(key)) format = '32-character hexadecimal';
  else if (/^[0-9a-f]+$/i.test(key)) format = 'hexadecimal, ' + key.length + ' characters';
  else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) format = 'JWT-like (three dot-separated parts)';
  else if (/^[A-Za-z0-9]+$/.test(key)) format = 'alphanumeric';
  return {
    length: key.length,
    // A short key would be mostly on show, so those are not masked this way.
    masked: key.length >= 16 ? key.slice(0, 4) + '...' + key.slice(-4) : '(too short to show safely)',
    isHex32: /^[0-9a-f]{32}$/i.test(key),
    format: format,
    hadSurroundingWhitespace: stored !== stored.trim(),
    hadSurroundingQuotes: /^\s*["']|["']\s*$/.test(stored),
    hasInternalWhitespace: /\s/.test(key),
  };
}

/**
 * After a 401, sends the same GET once per way of presenting the key, each on its own, and logs what
 * the gateway says to each. Azure only reads Ocp-Apim-Subscription-Key (or ?subscription-key=), so
 * "invalid subscription key" for that one means the gateway read the key and does not know it,
 * while "missing" for the others is just them being ignored. Neither the key nor the URL that holds
 * it is logged.
 */
function probeFastFieldKeyPlacements_(apiKey) {
  const url = CONFIG.FASTFIELD_FORMS_URL;
  const attempts = [
    { label: 'Ocp-Apim-Subscription-Key header only', url: url, headers: { 'Ocp-Apim-Subscription-Key': apiKey, Accept: 'application/json' } },
    { label: 'x-api-key header only', url: url, headers: { 'x-api-key': apiKey, Accept: 'application/json' } },
    { label: 'Authorization: Bearer header only', url: url, headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' } },
    {
      label: '?subscription-key= query parameter only',
      url: url + (url.indexOf('?') === -1 ? '?' : '&') + 'subscription-key=' + encodeURIComponent(apiKey),
      headers: { Accept: 'application/json' },
    },
  ];
  Logger.log('The gateway refused the key. Trying each way of sending it on its own:');
  let accepted = null;
  attempts.forEach(function (attempt) {
    const probe = fastFieldGet_(attempt.url, attempt.headers);
    if (probe.error) {
      Logger.log('  ' + attempt.label + ': request failed (' + probe.error + ')');
    } else {
      Logger.log('  ' + attempt.label + ': HTTP ' + probe.code + (probe.code === 200 ? ' (accepted)' : ' - ' + describeFastFieldError_(probe)));
      if (probe.code === 200 && !accepted) accepted = attempt.label;
    }
  });
  if (accepted) {
    Logger.log('The gateway accepts the key via: ' + accepted + '. Tell me which, and the code can be narrowed to it.');
  } else {
    Logger.log('No placement worked. If the Ocp-Apim-Subscription-Key line says "invalid", the gateway read the key and does not recognize it: ' +
      'whitespace and quotes are already removed, so this value is probably not a subscription key for this API (or its subscription is inactive). ' +
      'Get the subscription key for the v3 API from FastField (their developer portal or support).');
  }
}

/**
 * Manual diagnostic: run it from the Apps Script editor to check FastField with the live Script
 * Properties, in two steps.
 *   0. A safe summary of the stored key (length, masked ends, format, stray whitespace or quotes).
 *   1. Authentication and form: GET the forms list with the API key (sent in every header form the
 *      gateway may read) and look for FASTFIELD_FORM_ID. A 401 then tries each way of sending the
 *      key on its own, to show which one the gateway reads.
 *   2. Dispatch: send one clearly marked TEST task and log the status, headers and reply (with
 *      FastField's own message for a 400 or 422).
 * It never touches the Call Log. The task is real, though: it appears on the driver's FastField
 * list, so delete it there afterwards. Returns the parsed dispatch reply, or null if it stopped.
 */
function testFastFieldDispatch() {
  const config = fastFieldConfig_();
  if (!config) {
    Logger.log('Nothing was sent. FASTFIELD_API_KEY, FASTFIELD_FORM_ID and FASTFIELD_USER_ID must all be set in Script Properties.');
    return null;
  }

  const info = describeKey_(PropertiesService.getScriptProperties().getProperty('FASTFIELD_API_KEY'), config.FASTFIELD_API_KEY);
  Logger.log('FASTFIELD_API_KEY as stored (never logged in full):');
  Logger.log('  Key Length: ' + info.length);
  Logger.log('  Key Masked: ' + info.masked);
  Logger.log('  Is 32-character Hexadecimal: ' + info.isHex32 + ' (format: ' + info.format + ')');
  Logger.log('  Contains Whitespace Before Trim: ' + info.hadSurroundingWhitespace + (info.hadSurroundingWhitespace ? ' (removed before sending)' : ''));
  Logger.log('  Had Surrounding Quotes: ' + info.hadSurroundingQuotes + (info.hadSurroundingQuotes ? ' (removed before sending)' : ''));
  Logger.log('  Contains Whitespace Inside: ' + info.hasInternalWhitespace + (info.hasInternalWhitespace ? ' (NOT removed: the key was probably pasted with a line break in it)' : ''));
  Logger.log('Step 1 of 2: checking the API key and form id (GET ' + CONFIG.FASTFIELD_FORMS_URL + ')');
  const forms = fastFieldGet_(CONFIG.FASTFIELD_FORMS_URL, getFastFieldHeaders_(config.FASTFIELD_API_KEY));
  if (forms.error) {
    Logger.log('Request failed before FastField answered: ' + forms.error);
    return null;
  }
  Logger.log('HTTP status: ' + forms.code);
  if (forms.code !== 200) {
    if (forms.code === 401 || forms.code === 403) Logger.log('Rejected: the API key was not accepted. Check FASTFIELD_API_KEY.');
    else if (forms.code === 404) Logger.log('Not found: check CONFIG.FASTFIELD_FORMS_URL.');
    Logger.log('Reply: ' + describeFastFieldError_(forms));
    if (forms.code === 401) probeFastFieldKeyPlacements_(config.FASTFIELD_API_KEY);
    Logger.log('Stopped: fix step 1 before a task is sent.');
    return null;
  }
  const list = fastFieldFormList_(forms.parsed);
  if (!list) {
    Logger.log('The forms reply was not a list I recognize, so the form id could not be checked. Reply: ' + forms.text.slice(0, 500));
    Logger.log('Continuing to step 2 without verifying the form.');
  } else {
    const wanted = String(config.FASTFIELD_FORM_ID);
    const match = list.filter(function (f) { return fastFieldFormId_(f) === wanted; })[0];
    if (match) {
      Logger.log('Form verified: ' + fastFieldFormName_(match));
    } else {
      Logger.log('FASTFIELD_FORM_ID "' + wanted + '" is not among the ' + list.length + ' form(s) this key can see. Available forms:');
      list.forEach(function (f) { Logger.log('  ' + fastFieldFormId_(f) + '  ' + fastFieldFormName_(f)); });
      Logger.log('Stopped: correct FASTFIELD_FORM_ID in Script Properties (or the key belongs to a different account).');
      return null;
    }
  }

  Logger.log('Step 2 of 2: sending a TEST task (it will show up on the driver\'s list; delete it afterwards).');
  const result = sendFastFieldDispatch_({
    call_id: 'TEST-DISPATCH-001',
    outcome: OUTCOME_WON,
    customer_phone: '916-555-0100',
    service_requested: 'Standard Tow',
    vehicle_year: 2022,
    vehicle_make: 'Honda',
    vehicle_model: 'Civic',
    pickup_address: 'Roseville, CA',
    dropoff_address: 'Sacramento, CA',
    quoted_price: 150,
    notes_comments: 'TEST DISPATCH, safe to delete',
  });
  if (!result) {
    Logger.log('Nothing was sent (see above).');
    return null;
  }
  if (result.error) {
    Logger.log('Request failed before FastField answered: ' + result.error);
    return null;
  }
  Logger.log('HTTP status: ' + result.code);
  Logger.log('Response headers: ' + JSON.stringify(result.headers));
  if (result.parsed) Logger.log('Parsed response: ' + JSON.stringify(result.parsed));
  else Logger.log('Response body (not JSON): ' + result.text.slice(0, 1000));
  if (result.code === 200 || result.code === 201) {
    Logger.log(result.id
      ? 'OK. FastField created task ' + result.id + '.'
      : 'FastField answered OK but the reply has no dispatchId, taskId or id; check the reply above.');
  } else if (result.code === 400 || result.code === 422) {
    Logger.log('FastField rejected the request as invalid. Its message: ' + describeFastFieldError_(result));
  } else if (result.code === 401 || result.code === 403) {
    Logger.log('Rejected: the API key was not accepted for dispatching. Check FASTFIELD_API_KEY and its permissions.');
  } else if (result.code === 404) {
    Logger.log('Not found: check CONFIG.FASTFIELD_DISPATCH_URL.');
  } else {
    Logger.log('Rejected: see the reply above for FastField\'s reason.');
  }
  return result.parsed;
}

function firstString_(values) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== undefined && v !== null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** The report's PDF link: a direct field, or the first PDF among the attached documents. */
function extractReceiptUrl_(body, data) {
  const direct = firstString_([data.pdfUrl, data.documentUrl, body.pdfUrl, body.documentUrl]);
  if (direct) return direct;
  const lists = [data.attachments, body.attachments, data.documents, body.documents, data.reports, body.reports];
  for (let i = 0; i < lists.length; i++) {
    if (!Array.isArray(lists[i])) continue;
    for (let j = 0; j < lists[i].length; j++) {
      const item = lists[i][j];
      if (typeof item === 'string' && /\.pdf(\?|$)/i.test(item)) return item.trim();
      if (item && typeof item === 'object') {
        const url = firstString_([item.pdfUrl, item.documentUrl, item.url, item.href, item.link]);
        const type = String(item.contentType || item.mimeType || item.type || '').toLowerCase();
        if (url && (type.indexOf('pdf') !== -1 || /\.pdf(\?|$)/i.test(url))) return url;
      }
    }
  }
  return '';
}

/**
 * FastField's "form completed" call: save the report PDF link on the matching call. Matches by
 * Call_ID (the form's Job Number), else by the customer's last 10 digits among calls logged in the
 * last 24 hours. Writes only Receipt_PDF_URL.
 */
function handleFastFieldWebhook_(body) {
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  const callId = firstString_([data.alpha_1, body.alpha_1, body.jobId, body.callId]);
  const phone = phoneKey_(firstString_([data.formattedinput_1, body.formattedinput_1, body.customerPhone, body.customer_phone]));
  const url = extractReceiptUrl_(body, data);

  if (!callId && !phone) throw new ApiError('BAD_REQUEST', 'No job number or customer phone in the payload.');
  if (!/^https:\/\//i.test(url)) throw new ApiError('BAD_REQUEST', 'No https report link (pdfUrl, documentUrl or a PDF attachment) in the payload.');

  return withLock_(function () {
    const log = getCallLog_();
    const index = readIndex_(log);

    let rowNum = findByCallId_(index, callId);
    if (!rowNum && phone) {
      const now = Date.now();
      const recent = index
        .filter(function (r) {
          return r.phoneKey === phone && r.time !== null && r.time <= now && now - r.time <= CONFIG.FASTFIELD_PHONE_WINDOW_MS;
        })
        .sort(function (a, b) { return b.time - a.time; });
      if (recent.length) rowNum = recent[0].rowNum;
    }
    if (!rowNum) {
      console.warn('FastField receipt: no call found for job "' + callId + '" / phone "' + phone + '".');
      throw new ApiError('NOT_FOUND', 'Call record not found');
    }

    writeCells_(log, rowNum, { Receipt_PDF_URL: url });
    return { action: 'receipt_saved', row: rowNum };
  }, CONFIG.FASTFIELD_LOCK_WAIT_MS);
}

// ---------------------------------------------------------------------------
// Sheet access
// ---------------------------------------------------------------------------

function withLock_(fn, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || CONFIG.LOCK_WAIT_MS)) {
    throw new ApiError('BUSY', 'Sheet is busy; retry shortly.');
  }
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getCallLog_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CALL_LOG_SHEET);
  if (!sheet) throw new ApiError('SERVER_MISCONFIGURED', 'Missing "' + CONFIG.CALL_LOG_SHEET + '" tab.');
  return ensureSchema_(sheet);
}

/**
 * Reads the header row and appends any AUTO_ADDED_HEADERS the sheet lacks (a 31-column sheet gets
 * FastField_Task_ID and Receipt_PDF_URL as columns 32 and 33). Any other missing header is a
 * configuration error. Returns the sheet, a header -> column index map and the width.
 */
function ensureSchema_(sheet) {
  let width = sheet.getLastColumn();
  const header = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
  const col = {};
  header.forEach(function (h, i) {
    const name = String(h).trim();
    if (name && !(name in col)) col[name] = i;
  });
  let missing = HEADERS.filter(function (h) { return !(h in col); });
  const addable = missing.filter(function (h) { return AUTO_ADDED_HEADERS.indexOf(h) !== -1; });
  if (addable.length) {
    // Self-migration: append the newer columns after the last header.
    sheet.getRange(1, width + 1, 1, addable.length).setValues([addable]);
    addable.forEach(function (h, i) { col[h] = width + i; });
    width += addable.length;
    missing = missing.filter(function (h) { return !(h in col); });
  }
  if (missing.length) {
    throw new ApiError('SERVER_MISCONFIGURED', 'Call Log is missing columns: ' + missing.join(', '));
  }
  return { sheet: sheet, col: col, width: width };
}

/** Reads only the identity columns (Call_ID, Date_Time, Customer_Phone) for every row. */
function readIndex_(log) {
  const n = log.sheet.getLastRow() - 1;
  if (n < 1) return [];
  const c = log.col;
  const lo = Math.min(c.Call_ID, c.Date_Time, c.Customer_Phone);
  const hi = Math.max(c.Call_ID, c.Date_Time, c.Customer_Phone);
  const values = log.sheet.getRange(2, lo + 1, n, hi - lo + 1).getValues();
  return values.map(function (v, i) {
    const time = toDate_(v[c.Date_Time - lo]);
    return {
      rowNum: i + 2,
      callId: String(v[c.Call_ID - lo]).trim(),
      time: time ? time.getTime() : null,
      phoneKey: phoneKey_(v[c.Customer_Phone - lo]),
    };
  });
}

function findByCallId_(index, callId) {
  if (!callId) return 0;
  for (let i = 0; i < index.length; i++) {
    if (index[i].callId === callId) return index[i].rowNum;
  }
  return 0;
}

function findByColumnValue_(log, header, value) {
  const n = log.sheet.getLastRow() - 1;
  if (n < 1) return 0;
  const target = String(value).trim();
  const values = log.sheet.getRange(2, log.col[header] + 1, n, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === target) return i + 2;
  }
  return 0;
}

/**
 * Same-phone rows within ±MERGE_WINDOW_MS of `when`, closest first; returns the first
 * one `isEligible(rowValues)` accepts.
 */
function findMergeCandidate_(log, index, phoneKey, when, isEligible) {
  if (!phoneKey) return null;
  const t = when.getTime();
  const candidates = index
    .filter(function (r) {
      return r.phoneKey === phoneKey && r.time !== null && Math.abs(r.time - t) <= CONFIG.MERGE_WINDOW_MS;
    })
    .sort(function (a, b) { return Math.abs(a.time - t) - Math.abs(b.time - t); });

  for (let i = 0; i < candidates.length; i++) {
    const values = log.sheet.getRange(candidates[i].rowNum, 1, 1, log.width).getValues()[0];
    if (isEligible(values)) return { rowNum: candidates[i].rowNum, values: values };
  }
  return null;
}

/** Writes only the given headers, touching the narrowest contiguous span that holds them. */
function writeCells_(log, rowNum, updates) {
  const headers = Object.keys(updates);
  if (!headers.length) return;
  const idx = headers.map(function (h) { return log.col[h]; });
  const lo = Math.min.apply(null, idx);
  const hi = Math.max.apply(null, idx);
  const range = log.sheet.getRange(rowNum, lo + 1, 1, hi - lo + 1);
  const values = range.getValues()[0];
  headers.forEach(function (h) { values[log.col[h] - lo] = toCell_(updates[h]); });
  range.setValues([values]);
  formatDateCells_(log, rowNum, headers);
}

/** Pins the yyyy-mm-dd hh:mm:ss display on date cells, even in a sheet created before setup(). */
function formatDateCells_(log, rowNum, headers) {
  headers.forEach(function (h) {
    if (DATE_HEADERS.indexOf(h) !== -1) {
      log.sheet.getRange(rowNum, log.col[h] + 1).setNumberFormat(CONFIG.DATE_TIME_FORMAT);
    }
  });
}

function appendRecord_(log, updates) {
  const sheet = log.sheet;
  const rowNum = sheet.getLastRow() + 1;
  if (rowNum > sheet.getMaxRows()) {
    // Inserted rows inherit the column formats applied by setup().
    sheet.insertRowsAfter(sheet.getMaxRows(), CONFIG.ROW_GROWTH);
  }
  const values = new Array(log.width).fill('');
  Object.keys(updates).forEach(function (h) { values[log.col[h]] = toCell_(updates[h]); });
  sheet.getRange(rowNum, 1, 1, log.width).setValues([values]);
  formatDateCells_(log, rowNum, Object.keys(updates));
  return rowNum;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function cleanValue_(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v.trim() : v;
}

function isBlank_(v) {
  return v === '' || v === null || v === undefined;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

/** Drops milliseconds so stored timestamps are always whole seconds. */
function truncSeconds_(d) {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

function parseDate_(v) {
  if (isDate_(v)) return isNaN(v.getTime()) ? null : truncSeconds_(v);
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let d = new Date(s);
  if (isNaN(d.getTime())) d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : truncSeconds_(d);
}

/** Sheet cell -> Date (cells may hold Date objects or legacy text). */
function toDate_(v) {
  return isBlank_(v) ? null : parseDate_(v);
}

function toNumber_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/** Match key: last 10 digits (US numbers with or without +1); short legacy numbers as-is. */
function phoneKey_(v) {
  let digits = String(v == null ? '' : v).replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  if (digits.length > 10) digits = digits.slice(-10);
  return digits.length >= 7 ? digits : '';
}

/** Canonical storage format: 916-555-0199. */
function formatPhone_(v) {
  let digits = String(v).replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return String(v).trim();
}

function toCell_(v) {
  if (v === undefined || v === null) return '';
  if (isDate_(v)) return truncSeconds_(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  let s;
  if (Array.isArray(v)) s = v.map(String).join(', ');
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v).trim();
  // Never let submitted text be evaluated as a formula.
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// One-time setup (run manually from the Apps Script editor)
// ---------------------------------------------------------------------------

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  const sheet = ss.getSheetByName(CONFIG.CALL_LOG_SHEET) || ss.insertSheet(CONFIG.CALL_LOG_SHEET);
  const width = sheet.getLastColumn();
  const existing = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
  if (existing.every(isBlank_)) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS.slice()]);
  }
  const log = getCallLog_();
  sheet.setFrozenRows(1);

  const rows = sheet.getMaxRows() - 1;
  if (rows > 0) {
    const formats = {
      Call_ID: '@',
      Customer_Phone: '@',
      Date_Time: CONFIG.DATE_TIME_FORMAT,
      AI_Processed_At: CONFIG.DATE_TIME_FORMAT,
      Quoted_Price: '$#,##0.00',
      Loaded_Miles: '0.0',
      Deadhead_Est_Miles: '0.0',
      Call_Duration_Sec: '0',
      Vehicle_Year: '0',
    };
    Object.keys(formats).forEach(function (h) {
      sheet.getRange(2, log.col[h] + 1, rows, 1).setNumberFormat(formats[h]);
    });
  }

  writeReferenceData_(ss);

  const props = PropertiesService.getScriptProperties();
  ['API_SECRET', 'WEBSITE_SECRET'].forEach(function (name) {
    console.log(name + (props.getProperty(name) ? ' is set.' : ' is NOT set — add it under Project Settings > Script Properties.'));
  });
  FASTFIELD_REQUIRED.forEach(function (name) {
    console.log(name + (props.getProperty(name) ? ' is set.' : ' is not set (optional): won calls will not be dispatched to FastField.'));
  });
}

function writeReferenceData_(ss) {
  const sheet = ss.getSheetByName(CONFIG.REFERENCE_SHEET) || ss.insertSheet(CONFIG.REFERENCE_SHEET);
  const headers = Object.keys(ENUMS);
  const depth = Math.max.apply(null, headers.map(function (h) { return ENUMS[h].length; }));
  const rows = [headers];
  for (let i = 0; i < depth; i++) {
    rows.push(headers.map(function (h) { return ENUMS[h][i] || ''; }));
  }
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
}
