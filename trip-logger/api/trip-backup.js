// GET / PUT / DELETE /api/trip-backup
//
// Cloud safety-net for the captain's in-progress trip (migration 0021).
// The app PUTs the serialized trip every couple of minutes while a trip is
// active; GET returns the caller's latest backup (used at boot when there's
// no local trip); DELETE clears it (called when a trip is completed via
// Start New Trip, or when the captain declines a restore offer).
//
// One row per captain user, keyed on the verified JWT's user id — a captain
// can only ever read or write their own backup, and rows are tagged with the
// operator_id derived server-side (never client-supplied).

const { authenticate } = require('../lib/auth');

const PG_HEADERS = () => ({
  'apikey':        process.env.SUPABASE_SECRET_KEY,
  'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Content-Type':  'application/json',
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { user, operatorId } = auth;
  const url = process.env.SUPABASE_URL;
  if (!url || !operatorId) return res.status(500).json({ error: 'Not configured' });

  const rowUrl = `${url}/rest/v1/trip_backups?user_id=eq.${user.id}`;

  try {
    if (req.method === 'GET') {
      const r = await fetch(`${rowUrl}&select=trip_json,updated_at`, { headers: PG_HEADERS() });
      if (!r.ok) throw new Error(`PostgREST ${r.status}`);
      const rows = await r.json();
      if (!rows.length) return res.status(200).json({ trip: null });
      const saved = rows[0].trip_json || {};
      return res.status(200).json({
        trip: saved.trip || null,
        guestEmails: saved.guestEmails || [],
        updated_at: rows[0].updated_at,
      });
    }

    if (req.method === 'PUT') {
      const { trip, guestEmails } = req.body || {};
      if (!trip || !trip.startTime) return res.status(400).json({ error: 'Missing trip' });
      const r = await fetch(`${url}/rest/v1/trip_backups?on_conflict=user_id`, {
        method: 'POST',
        headers: { ...PG_HEADERS(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id:     user.id,
          operator_id: operatorId,
          trip_json:   { trip, guestEmails: Array.isArray(guestEmails) ? guestEmails : [] },
          updated_at:  new Date().toISOString(),
        }]),
      });
      if (!r.ok) throw new Error(`PostgREST ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const r = await fetch(rowUrl, { method: 'DELETE', headers: PG_HEADERS() });
      if (!r.ok) throw new Error(`PostgREST ${r.status}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('trip-backup error:', err.message);
    return res.status(500).json({ error: 'Backup operation failed', detail: err.message });
  }
};
