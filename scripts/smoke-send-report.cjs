#!/usr/bin/env node
//
// Smoke test for trip-logger/api/send-report.js — the Log Trip endpoint.
//
// Why this exists: on 2026-08-06 a `const` declared inside an if-branch and
// used in that branch's else-if shipped to production. `node --check` passed
// it clean, because a block-scope ReferenceError is a runtime error, not a
// syntax error. Every ordinary Log Trip threw before the handler's try block
// existed to catch it, and nobody could log a trip for seventeen hours. The
// captain's app could only report "Server said 500".
//
// This invokes the real handler with a realistic log-only payload and fails
// if the request does not come back 200, or if it comes back with any error
// whose shape says "our own code threw" (ReferenceError, TypeError, etc.).
//
// It touches no database. `authenticate` and `getOperator` are stubbed at the
// require boundary, and saveToSupabase/saveTrackToSupabase already no-op when
// SUPABASE_URL and SUPABASE_SECRET_KEY are absent, so the routing, branching,
// date handling and id validation all run for real while the writes do not.
//
// Usage: node scripts/smoke-send-report.cjs
// Exits non-zero on failure.

const path = require('path');
const Module = require('module');

const API = path.resolve(__dirname, '../trip-logger/api/send-report.js');
const AUTH = path.resolve(__dirname, '../trip-logger/lib/auth.js');
const OPERATORS = path.resolve(__dirname, '../trip-logger/lib/operators.js');

// Point Supabase at a fake origin and intercept fetch, so the insert and
// replay-check paths execute for real against canned responses. Leaving the
// env unset instead would make saveToSupabase take its "not configured"
// early return and skip the very code we want covered.
process.env.SUPABASE_URL = 'https://smoke.invalid';
process.env.SUPABASE_SECRET_KEY = 'smoke-service-key';

const calls = [];
// Bodies as well as routes: attribution is a thing WRITTEN, so asserting it
// means looking at the row, not just at whether a POST happened.
const writes = [];
global.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const route = String(url).replace(process.env.SUPABASE_URL, '');
  calls.push(`${method} ${route}`);
  if (method === 'POST' && opts.body) {
    try { writes.push({ route, rows: JSON.parse(opts.body) }); } catch { /* not json, ignore */ }
  }
  // Reads answer empty (no replay, no live track to backfill); writes answer
  // created. Both are the shapes PostgREST actually returns.
  const body = method === 'GET' ? [] : [{ id: 'smoke-row' }];
  return {
    ok: true,
    status: method === 'GET' ? 200 : 201,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
};

// The email-side npm packages are stubbed by name rather than installed, so
// this test runs on a bare checkout with no `npm install`. Log Trip is
// log-only and never reaches any of them; they are required at the top of
// the module, which is the only reason they need to resolve at all.
const STUB_PACKAGES = {
  '@mailchimp/mailchimp_marketing': { setConfig() {}, lists: { addListMember: async () => ({}) } },
  pdfkit: function PDFDocumentStub() { throw new Error('pdfkit must not be reached on a log-only trip'); },
  nodemailer: { createTransport: () => ({ sendMail: async () => { throw new Error('no mail on a log-only trip'); } }) },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUB_PACKAGES, request)) return STUB_PACKAGES[request];
  return realLoad.apply(this, arguments);
};

// Stub the two modules the handler authenticates and brands through, so the
// test needs no session and no operator row.
require.cache[AUTH] = {
  id: AUTH, filename: AUTH, loaded: true, exports: {
    // A user, because the handler now attributes the log to whoever is
    // signed in. Without one, logged_by would be silently untestable.
    authenticate: async () => ({
      operatorId: 'smoke-test-operator',
      user: { id: '9f1d3a70-5c28-4b6e-8a11-2d4c6e8f0a92' },
    }),
  },
};
require.cache[OPERATORS] = {
  id: OPERATORS, filename: OPERATORS, loaded: true, exports: {
    getOperator: async () => ({
      id: 'smoke-test-operator',
      name: 'Smoke Test Charters',
      from_email: 'smoke@example.invalid',
      timezone: 'America/Los_Angeles',
    }),
    pick: (obj, key, fallback) => (obj && obj[key] != null ? obj[key] : fallback),
  },
};

const handler = require(API);

function mockRes() {
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return res;
}

// A trip shaped the way the app actually sends one: client-owned uuid, real
// sightings, a short track, log-only mode.
function tripBody() {
  const start = new Date(Date.now() - 90 * 60 * 1000);
  const end = new Date();
  return {
    mode: 'log-only',
    logTripId: '3f6b1c9e-2a44-4d81-9f0e-7c5a2b8d4e10',
    tripDate: '2026-08-08',
    tripData: {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      boatName: 'Smoke Runner',
      passengers: 12,
      distanceNM: 14.2,
      sightings: [
        { species: 'Humpback Whale', count: 2, time: start.toISOString(), notes: 'fluke up' },
        { species: 'Common Dolphin', count: 150, time: end.toISOString(), notes: '' },
      ],
      track: [
        { lat: 36.8007, lng: -121.9473, t: start.getTime() },
        { lat: 36.8190, lng: -121.9790, t: start.getTime() + 60000 },
      ],
    },
  };
}

const CASES = [
  {
    name: 'ordinary Log Trip (log-only) — the path that broke for 17 hours',
    body: tripBody(),
    expect: 200,
  },
  {
    name: 'log-only with no client trip id (older cached app build)',
    body: (() => { const b = tripBody(); delete b.logTripId; return b; })(),
    expect: 200,
  },
  {
    name: 'log-only with no track (GPS never acquired)',
    body: (() => { const b = tripBody(); b.tripData.track = []; return b; })(),
    expect: 200,
  },
  {
    name: 'log-only with no sightings (a quiet trip still logs)',
    body: (() => { const b = tripBody(); b.tripData.sightings = []; return b; })(),
    expect: 200,
  },
  {
    /*
      Attribution, added 2026-08-09. The point is not that the request
      succeeds, it is that the row carries who logged it, on what, and which
      broadcast it came from. A silently absent column looks exactly like a
      passing test otherwise, which is the mistake this whole file exists to
      stop repeating.
    */
    name: 'log-only records who logged it, the platform, and the live trip id',
    body: (() => {
      const b = tripBody();
      b.tripData.liveId = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff';
      return b;
    })(),
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' },
    expect: 200,
    check() {
      const w = writes.find(w => w.route.includes('logbook_trips'));
      if (!w) return 'no logbook_trips row was written';
      const row = Array.isArray(w.rows) ? w.rows[0] : w.rows;
      if (row.logged_by !== '9f1d3a70-5c28-4b6e-8a11-2d4c6e8f0a92') {
        return `logged_by was ${JSON.stringify(row.logged_by)}`;
      }
      if (row.logged_on !== 'ios') return `logged_on was ${JSON.stringify(row.logged_on)} (expected ios)`;
      if (row.live_trip_id !== 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff') {
        return `live_trip_id was ${JSON.stringify(row.live_trip_id)}`;
      }
      return null;
    },
  },
  {
    name: 'an Android user agent is recorded as android, not ios',
    body: (() => { const b = tripBody(); b.logTripId = '7c2e9a15-4b83-4c66-91af-0d5e7b3a6f28'; return b; })(),
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' },
    expect: 200,
    check() {
      const w = writes.filter(w => w.route.includes('logbook_trips')).pop();
      if (!w) return 'no logbook_trips row was written';
      const row = Array.isArray(w.rows) ? w.rows[0] : w.rows;
      if (row.logged_on !== 'android') return `logged_on was ${JSON.stringify(row.logged_on)} (expected android)`;
      return null;
    },
  },
  {
    name: 'add-guests with a bad trip id is rejected cleanly, not with a 500',
    body: { mode: 'add-guests', tripId: 'not-a-uuid', tripData: tripBody().tripData, guests: [{ email: 'a@b.co' }] },
    expect: 400,
  },
];

// The signatures of "our own code threw", as opposed to a deliberate 4xx.
const OUR_BUG = /ReferenceError|is not defined|Cannot read propert|is not a function|TypeError/i;

(async () => {
  let failed = 0;

  for (const c of CASES) {
    const res = mockRes();
    let thrown = null;
    // Fresh per case, so a check() sees only its own writes.
    writes.length = 0;
    try {
      await handler({ method: 'POST', body: c.body, headers: c.headers || {} }, res);
    } catch (e) {
      thrown = e;
    }

    const detail = JSON.stringify(res.body || {});
    const bug = thrown || OUR_BUG.test(detail);
    // A 200 is not the whole answer for a case that asserts on what was
    // written: a column silently missing from the row still returns 200.
    const checkFailure = (!bug && res.statusCode === c.expect && c.check) ? c.check() : null;
    const ok = !bug && res.statusCode === c.expect && !checkFailure;

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!ok) {
      failed++;
      if (thrown) {
        console.error(`      threw ${thrown.constructor.name}: ${thrown.message}`);
        console.error(String(thrown.stack).split('\n').slice(1, 4).join('\n'));
      } else if (checkFailure) {
        console.error(`      ${checkFailure}`);
      } else {
        console.error(`      expected ${c.expect}, got ${res.statusCode}`);
        console.error(`      body: ${detail.slice(0, 300)}`);
      }
    }
  }

  console.log();
  if (failed) {
    console.error(`${failed} of ${CASES.length} failed. Do NOT ship.`);
    process.exit(1);
  }
  console.log(`All ${CASES.length} passed. Log Trip answers.`);
})();
