// POST /api/live-trip — the captain app's live-broadcast channel.
//
// While a trip is running, the app batches GPS points and calls this every
// ~60s ({action:'heartbeat'}), pushes the species the moment a sighting is
// logged ({action:'status'}), and closes the broadcast at End Trip /
// discard ({action:'end'}). Rows land in live_trips (RLS on, zero policies)
// and only ever reach the public via /api/widget-data, which applies the
// operator's delay+fuzz transform — this endpoint stores exact points but
// never serves them.
//
// Auth: captain JWT (same authenticate() as every captain endpoint); every
// row is written with the operator_id resolved from the token, so one
// operator can never broadcast into another's widget.

const { authenticate } = require('../lib/auth');

const TRACK_CAP = 720;            // ~12h of 1/min batches — plenty for any trip
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pgHeaders(extra) {
  const key = process.env.SUPABASE_SECRET_KEY;
  return Object.assign({
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function getRow(tripId) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(`${url}/rest/v1/live_trips?trip_id=eq.${tripId}&select=trip_id,operator_id,track`, {
    headers: pgHeaders(),
  });
  if (!res.ok) throw new Error(`live_trips read ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function upsertRow(body) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(`${url}/rest/v1/live_trips?on_conflict=trip_id`, {
    method: 'POST',
    headers: pgHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([body]),
  });
  if (!res.ok) throw new Error(`live_trips upsert ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

function cleanPoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .filter(p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng))
    .slice(0, 240)  // one request can't dump more than ~4 batches
    .map(p => ({
      lat: +(+p.lat).toFixed(6),
      lng: +(+p.lng).toFixed(6),
      t: (typeof p.t === 'string' && p.t.length <= 40) ? p.t : new Date().toISOString(),
    }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { operatorId } = auth;

  const { action, tripId } = req.body || {};
  if (!UUID_RE.test(String(tripId || ''))) return res.status(400).json({ error: 'Valid tripId required' });

  try {
    const existing = await getRow(tripId);
    if (existing && existing.operator_id !== operatorId) {
      return res.status(403).json({ error: 'Not your trip' });
    }
    const nowISO = new Date().toISOString();

    if (action === 'heartbeat') {
      const incoming = cleanPoints(req.body.points);
      const track = ((existing && existing.track) || []).concat(incoming).slice(-TRACK_CAP);
      await upsertRow({
        trip_id: tripId,
        operator_id: operatorId,
        last_seen_at: nowISO,
        track,
        ended_at: null,
      });
      return res.status(200).json({ ok: true, points: track.length });
    }

    if (action === 'status') {
      const species = String(req.body.species || '').slice(0, 80) || null;
      await upsertRow({
        trip_id: tripId,
        operator_id: operatorId,
        last_seen_at: nowISO,
        status_species: species,
        status_at: species ? nowISO : null,
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'end') {
      if (existing) {
        await upsertRow({ trip_id: tripId, operator_id: operatorId, ended_at: nowISO });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('live-trip error:', err.message);
    return res.status(500).json({ error: 'Live update failed' });
  }
};
