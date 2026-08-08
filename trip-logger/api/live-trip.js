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

/*
  The parked-boat rule: a broadcast that stops sailing stops broadcasting.

  Every other safety net here triggers on silence. A phone that dies, loses
  signal or gets force quit stops beating and the widget calls the broadcast
  over ten minutes later. None of that helps against the opposite failure,
  which is the common one: the boat ties up, nobody taps End Trip, and the
  phone in someone's pocket keeps beating happily from the wharf. Princess
  docked at 9:09 PM on 2026-08-06 and was still publishing "on the water
  since 7:04 PM" at 9:20, and would have kept it up all night. Worse, an open
  broadcast blocks the next start on that boat, so the morning departure
  would have been locked out by last night's phone.

  The rule Slater asked for was 100 metres for 15 minutes. Replaying it over
  two weeks of real tracks showed why that alone is not enough, twice over.

  First, tonight's phone sat at the dock for thirteen minutes and forty
  seconds and then set off again at six kilometres an hour, because a person
  picked it up and walked to their car. Every step reset the stationary
  window. The vessel had been finished for a quarter of an hour. So the test
  is not "has it stopped" but "is it still under way": speed measured over a
  minute rather than fix to fix, since GPS jitter at a dock can fake a
  sprint, and anything under UNDERWAY_KMH is not a boat working. It is a boat
  tied up, or a phone in a pocket.

  Second, and this is the one that would have cost us a live map in the
  middle of the best encounter of somebody's day: stillness cannot tell a
  dock from a whale. Boats hold station on animals for up to twenty one
  minutes in the recorded data, and hold tighter doing it than they do at the
  wharf (a five minute spread of 67 metres on whales against 20 metres tied
  up). Speed-only firing closed three real trips 16 to 23 km offshore. What
  does separate them is where: every dock stop sat 100 to 200 metres from the
  wharf. So the boat's own berth, learned from its arrivals by the
  operator_dock function, is part of the test.

  Hence two ways to close. At the dock, fifteen minutes stopped is enough,
  which is the rule as asked for. Anywhere else it takes DRIFT_WINDOW, well
  past the longest whale sit ever recorded here, so an operator with no
  learned dock yet still gets an end rather than an all-night broadcast.

  Three further guards keep it off a boat that is still working.

  It only applies after the boat has left. Crews board passengers for ten or
  fifteen minutes with the trip already started, sitting still at the dock,
  which is this exact signature. A broadcast that has never been more than
  DEPARTED_M from its first fix is still at the dock, not home from sea.

  It needs a populated window, not a quiet one. Fewer than MIN_WINDOW_POINTS
  fixes since the boat stopped means the phone was asleep or out of signal,
  and a gap is not evidence of anything. Silence is the other net's job.

  It defers to the animals. A sighting or a status posted inside the window
  means the crew is working, and the rule stands down.
*/
const UNDERWAY_KMH = 8;              // ~4.3 knots; these boats cruise 10 to 20
const SPEED_SPAN_MS = 60 * 1000;     // measure speed over a minute, not a fix
const DOCK_WINDOW_MS = 15 * 60 * 1000;   // stopped at the berth
/*
  Stopped anywhere that is not the berth, which in practice means stopped on
  animals. The longest sit in two weeks of recorded tracks was 21 minutes, so
  45 looked like comfortable margin. It is the wrong thing to be tight about.

  Being early here does not just take a boat off the public map: the app
  follows the server, so the crew get yanked to the trip review screen and
  asked to log, in the middle of a trip, while guests are watching a whale.
  Being late costs an abandoned broadcast running a while longer, which the
  widget already hides after ten minutes of silence and the next departure
  closes outright.

  So this window is deliberately far past any plausible encounter. Boats that
  come home are caught by the berth rule anyway, whatever this is set to.
*/
const DRIFT_WINDOW_MS = 90 * 60 * 1000;
const DOCK_RADIUS_M = 800;           // the harbour, not a berth: the estimate is ~250m coarse
const MIN_DOCK_TRIPS = 3;            // a berth backed by less history is a guess
const STATIONARY_RADIUS_M = 100;     // "moved again" for a parked broadcast
const DEPARTED_M = 400;
const MIN_WINDOW_POINTS = 5;

/*
  A broadcast whose phone simply stopped talking.

  The parked auto-end only fires while heartbeats are arriving, so it cannot
  close a trip whose phone was locked, went flat, or lost signal for good: no
  ping, no evaluation, and the row stays open forever. closeOrphanedBroadcasts
  catches these, but only when that same boat next broadcasts, which may be
  the following morning or, for a boat pulled from the roster, never. On
  2026-08-07 a Princess row sat open two hours after its last ping.

  45 minutes, well past the 10 the widget already uses to hide a stale boat,
  so closing changes nothing a visitor can see. It is deliberately generous
  because a working boat offshore can go quiet for a while.

  Safe to be wrong. If the boat comes back and no newer broadcast supersedes
  it, the heartbeat path writes ended_at: null and the row simply resumes.
*/
const STALE_BROADCAST_MS = 45 * 60 * 1000;

function metresBetween(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function usablePoints(track) {
  return (track || [])
    .map(p => ({ lat: +(p && p.lat), lng: +(p && p.lng), ms: Date.parse(p && p.t) }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.ms));
}

// The last moment this track was moving at boat speed. Each fix is compared
// against the most recent fix at least SPEED_SPAN_MS older, so a single noisy
// position at a dock cannot pass for a vessel under way.
function lastUnderwayMs(pts) {
  let last = null;
  let ref = 0;
  for (let i = 1; i < pts.length; i++) {
    while (ref < i - 1 && pts[i].ms - pts[ref + 1].ms >= SPEED_SPAN_MS) ref++;
    const span = pts[i].ms - pts[ref].ms;
    if (span < SPEED_SPAN_MS) continue;
    const kmh = (metresBetween(pts[ref], pts[i]) / 1000) / (span / 3600000);
    if (kmh >= UNDERWAY_KMH) last = pts[i].ms;
  }
  return last;
}

// Every stretch this track spent not under way, oldest first, as
// {fromMs, toMs, at} where at is the position it was sitting. The tail
// stretch runs to nowMs.
function stoppedStretches(pts, nowMs) {
  const under = new Array(pts.length).fill(false);
  let ref = 0;
  for (let i = 1; i < pts.length; i++) {
    while (ref < i - 1 && pts[i].ms - pts[ref + 1].ms >= SPEED_SPAN_MS) ref++;
    const span = pts[i].ms - pts[ref].ms;
    if (span < SPEED_SPAN_MS) continue;
    const kmh = (metresBetween(pts[ref], pts[i]) / 1000) / (span / 3600000);
    under[i] = kmh >= UNDERWAY_KMH;
  }
  const out = [];
  let lastUnder = null;
  for (let i = 0; i < pts.length; i++) {
    if (!under[i]) continue;
    if (lastUnder !== null && i > lastUnder + 1) {
      out.push({ fromMs: pts[lastUnder].ms, toMs: pts[i].ms, at: pts[lastUnder] });
    }
    lastUnder = i;
  }
  if (lastUnder !== null && lastUnder < pts.length - 1) {
    out.push({ fromMs: pts[lastUnder].ms, toMs: nowMs, at: pts[lastUnder] });
  }
  return out;
}

// The longest stretch this track has spent not under way. The cheap first
// pass, so a boat that has never stopped never triggers a berth lookup.
function stoppedForMs(track, nowMs) {
  const pts = usablePoints(track);
  if (pts.length < MIN_WINDOW_POINTS) return -1;
  let best = -1;
  for (const s of stoppedStretches(pts, nowMs)) {
    const d = s.toMs - s.fromMs;
    if (d > best) best = d;
  }
  return best;
}

// Null when the broadcast should stay open; otherwise the ISO time the boat
// stopped being under way, which becomes ended_at. Ended at the moment it
// stopped rather than the moment we noticed, matching how orphaned
// broadcasts are closed. dock may be null: an operator whose berth is not
// known yet simply gets the longer window everywhere.
function parkedSince(track, row, nowMs, dock) {
  const pts = usablePoints(track);
  if (pts.length < MIN_WINDOW_POINTS) return null;

  // Departed? Farthest any fix ever got from where the broadcast began.
  const origin = pts[0];
  let farthest = 0;
  for (const p of pts) {
    const d = metresBetween(origin, p);
    if (d > farthest) farthest = d;
  }
  if (farthest < DEPARTED_M) return null;

  /*
    Scanned over the whole track, not just the tail, because of what the
    phones actually do after a trip. Tonight's was carried off the boat and
    then driven up Highway 1, and a car is comfortably under way by any
    threshold, so a rule that only asks "is it moving right now" would have
    watched the broadcast drive home through Seaside and never closed it. The
    berth sit happened; it stays true afterwards. The earliest qualifying
    stop is the one that counts, since that is when the trip really ended.
  */
  for (const stretch of stoppedStretches(pts, nowMs)) {
    const atDock = !!dock && metresBetween(stretch.at, dock) <= DOCK_RADIUS_M;
    const window = atDock ? DOCK_WINDOW_MS : DRIFT_WINDOW_MS;
    if (stretch.toMs - stretch.fromMs < window) continue;

    // A quiet stretch is not a stopped one: too few fixes while the boat sat
    // means the phone was asleep or out of signal, not tied up.
    const during = pts.filter(p => p.ms >= stretch.fromMs && p.ms <= stretch.toMs);
    if (during.length < MIN_WINDOW_POINTS) continue;

    // Working the animals? A sighting or status while it sat wins.
    const statusMs = Date.parse(row && row.status_at);
    if (Number.isFinite(statusMs) && statusMs >= stretch.fromMs && statusMs <= stretch.toMs) continue;
    const busy = ((row && row.sightings) || []).some(s => {
      const ms = Date.parse(s && s.t);
      return Number.isFinite(ms) && ms >= stretch.fromMs && ms <= stretch.toMs;
    });
    if (busy) continue;

    return new Date(stretch.fromMs).toISOString();
  }
  return null;
}

/*
  The operator's berth, from operator_dock, held in the instance for an hour.

  A dock moves about as often as a harbour does, so recomputing it per
  heartbeat would be waste, and this is asked for only when a boat has
  already been sitting still. Every failure answers "no dock", which costs
  the longer window rather than a wrong ending.
*/
const dockCache = new Map();
const DOCK_TTL_MS = 60 * 60 * 1000;

async function operatorDock(operatorId) {
  const hit = dockCache.get(operatorId);
  if (hit && Date.now() - hit.at < DOCK_TTL_MS) return hit.dock;
  let dock = null;
  try {
    const url = process.env.SUPABASE_URL;
    const res = await fetch(`${url}/rest/v1/rpc/operator_dock`, {
      method: 'POST',
      headers: pgHeaders(),
      body: JSON.stringify({ op: operatorId }),
    });
    if (res.ok) {
      const rows = await res.json();
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (r && Number.isFinite(+r.lat) && Number.isFinite(+r.lng) && (r.trips || 0) >= MIN_DOCK_TRIPS) {
        dock = { lat: +r.lat, lng: +r.lng };
      }
    }
  } catch (e) {
    console.error('live-trip: dock lookup failed:', e.message);
  }
  dockCache.set(operatorId, { at: Date.now(), dock });
  return dock;
}

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
  const res = await fetch(`${url}/rest/v1/live_trips?trip_id=eq.${tripId}&select=trip_id,operator_id,track,sightings,ended_at,ended_reason,status_at,started_at,boat_id,boat_name`, {
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

// Close this operator's broadcasts that have gone quiet past the threshold.
// Each is closed at its OWN last_seen_at, matching closeOrphanedBroadcasts, so
// the record says when the boat stopped reporting and not when we noticed.
async function closeStaleBroadcasts(operatorId, nowMs) {
  const url = process.env.SUPABASE_URL;
  const cutoff = new Date(nowMs - STALE_BROADCAST_MS).toISOString();
  const query =
    `live_trips?operator_id=eq.${operatorId}&ended_at=is.null` +
    `&last_seen_at=lt.${encodeURIComponent(cutoff)}&select=trip_id,started_at,last_seen_at`;
  const res = await fetch(`${url}/rest/v1/${query}`, { headers: pgHeaders() });
  if (!res.ok) throw new Error(`stale read ${res.status}`);
  const rows = await res.json();

  for (const r of rows) {
    const endAt = (r.last_seen_at && r.last_seen_at >= r.started_at) ? r.last_seen_at : r.started_at;
    const patch = await fetch(
      `${url}/rest/v1/live_trips?trip_id=eq.${r.trip_id}&operator_id=eq.${operatorId}`,
      {
        method: 'PATCH',
        headers: pgHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ ended_at: endAt, ended_reason: 'auto_stale' }),
      },
    );
    if (!patch.ok) throw new Error(`stale close ${patch.status}`);
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
      // Five minutes, not ten. While this was a warning, staleness cost a
      // dialog; now that it is a block, staleness locks the boat out until
      // the row ages out, and five missed beats already means that phone is
      // gone. Halving the window halves the worst wrongful lockout.
      const FRESH_MS = 5 * 60 * 1000;
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
        // Same moment, same swallowed failure, wider net. The orphan close
        // above is scoped to THIS boat, so a different boat of the same
        // operator that went quiet and never broadcast again would stay open
        // forever. This catches those. Swallowed for the same reason: a stale
        // row is untidy, a boat that drops off the live map is not.
        try {
          const stale = await closeStaleBroadcasts(operatorId, Date.now());
          if (stale) console.log(`live-trip: closed ${stale} stale broadcast(s) for operator ${operatorId}`);
        } catch (e) {
          console.error('live-trip: closing stale broadcasts failed:', e.message);
        }
      }
      const incoming = cleanPoints(req.body.points);

      /*
        A broadcast the server parked stays parked, whatever the phone does
        next. Ordinarily a heartbeat reopens a closed broadcast, which is
        right for a crew who ended a trip and carried on logging, but it is
        exactly wrong here: the phone that will not stop is the reason the
        row was closed, and it will keep beating from a car park, a car, or a
        kitchen table. A boat genuinely heading back out is a new departure
        and gets a new trip, which is what the app already does.

        Writes nothing at all: leaving last_seen_at at the moment the boat
        stopped keeps the record honest and the watchdog's resurrection
        signal quiet.
      */
      if (existing && existing.ended_at && existing.ended_reason === 'auto_stationary') {
        return res.status(200).json({ ok: true, autoEnded: true, reason: 'stationary' });
      }

      const track = thinTrack(((existing && existing.track) || []).concat(incoming));
      // The berth is only looked up once a boat has actually been sitting for
      // the shortest window that could close it, so a vessel under way never
      // pays for it, and the answer is cached for an hour besides.
      const nowMs = Date.parse(nowISO);
      let parked = null;
      if (existing && stoppedForMs(track, nowMs) >= DOCK_WINDOW_MS) {
        parked = parkedSince(track, existing, nowMs, await operatorDock(operatorId));
      }
      if (parked) {
        await upsertRow(Object.assign({
          trip_id: tripId,
          operator_id: operatorId,
          track,
          ended_at: parked,
          ended_reason: 'auto_stationary',
        }, boatFields(req.body)));
        console.log(`live-trip: auto-ended ${tripId}, stationary since ${parked}`);
        return res.status(200).json({ ok: true, autoEnded: true, reason: 'stationary', endedAt: parked });
      }

      await upsertRow(Object.assign({
        trip_id: tripId,
        operator_id: operatorId,
        last_seen_at: nowISO,
        track,
        ended_at: null,
        ended_reason: null,
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
        // An already auto-ended broadcast keeps the time it actually went
        // still; the captain tapping End Trip afterwards is agreeing with
        // the server, not adding twenty minutes at the dock to the record.
        if (existing.ended_at && existing.ended_reason === 'auto_stationary') {
          return res.status(200).json({ ok: true, alreadyEnded: true });
        }
        await upsertRow({ trip_id: tripId, operator_id: operatorId, ended_at: nowISO, ended_reason: null });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('live-trip error:', err.message);
    return res.status(500).json({ error: 'Live update failed' });
  }
};
