// GET /api/widget-stats?op=<slug>            -> species-by-month history
// GET /api/widget-stats?op=<slug>&pins=<scope> -> pins for a scope
//
// The two halves of the widget that should describe an operator's whole
// history instead of whatever happened to be loaded.
//
// STATS. One row per month per species: trips it was seen on, animals
// counted, and the month's trip total. Computed in Postgres by
// widget_species_months (migration 0075), so it stays months x species in
// size however many sightings accumulate. The widget turns this into the
// odds legend for any scope (this month, a year, lifetime) and the species
// panel ("seen on 4 of 14 trips in August").
//
// PINS. scope is YYYY-MM, YYYY, or "all". Returns the bare coordinates for
// every GPS-stamped sighting in the scope: [lat, lng, species, trip_date,
// trip_id]. A month's pins stay small forever; a lifetime's pins grow with
// the operator, which is why lifetime is a deliberate click, not the
// default, and why pins are fetched per scope rather than shipped with the
// feed. Nothing else about a trip travels here.
//
// Both honour show_map_on_widget: an operator who hides their map gets
// stats (no location in them) and an empty pins list.
//
// Cached at the edge for ten minutes. History changes once a trip is
// logged, not by the second, and the first load is the one that matters on
// a phone on someone else's website.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

async function pgGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`pg ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pgRpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${await res.text()}`);
  return res.json();
}

function scopeRange(scope) {
  if (/^\d{4}-\d{2}$/.test(scope)) {
    const [y, m] = scope.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${scope}-01`, to: `${scope}-${String(last).padStart(2, '0')}` };
  }
  if (/^\d{4}$/.test(scope)) return { from: `${scope}-01-01`, to: `${scope}-12-31` };
  return null; // all
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = req.query && req.query.op;
  if (!slug) return res.status(200).json({ months: {}, first_trip: null, pins: [] });

  try {
    const ops = await pgGet(
      `operators?slug=eq.${encodeURIComponent(String(slug))}&select=id,show_map_on_widget&limit=1`
    );
    const operator = ops && ops[0];
    if (!operator) return res.status(200).json({ months: {}, first_trip: null, pins: [] });
    const showMap = operator.show_map_on_widget !== false;

    const pinsScope = req.query && req.query.pins ? String(req.query.pins) : null;
    if (pinsScope) {
      if (!showMap) return res.status(200).json({ pins: [] });
      const range = scopeRange(pinsScope);
      const dateFilter = range ? `&trip_date=gte.${range.from}&trip_date=lte.${range.to}` : '';
      // PostgREST's hard row cap means a lifetime scope pages.
      const PAGE = 1000;
      const pins = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await pgGet(
          `sightings?operator_id=eq.${operator.id}${dateFilter}` +
          `&lat=not.is.null&lng=not.is.null` +
          `&select=lat,lng,species,trip_date,trip_id` +
          `&order=trip_date.desc&limit=${PAGE}&offset=${offset}`
        );
        if (!page || !page.length) break;
        for (const p of page) pins.push([p.lat, p.lng, p.species, p.trip_date, p.trip_id]);
        if (page.length < PAGE) break;
      }
      return res.status(200).json({ pins });
    }

    const rows = await pgRpc('widget_species_months', { p_slug: String(slug) });
    // { "2026-08": { trips: 14, species: { "Humpback Whale": { trips: 14, animals: 124 }, ... } } }
    const months = {};
    let firstTrip = null;
    for (const r of rows || []) {
      if (!months[r.ym]) months[r.ym] = { trips: r.month_trips, species: {} };
      months[r.ym].species[r.species] = { trips: r.trips, animals: r.animals };
      if (!firstTrip || r.ym < firstTrip) firstTrip = r.ym;
    }
    return res.status(200).json({ months, first_trip: firstTrip });
  } catch (err) {
    console.error('widget-stats error:', err.message);
    return res.status(200).json({ months: {}, first_trip: null, pins: [] });
  }
};
