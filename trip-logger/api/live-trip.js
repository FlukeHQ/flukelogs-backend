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

const TRACK_CAP = 720;            // hard row-size backstop
// Keep at most one stored point per this many ms. The app records a GPS fix
// every ~2-3 seconds, so an unthinned track hits TRACK_CAP in ~30 minutes
// and the head of the route falls off — the widget's live line ends up
// covering only the recent past instead of the whole trip. Thinned at 20s,
// the cap holds 4 hours, longer than any departure, and the published line
// loses nothing: widget-data snaps points to a ~0.6nm grid anyway.
const TRACK_MIN_SPACING_MS = 20000;
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
  const res = await fetch(`${url}/rest/v1/live_trips?trip_id=eq.${tripId}&select=trip_id,operator_id,track,sightings,ended_at,started_at,boat_id,boat_name`, {
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

// Thin a chronological track to TRACK_MIN_SPACING_MS between kept points,
// always keeping the newest point so the boat marker sits at the freshest
// position. Runs on the full track every heartbeat: already-thinned points
// stay put and each new batch contributes its handful of keepers.
function thinTrack(track) {
  const out = [];
  let lastKept = -Infinity;
  for (const p of track) {
    const t = Date.parse(p && p.t);
    if (!Number.isFinite(t)) continue;
    if (t - lastKept >= TRACK_MIN_SPACING_MS) { out.push(p); lastKept = t; }
  }
  const newest = track[track.length - 1];
  if (newest && out[out.length - 1] !== newest) out.push(newest);
  return out.slice(-TRACK_CAP);
}

// Boat identity, sent by roster-aware app clients so the widget can tell
// two live boats apart. Optional: absent or malformed values are simply not
// written, and merge-duplicates upserts leave the stored columns untouched.
function boatFields(body) {
  const fields = {};
  if (UUID_RE.test(String(body.boatId || ''))) fields.boat_id = body.boatId;
  if (typeof body.boatName === 'string' && body.boatName.trim()) {
    fields.boat_name = body.boatName.trim().slice(0, 80);
  }
  return fields;
}

/*
  Close any broadcast this boat left open when a new one begins.

  There is no start action: the first heartbeat for a new tripId creates the
  row, and until now the previous row simply stayed open forever. Restarting a
  broadcast is common (a crew taps twice, an app relaunches), so production
  collected rows that read as 17 and 86 hour trips while the boat had been tied
  up since the afternoon. Every stale row we found died at the exact second its
  replacement started.

  Each orphan is closed at its OWN last_seen_at, not now, so the record says
  when the boat actually stopped reporting rather than when someone noticed.
  Scoped to the same boat: an operator running two boats has two legitimately
  open broadcasts, and closing by operator alone would kill the other boat's
  live map mid-trip. With no boat identity on the request we close nothing,
  since guessing is worse than a stale row.
*/
async function closeOrphanedBroadcasts(operatorId, tripId, boat) {
  const boatFilter = boat.boat_id
    ? `boat_id=eq.${boat.boat_id}`
    : (boat.boat_name ? `boat_name=eq.${encodeURIComponent(boat.boat_name)}` : null);
  if (!boatFilter) return 0;

  const url = process.env.SUPABASE_URL;
  const query =
    `live_trips?operator_id=eq.${operatorId}&trip_id=neq.${tripId}` +
    `&ended_at=is.null&${boatFilter}&select=trip_id,started_at,last_seen_at`;
  const res = await fetch(`${url}/rest/v1/${query}`, { headers: pgHeaders() });
  if (!res.ok) throw new Error(`orphan read ${res.status}`);
  const rows = await res.json();

  for (const r of rows) {
    // last_seen_at can sit a few milliseconds before started_at on a broadcast
    // that never reported a position, which would store a negative duration.
    const endAt = (r.last_seen_at && r.last_seen_at >= r.started_at)
      ? r.last_seen_at
      : r.started_at;
    const patch = await fetch(
      `${url}/rest/v1/live_trips?trip_id=eq.${r.trip_id}&operator_id=eq.${operatorId}`,
      {
        method: 'PATCH',
        headers: pgHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ ended_at: endAt }),
      },
    );
    if (!patch.ok) throw new Error(`orphan close ${patch.status}`);
  }
  return rows.length;
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

    /*
      A phone whose broadcast has been superseded must not resurrect it.

      Closing an orphan is not enough on its own: the abandoned phone keeps
      beating, and a heartbeat writes ended_at back to null, so the stale boat
      reappears on the public map about a minute later. That happened for real.
      An owner started a trip while demoing in the office, left the phone in his
      pocket, and when the crew started the actual trip on the same boat the map
      showed the vessel in two places, one of them a building.

      So a heartbeat is refused when this broadcast is closed AND a newer one
      exists for the same boat: that newer one is the trip that is really
      running. The phone is told everything is fine rather than given an error,
      since there is nobody to act on it and a retry loop helps no one.

      Scoped to superseded broadcasts only. A closed broadcast with nothing
      after it still reopens, so a crew who ends a trip and carries on logging
      is unaffected.

      Covers status as well as heartbeat, learned the hard way. The first
      version guarded heartbeats only, and on 2026-08-06 an abandoned phone
      whose broadcast had been superseded kept posting status for ninety
      minutes: each one bumped last_seen_at on the dead row and appended its
      live sighting dots there, so the whales that phone logged never appeared
      on the public map. Same resurrection, different verb.
    */
    if ((action === 'heartbeat' || action === 'status') && existing && existing.ended_at) {
      const url = process.env.SUPABASE_URL;
      const boatFilter = existing.boat_id
        ? `boat_id=eq.${existing.boat_id}`
        : (existing.boat_name ? `boat_name=eq.${encodeURIComponent(existing.boat_name)}` : null);
      if (boatFilter) {
        const q =
          `live_trips?operator_id=eq.${operatorId}&trip_id=neq.${tripId}` +
          `&started_at=gt.${encodeURIComponent(existing.started_at)}&${boatFilter}&select=trip_id&limit=1`;
        // Named so it cannot shadow the handler's own res, which is the
        // response we still have to send.
        const lookup = await fetch(`${url}/rest/v1/${q}`, { headers: pgHeaders() });
        if (lookup.ok) {
          const newer = await lookup.json();
          if (newer.length) {
            console.log(`live-trip: ignoring ${action} for superseded broadcast ${tripId}`);
            return res.status(200).json({ ok: true, superseded: true });
          }
        }
      }
    }

    /*
      Pre-start look: is another phone already broadcasting this boat?

      Exists because two crew both logged the Princess 9:00 on 2026-08-06,
      producing two trip logs of one trip and doubled sightings on the public
      widget. The app asks this before Start Trip and warns; it does not block,
      because the server cannot know that a second start is wrong, only that it
      is probably a duplicate.

      Read only, and every failure path answers "nobody live" on purpose: this
      runs at the dock on marine signal, and a start must never hang or fail on
      a lookup that exists purely to print a warning.

      Only a broadcast still actually beating counts. An open row whose phone
      died an hour ago is an orphan for the start path to close, not a reason
      to warn anyone.
    */
    if (action === 'check') {
      const fields = boatFields(req.body);
      const boatFilter = fields.boat_id
        ? `boat_id=eq.${fields.boat_id}`
        : (fields.boat_name ? `boat_name=eq.${encodeURIComponent(fields.boat_name)}` : null);
      if (!boatFilter) return res.status(200).json({ live: null });
      const url = process.env.SUPABASE_URL;
      const q =
        `live_trips?operator_id=eq.${operatorId}&trip_id=neq.${tripId}` +
        `&ended_at=is.null&${boatFilter}` +
        `&select=trip_id,started_at,last_seen_at&order=started_at.desc&limit=1`;
      const lookup = await fetch(`${url}/rest/v1/${q}`, { headers: pgHeaders() });
      if (!lookup.ok) return res.status(200).json({ live: null });
      const rows = await lookup.json();
      const row = rows && rows[0];
      const FRESH_MS = 10 * 60 * 1000;
      const fresh = row && row.last_seen_at &&
        (Date.now() - Date.parse(row.last_seen_at)) < FRESH_MS;
      return res.status(200).json({
        live: fresh ? { startedAt: row.started_at, lastSeenAt: row.last_seen_at } : null,
      });
    }

    if (action === 'heartbeat') {
      // A heartbeat with no existing row is the start of a broadcast, and the
      // only moment worth checking for one this boat left open. Doing it on
      // every heartbeat would be two extra round trips a few seconds apart for
      // the whole trip. Failure here is swallowed: a stale row is untidy, a
      // boat that drops off the live map is not.
      if (!existing) {
        try {
          const closed = await closeOrphanedBroadcasts(operatorId, tripId, boatFields(req.body));
          if (closed) console.log(`live-trip: closed ${closed} orphaned broadcast(s) for operator ${operatorId}`);
        } catch (e) {
          console.error('live-trip: closing orphaned broadcasts failed:', e.message);
        }
      }
      const incoming = cleanPoints(req.body.points);
      const track = thinTrack(((existing && existing.track) || []).concat(incoming));
      await upsertRow(Object.assign({
        trip_id: tripId,
        operator_id: operatorId,
        last_seen_at: nowISO,
        track,
        ended_at: null,
      }, boatFields(req.body)));
      return res.status(200).json({ ok: true, points: track.length });
    }

    if (action === 'status') {
      const species = String(req.body.species || '').slice(0, 80) || null;
      const update = Object.assign({
        trip_id: tripId,
        operator_id: operatorId,
        last_seen_at: nowISO,
        status_species: species,
        status_at: species ? nowISO : null,
      }, boatFields(req.body));
      // When the app knows where the sighting happened, append it as a live
      // dot. Ephemeral, append-only (mid-trip edits/deletes don't sync — the
      // report at trip end is the real record). Cap like the track.
      const lat = +req.body.lat, lng = +req.body.lng;
      if (species && Number.isFinite(lat) && Number.isFinite(lng)) {
        const count = Number.isFinite(+req.body.count)
          ? Math.min(9999, Math.max(1, Math.round(+req.body.count)))
          : null;
        update.sightings = ((existing && existing.sightings) || []).concat([{
          species,
          count,
          lat: +lat.toFixed(6),
          lng: +lng.toFixed(6),
          t: nowISO,
        }]).slice(-50);
      }
      await upsertRow(update);
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
