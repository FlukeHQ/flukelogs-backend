// GET /api/widget-data?op=<slug> — public data feed for the sightings widget.
//
// WHY THIS EXISTS (tenant isolation):
//   The widget used to read the `sightings` and `trip_audio` tables directly
//   from the browser with the anon key, under an RLS policy of USING (true).
//   That made the per-operator scoping client-side only: anyone holding the
//   anon key could read EVERY operator's rows (including GPS) regardless of
//   the ?op= slug. This endpoint moves that read server-side behind the
//   service role and scopes it to one operator, so the anon SELECT policies
//   on sightings/trip_audio can be removed (see db/migrations/0018).
//
//   It also makes the `show_map_on_widget = false` opt-out REAL: when an
//   operator has hidden their map, lat/lng are stripped here, server-side,
//   instead of merely being hidden by widget JavaScript.
//
// Operator is resolved from the `?op=<slug>` query param against the
// operators table — the client never supplies the operator_id, so it can't
// ask for another operator's rows. Unknown/missing slug => empty feed.
//
// Shapes match exactly what sightings-widget.html's fetchSightings() and
// fetchTripAudio() previously got from PostgREST, so the widget is a drop-in
// swap:
//   { sightings: [ {trip_id,trip_part,trip_date,sighting_time,species,count,
//                    lat,lng,depth_meters,created_at}, … ],
//     audio:     [ {trip_id,audio_url,duration_seconds,play_count}, … ],
//     tracks:    { <trip_id>: [ {lat,lng,t}, … ], … },
//     show_map_on_widget: <bool> }
//
// `tracks` is the continuous GPS breadcrumb per trip (Phase 2). When
// show_map_on_widget = false, tracks is empty AND lat/lng are stripped from
// sightings — same opt-out applies to both.
//
// `live` is the in-progress-trip block (migration 0021). The app broadcasts
// exact points into live_trips via /api/live-trip; THIS endpoint is the only
// public reader, and it applies the operator's privacy transform before
// anything leaves the server:
//   - delay: only track points older than live_delay_minutes are published,
//     so the shown position always trails the boat (default 0.5 = 30s;
//     numeric since migration 0023, so sub-minute values are fine);
//   - fuzz:  published lat/lng are snapped to a live_fuzz_deg grid
//     (0.01 deg ~= 0.6 nm), so the exact spot is never recoverable.
// The status line ("watching X" / "searching") carries no location and is
// served whenever the live layer is on; position/track additionally require
// show_map_on_widget. `?live=1` returns just { live } — the widget polls
// that cheaply without re-pulling the whole feed.

const FEED_LIMIT = 100;

// A broadcast whose heartbeat stopped this long ago is treated as over —
// covers lost signal / a trip ended without a clean End Trip tap, so the
// widget never sits on a stale "currently watching."
const LIVE_STALE_MINUTES = 10;
// A sighting older than this reads as "searching," not "watching."
const WATCHING_WINDOW_MINUTES = 15;

async function pgGet(pathAndQuery) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

// Builds the public `live` block from the operator's active broadcasts.
// Returns null when the layer is off, nothing is live, or every heartbeat went
// stale. All delay/fuzz math happens here — raw live_trips rows never leave.
//
// An operator can have several boats broadcasting at once (two departures on
// the water together), so the block carries a `boats` array with one entry
// per live broadcast. The legacy single-boat fields stay on the block itself,
// mirroring boats[0], so widget pages loaded before this shape existed keep
// working — and with one boat out the response is identical to what it
// always was.
async function getLiveBlock(operator, showMap) {
  if (!operator.live_widget_enabled) return null;

  const allRows = await pgGet(
    `live_trips?operator_id=eq.${operator.id}&ended_at=is.null` +
    `&select=started_at,last_seen_at,status_species,status_at,track,sightings,boat_id,boat_name` +
    `&order=last_seen_at.desc&limit=10`
  );
  if (!allRows || !allRows.length) return null;

  const now = Date.now();
  const rows = allRows.filter(r => now - Date.parse(r.last_seen_at) <= LIVE_STALE_MINUTES * 60000);
  if (!rows.length) return null;

  // Per-boat color, same assignment as the FlukeSend boat QR cards: one
  // palette color per roster boat in boat order, so the live line matches
  // the color crews already know from the boat's QR code. Only resolved
  // when a broadcasting client identified its boat; older clients get null
  // and the widget renders them in the standard single-boat red.
  const BOAT_COLORS = ['#1f3a8a', '#0f5a4e', '#8a2b3a', '#5b3a8a', '#7a4a12', '#245a3a'];
  const colorByBoatId = {};
  if (rows.some(r => r.boat_id)) {
    const roster = await pgGet(
      `boats?operator_id=eq.${operator.id}&select=id&order=sort_order.asc,created_at.asc&limit=24`
    );
    (roster || []).forEach((b, i) => { colorByBoatId[b.id] = BOAT_COLORS[i % BOAT_COLORS.length]; });
  }

  const delayMin = Math.max(0, +operator.live_delay_minutes || 0);
  // Publish only points that have aged past the delay, snapped to the fuzz
  // grid. Consecutive points landing in the same grid cell collapse to one,
  // so the polyline stays a path instead of a stutter of duplicates.
  const fuzz = +operator.live_fuzz_deg > 0 ? +operator.live_fuzz_deg : 0.01;
  const snap = v => +(Math.round(v / fuzz) * fuzz).toFixed(6);
  const cutoff = now - delayMin * 60000;

  const boats = [];
  for (const row of rows) {
    const boat = {
      started_at: row.started_at,
      species: row.status_species || null,
      // When the species is fresh the boat is "watching"; once it ages out,
      // species_at lets the widget say when it was last spotted instead of
      // reverting to a bare "searching."
      species_at: row.status_at || null,
      watching: !!(row.status_species && row.status_at &&
        now - Date.parse(row.status_at) <= WATCHING_WINDOW_MINUTES * 60000),
      boat_name: row.boat_name || null,
      color: (row.boat_id && colorByBoatId[row.boat_id]) || null,
      position: null,
      track: [],
      sightings: [],
    };

    if (showMap) { // status only otherwise — same GPS opt-out as sightings
      const points = Array.isArray(row.track) ? row.track : [];
      for (const p of points) {
        const t = Date.parse(p && p.t);
        if (!Number.isFinite(t) || t > cutoff) continue;
        if (!Number.isFinite(+p.lat) || !Number.isFinite(+p.lng)) continue;
        const pt = { lat: snap(+p.lat), lng: snap(+p.lng), t: p.t };
        const prev = boat.track[boat.track.length - 1];
        if (prev && prev.lat === pt.lat && prev.lng === pt.lng) { prev.t = pt.t; continue; }
        boat.track.push(pt);
      }
      boat.position = boat.track[boat.track.length - 1] || null;

      // Mid-trip sightings become live dots — same delay + fuzz as the boat,
      // since each dot says where the animals are right now.
      for (const s of (Array.isArray(row.sightings) ? row.sightings : [])) {
        const t = Date.parse(s && s.t);
        if (!Number.isFinite(t) || t > cutoff) continue;
        if (!Number.isFinite(+s.lat) || !Number.isFinite(+s.lng)) continue;
        boat.sightings.push({
          species: s.species || null,
          count: Number.isFinite(+s.count) ? +s.count : null,
          lat: snap(+s.lat),
          lng: snap(+s.lng),
          t: s.t,
        });
      }
    }
    boats.push(boat);
  }
  if (!boats.length) return null;

  return Object.assign({}, boats[0], {
    active: true,
    delay_minutes: delayMin,
    boats,
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Same freshness posture as the widget HTML — sightings land continuously
  // and the feed should reflect new trips without a stale-cache delay.
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const liveOnly = !!(req.query && req.query.live);
  const empty = liveOnly
    ? { live: null }
    : { sightings: [], audio: [], photos: [], live: null, show_map_on_widget: true };

  try {
    const slug = req.query && req.query.op;
    if (!slug) { res.status(200).json(empty); return; }

    // Resolve operator server-side from the public slug. We only need the id,
    // the map toggle, and the live-layer knobs here.
    const ops = await pgGet(
      `operators?slug=eq.${encodeURIComponent(String(slug))}` +
      `&select=id,show_map_on_widget,live_widget_enabled,live_delay_minutes,live_fuzz_deg&limit=1`
    );
    const operator = ops && ops[0];
    if (!operator || !operator.id) { res.status(200).json(empty); return; }

    const operatorId = operator.id;
    const showMap = operator.show_map_on_widget !== false;

    // Poll fast-path: the widget refreshes the live block every minute; skip
    // the full feed queries and return just { live }.
    if (liveOnly) {
      res.status(200).json({ live: await getLiveBlock(operator, showMap) });
      return;
    }

    const [sightings, audio, photos, live] = await Promise.all([
      pgGet(
        `sightings?operator_id=eq.${operatorId}` +
        `&select=trip_id,trip_part,trip_date,sighting_time,species,count,lat,lng,depth_meters,created_at` +
        `&order=trip_date.desc,created_at.desc&limit=${FEED_LIMIT}`
      ),
      pgGet(
        `trip_audio?operator_id=eq.${operatorId}` +
        `&select=trip_id,audio_url,duration_seconds,play_count` +
        `&order=trip_date.desc&limit=${FEED_LIMIT}`
      ),
      // Gallery photos per trip. Not location data, so returned regardless of
      // the map opt-out. Ordered so each trip's photos arrive in gallery order.
      pgGet(
        `trip_photos?operator_id=eq.${operatorId}` +
        `&select=id,trip_id,photo_url,sort_order` +
        `&order=trip_date.desc,sort_order.asc,created_at.asc&limit=600`
      ),
      getLiveBlock(operator, showMap),
    ]);

    // Enforce the GPS opt-out server-side: when the operator hides their map,
    // never send coordinates to the browser at all.
    const sightingRows = (sightings || []).map(s => {
      if (showMap) return s;
      const { lat, lng, ...rest } = s;
      return rest;
    });

    // Continuous breadcrumb tracks per trip. Only fetched when the operator
    // exposes their map (same opt-out as lat/lng on sightings). Scoped by the
    // exact trip_ids that came back in `sightings` — never returns tracks for
    // trips that aren't already in this feed.
    let tracks = {};
    if (showMap) {
      const tripIds = [...new Set(sightingRows.map(s => s.trip_id).filter(Boolean))];
      if (tripIds.length) {
        const idList = tripIds.map(id => `"${id}"`).join(',');
        // PostgREST enforces a hard server-side row cap (~1000) that silently
        // overrides any &limit=. A single request therefore truncates: ordered
        // by trip_id, the lowest-sorting trips eat the whole budget and every
        // later trip (incl. the most recent) comes back with ZERO track points
        // and falls back to the straight pin-to-pin line on the widget — even
        // though its real GPS breadcrumb exists. Page through with offset until
        // a short page marks the end so every trip in the feed gets its track.
        const PAGE = 1000;
        for (let offset = 0; ; offset += PAGE) {
          const page = await pgGet(
            `trip_track?operator_id=eq.${operatorId}` +
            `&trip_id=in.(${idList})` +
            `&select=trip_id,lat,lng,recorded_at` +
            `&order=trip_id.asc,recorded_at.asc&limit=${PAGE}&offset=${offset}`
          );
          if (!page || page.length === 0) break;
          for (const p of page) {
            if (!tracks[p.trip_id]) tracks[p.trip_id] = [];
            tracks[p.trip_id].push({ lat: p.lat, lng: p.lng, t: p.recorded_at });
          }
          if (page.length < PAGE) break;
        }
      }
    }

    // Per-trip roster facts from the boat app (boat name, scheduled
    // departure), keyed by trip_id. Lets the widget tell two same-day trips
    // apart ("Morning · Princess" vs "Morning · Atlantis"). Not location
    // data, so not gated on the map opt-out; trips logged before the roster
    // era (or operators without a roster) simply have no entry.
    let tripMeta = {};
    {
      const tripIds = [...new Set(sightingRows.map(s => s.trip_id).filter(Boolean))];
      if (tripIds.length) {
        const metaRows = await pgGet(
          `logbook_trips?operator_id=eq.${operatorId}` +
          `&trip_id=in.(${tripIds.map(id => `"${id}"`).join(',')})` +
          `&select=trip_id,boat_name,trip_time&limit=${FEED_LIMIT}`
        );
        for (const m of (metaRows || [])) {
          tripMeta[m.trip_id] = { boat_name: m.boat_name || null, trip_time: m.trip_time || null };
        }
      }
    }

    res.status(200).json({
      sightings: sightingRows,
      audio: audio || [],
      photos: photos || [],
      tracks,
      trip_meta: tripMeta,
      live: live || null,
      show_map_on_widget: showMap,
    });
  } catch (err) {
    console.error('widget-data error:', err.message);
    res.status(200).json(empty); // fail soft — widget shows its empty state
  }
};
