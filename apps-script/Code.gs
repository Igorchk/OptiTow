/**
 * OptiTow — Phase 1 middleware (Google Apps Script Web App).
 *
 * One `doPost(e)` endpoint, routed by the `source` query parameter:
 *
 *   (none) / ?source=app   iOS dispatcher app sync        token in JSON body   (API_SECRET)
 *   ?source=website        Website form submission       token in body/query  (WEBSITE_SECRET)
 *   ?source=callrail       CallRail post-call webhook    token in query       (API_SECRET)
 *   ?source=ai             Mac Mini AI worker            token in JSON body   (API_SECRET)
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
 *   AI worker      -> Caller_Tone, Mentioned_Damage, AI_Processed_At, and Lead_Source only if
 *                     still blank after CallRail
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
});

// 29 columns. Columns 1-21 are the dispatcher block (app/website writes, plus the computed miles);
// 22-29 are automated ingestion (CallRail, then the AI worker), so a dispatcher write can never
// land on an automated column. Lookups are by header name, never by position.
const HEADERS = Object.freeze([
  'Call_ID', 'Date_Time', 'Customer_Phone', 'Caller_Type', 'Payer_Name',
  'Service_Requested', 'Vehicle_Year', 'Vehicle_Make', 'Vehicle_Model', 'Drivetrain',
  'Vehicle_Condition', 'Scene_Location', 'Start_Location', 'Pickup_Address', 'Dropoff_Address',
  'Loaded_Miles', 'Deadhead_Est_Miles', 'Quoted_Price', 'Outcome', 'Decline_Reason',
  'Notes_Comments',
  'Lead_Source', 'Search_Keyword', 'Campaign_Name', 'Call_Duration_Sec', 'Call_Recording_URL',
  'Caller_Tone', 'Mentioned_Damage', 'AI_Processed_At',
]);

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
    authorize_(request.source, request.token);

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

/** Unauthenticated health check so a deployment can be verified from a browser. */
function doGet() {
  return json_({ ok: true, service: 'optitow-middleware' });
}

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

function authorize_(source, token) {
  // The website token ships in public page code, so it gets its own secret that can
  // only create website leads — never the API_SECRET used by the app, CallRail and AI.
  const propName = source === 'website' ? 'WEBSITE_SECRET' : 'API_SECRET';
  const expected = PropertiesService.getScriptProperties().getProperty(propName);
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

  return withLock_(function () {
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

    if (rowNum) {
      writeCells_(log, rowNum, updates);
    } else {
      rowNum = appendRecord_(log, updates);
      action = 'created';
    }

    return { action: action, call_id: record.Call_ID, row: rowNum, warnings: warnings };
  });
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
    body.lead_source !== undefined;
  // `mark_processed` lets the worker retire a row whose AI cells were all filled by hand.
  if (!hasContent && body.mark_processed !== true) {
    throw new ApiError('BAD_REQUEST', 'caller_tone, mentioned_damage, lead_source or mark_processed is required.');
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
// Sheet access
// ---------------------------------------------------------------------------

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
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
  const width = sheet.getLastColumn();
  const header = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
  const col = {};
  header.forEach(function (h, i) {
    const name = String(h).trim();
    if (name && !(name in col)) col[name] = i;
  });
  const missing = HEADERS.filter(function (h) { return !(h in col); });
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
