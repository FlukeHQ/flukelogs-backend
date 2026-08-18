// GET /api/operator/sightings — every sighting for the caller's operator.
//
// Captain-facing counterpart to /api/admin/sightings. The operator_id is
// resolved server-side from the JWT, so there's no client-controlled
// operator selector to bypass — captains see only their own data.
//
// Optional filters:
//   ?since=YYYY-MM-DD   — only sightings on or after this trip_date
//   ?limit=<int>        — defaults to 500, capped at 2000

const { authenticate } = require('../../lib/auth');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

async function pgGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { /* leave as text */ }
  if (!res.ok) {
    const msg = (parsed && parsed.message) || text.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { operatorId } = auth;

  const q = req.query || {};
  const filters = [`operator_id=eq.${operatorId}`];
  if (q.since) filters.push(`trip_date=gte.${encodeURIComponent(String(q.since))}`);

  const limit = Math.min(
    parseInt(String(q.limit || DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  const select = 'id,trip_id,trip_date,trip_part,species,count,lat,lng,depth_meters,behavior_notes,created_at,sighting_time';
  const params = [
    `select=${select}`,
    'order=trip_date.desc,created_at.desc',
    `limit=${limit}`,
    ...filters,
  ].join('&');

  try {
    const rows = await pgGet(`sightings?${params}`);
    return res.status(200).json(rows || []);
  } catch (err) {
    return res.status(500).json({ error: 'List sightings failed', detail: err.message });
  }
};
