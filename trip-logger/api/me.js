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
    get(`crew_members?operator_id=eq.${operatorId}&select=id,name,roles&order=sort_order.asc`),
    get(`branding?operator_id=eq.${operatorId}&select=trip_times&limit=1`),
  ]);
  return {
    boats: boats || [],
    crew: crew || [],
    trip_times: (branding && branding[0] && Array.isArray(branding[0].trip_times))
      ? branding[0].trip_times
      : [],
  };
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
  const [operator, roster] = await Promise.all([
    operatorId ? getOperator(operatorId) : null,
    operatorId ? getRoster(operatorId) : { boats: [], crew: [], trip_times: [] },
  ]);

  return res.status(200).json({
    user: {
      id:    user.id,
      email: user.email,
      is_super_admin: isSuperAdmin,
    },
    operator: publicOperatorView(operator),
    roster,
  });
};
