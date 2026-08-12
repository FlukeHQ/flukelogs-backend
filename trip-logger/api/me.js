// GET /api/me — returns the current user's identity + operator config.
//
// The PWA hits this once on boot (after a successful login) to get the
// per-operator settings it needs: species dropdown contents, captain card
// branding (logo, name, website), buoy station, map center.
//
// Secrets (Mailchimp API key, Gmail app password, FareHarbor keys) are
// NEVER included — they stay server-side and are only used inside
// /api/send-report. publicOperatorView() in lib/operators.js enforces that.

const { authenticate } = require('../lib/auth');
const { getOperator, publicOperatorView } = require('../lib/operators');
const { CONSENT_VERSION, hasConsented } = require('../lib/consent');

// The operator's Flukesend roster: boats, crew, and scheduled departures.
// One database since the merge, so the boat app reads the same rows the
// send flow does — a boat added in Flukesend Settings appears on the Start
// screen with no second setup. Any failure returns empty lists; the Start
// screen simply shows no pickers, exactly like an operator with no roster.
async function getRoster(operatorId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const empty = { boats: [], crew: [], trip_times: [] };
  if (!url || !key || !operatorId) return empty;
  const headers = { 'apikey': key, 'Authorization': `Bearer ${key}` };
  const get = async (path) => {
    try {
      const res = await fetch(`${url}/rest/v1/${path}`, { headers });
      return res.ok ? await res.json() : null;
    } catch (e) {
      console.error('getRoster error:', e.message);
      return null;
    }
  };
  const [boats, crew, branding] = await Promise.all([
    get(`boats?operator_id=eq.${operatorId}&select=id,name&order=sort_order.asc`),
    get(`crew_members?operator_id=eq.${operatorId}&select=id,name,roles,user_id&order=sort_order.asc`),
    get(`branding?operator_id=eq.${operatorId}&select=trip_times,logo_url&limit=1`),
  ]);
  return {
    boats: boats || [],
    crew: crew || [],
    trip_times: (branding && branding[0] && Array.isArray(branding[0].trip_times))
      ? branding[0].trip_times
      : [],
    // The Flukesend branding logo, the source of truth since 2026-08-12.
    // Branding is configured once, in Flukesend; this app only reads it.
    flukesend_logo: (branding && branding[0] && branding[0].logo_url) || null,
  };
}

/*
  The learned dock via the operator_dock RPC. Null on any failure or before
  three trips exist; the fence must never break login, so this cannot throw.
*/
async function learnedDock(operatorId) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) return null;
    const r = await fetch(`${url}/rest/v1/rpc/operator_dock`, {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: operatorId }),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const d = Array.isArray(rows) ? rows[0] : rows;
    if (!d || !Number.isFinite(+d.lat) || (d.trips || 0) < 3) return null;
    return { lat: +d.lat, lng: +d.lng };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Super admins may not be tied to any operator yet (they manage operators
  // from the admin portal). Don't 403 them — return null operator instead.
  const auth = await authenticate(req, res, { requireOperator: false });
  if (!auth) return;

  const { user, operatorId, isSuperAdmin } = auth;
  const [operator, roster, consented, dock] = await Promise.all([
    operatorId ? getOperator(operatorId) : null,
    operatorId ? getRoster(operatorId) : { boats: [], crew: [], trip_times: [] },
    hasConsented(user.id),
    operatorId ? learnedDock(operatorId) : null,
  ]);

  /*
    What to call this person. Their crew row carries the name the operator
    already types on every trip sheet, so a naturalist who is on the roster
    gets greeted by it. Six of sixteen accounts have one today; everyone else
    keeps "Captain", which is what the screen has always said and reads fine.
    First word only: rosters hold "Kailey" and occasionally "Kailey Parker",
    and a greeting wants the short one.
  */
  const me = (roster.crew || []).find(c => c.user_id === user.id);
  const displayName = me && typeof me.name === 'string' && me.name.trim()
    ? me.name.trim().split(/\s+/)[0].slice(0, 24)
    : null;

  return res.status(200).json({
    user: {
      id:    user.id,
      email: user.email,
      is_super_admin: isSuperAdmin,
      display_name: displayName,
    },
    operator: (() => {
      /*
        Logos resolve Flukesend-first. Operators used to upload two more
        copies here (dark-on-white for guest PDFs, light-on-dark for the
        header), which drifted from the Flukesend branding the moment either
        side changed; Princess had pasted the identical URL into both apps by
        hand, which is the tell that the second copy never earned its keep.
        Legacy uploads still win where they exist so nothing changes visually
        for operators who set them, and disappear from the UI either way.
      */
      const op = publicOperatorView(operator);
      op.header_logo = roster.flukesend_logo || op.logo_url_email || null;
      op.light_logo = op.logo_url || roster.flukesend_logo || null;
      op.branding_source = roster.flukesend_logo ? 'flukesend'
        : (op.logo_url || op.logo_url_email) ? 'legacy' : 'none';
      return op;
    })(),
    roster,
    /*
      The learned dock, for the harbor fence prompt. Same inference the
      parked-broadcast rule uses (operator_dock, 3+ trips required), so an
      operator who has never sailed gets null and the fence simply stays
      unarmed, which honors the zero-setup rule: nobody configures anything,
      protection appears once the data exists.
    */
    dock,
    // The crew tracking disclosure. accepted:false makes the app show the
    // consent gate before anything else; the lookup fails open, so a broken
    // read reads as accepted rather than locking a captain out.
    consent: { version: CONSENT_VERSION, accepted: consented },
  });
};
