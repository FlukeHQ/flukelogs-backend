// GET /api/operator/trips
//
// Returns the operator's recent trips with sighting counts and audio
// status. The Past Trips screen uses this to render the list where the
// captain picks a trip to record (or re-record) audio for.
//
// Two PostgREST queries (no JOIN aggregation in PostgREST so we merge in
// JS): one to pull sightings grouped into trips by trip_id, one to pull
// trip_audio rows. Then we stitch them together. Limited to the most
// recent 60 trips — plenty for any practical past-recording use case.
//
// DELETE /api/operator/trips?tripId=<uuid>
//
// Removes one trip everywhere it lives: sightings, GPS track, audio note
// (and its storage file), photo gallery (and its storage files),
// logbook_trips, and any live_trips row. Every delete is scoped to the
// authenticated operator's id as well as the trip id, so a stolen trip id
// from another tenant deletes nothing. Pre-0013 trips with no trip_id
// can't be deleted here (nothing ties their rows together server-side).

const { authenticate } = require('../../lib/auth');

const LIMIT_TRIPS = 60;

async function pgGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function pgDelete(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'count=exact',
    },
  });
  if (!res.ok) throw new Error(`PostgREST DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const range = res.headers.get('content-range') || '';
  return parseInt(range.split('/')[1], 10) || 0;
}

// Removes a storage object given its public URL. Failures are logged and
// swallowed: an orphaned file is a cost nit, not a reason to strand the
// captain with a half-deleted trip.
async function deleteStorageObject(publicUrl) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const m = String(publicUrl || '').match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!m) return;
  try {
    const res = await fetch(`${url}/storage/v1/object/${m[1]}/${m[2]}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) console.error('storage delete failed:', m[1], m[2], res.status);
  } catch (e) {
    console.error('storage delete error:', e.message);
  }
}

async function handleDelete(req, res, operatorId) {
  const tripId = String((req.query && req.query.tripId) || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tripId)) {
    return res.status(400).json({ error: 'A valid tripId is required' });
  }
  const scope = `operator_id=eq.${operatorId}&trip_id=eq.${tripId}`;

  try {
    // Storage first, while the rows still hold the URLs.
    const [audioRows, photoRows] = await Promise.all([
      pgGet(`trip_audio?${scope}&select=audio_url`),
      pgGet(`trip_photos?${scope}&select=photo_url`),
    ]);
    await Promise.all([
      ...audioRows.map(r => deleteStorageObject(r.audio_url)),
      ...photoRows.map(r => deleteStorageObject(r.photo_url)),
    ]);

    const [sightings, track, audio, photos, logbook, live] = await Promise.all([
      pgDelete(`sightings?${scope}`),
      pgDelete(`trip_track?${scope}`),
      pgDelete(`trip_audio?${scope}`),
      pgDelete(`trip_photos?${scope}`),
      pgDelete(`logbook_trips?${scope}`),
      pgDelete(`live_trips?${scope}`),
    ]);
    const deleted = { sightings, track, audio, photos, logbook, live };
    if (Object.values(deleted).every(n => n === 0)) {
      return res.status(404).json({ error: 'No such trip for this operator' });
    }
    console.log(`Deleted trip ${tripId} for operator ${operatorId}:`, JSON.stringify(deleted));
    return res.status(200).json({ success: true, deleted });
  } catch (err) {
    console.error('trip delete failed:', err.message);
    return res.status(500).json({ error: 'Delete failed', detail: err.message });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { operatorId } = auth;

  if (req.method === 'DELETE') return handleDelete(req, res, operatorId);

  try {
    // Pull every sighting for this operator (operator_id-tagged since Step 3)
    // ordered by trip_date desc. We aggregate in JS so we can keep the schema
    // simple and avoid a Postgres view migration. For an operator with years
    // of data this would need a real aggregation, but for whale-watch
    // volumes it's negligible.
    const sightings = await pgGet(
      `sightings?operator_id=eq.${operatorId}` +
      `&select=trip_id,trip_date,trip_part,species,count,created_at` +
      `&order=trip_date.desc&limit=2000`
    );

    // Group by trip_id — two trips run the same calendar day stay separate.
    // A row with no trip_id (pre-0013 data) falls back to its date as a key.
    const byTrip = new Map();
    for (const s of sightings) {
      const k = s.trip_id || s.trip_date;
      if (!byTrip.has(k)) {
        byTrip.set(k, {
          trip_id:    s.trip_id || null,
          trip_date:  s.trip_date,
          trip_part:  s.trip_part || null,
          created_at: s.created_at || '',
          sighting_count: 0, animal_count: 0, species: new Set(),
        });
      }
      const g = byTrip.get(k);
      g.sighting_count += 1;
      g.animal_count += parseInt(s.count, 10) || 0;
      if (s.species) g.species.add(s.species);
    }

    // Newest trip first: by date, then created_at so a day's evening trip
    // sorts above its morning trip. Capped at LIMIT_TRIPS.
    const trips = Array.from(byTrip.values())
      .sort((a, b) =>
        b.trip_date.localeCompare(a.trip_date) ||
        String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, LIMIT_TRIPS);

    // Pull audio status for those trips in a single round-trip, keyed by
    // trip_id (pre-0013 trips with no trip_id can't carry trip_id audio).
    const idList = trips.map(t => t.trip_id).filter(Boolean).map(id => `"${id}"`).join(',');
    const audioRows = idList
      ? await pgGet(`trip_audio?operator_id=eq.${operatorId}&trip_id=in.(${idList})&select=trip_id,audio_url,duration_seconds,play_count`)
      : [];
    const audioByTrip = new Map(audioRows.map(r => [r.trip_id, r]));

    const out = trips.map(t => {
      const audio = t.trip_id ? audioByTrip.get(t.trip_id) : null;
      return {
        trip_id:          t.trip_id,
        trip_date:        t.trip_date,
        trip_part:        t.trip_part,
        sighting_count:   t.sighting_count,
        animal_count:     t.animal_count,
        species_count:    t.species.size,
        has_audio:        !!audio,
        audio_url:        audio ? audio.audio_url : null,
        duration_seconds: audio ? audio.duration_seconds : null,
        play_count:       audio ? audio.play_count : null,
      };
    });

    return res.status(200).json(out);
  } catch (err) {
    console.error('operator/trips failed:', err.message);
    return res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
};
