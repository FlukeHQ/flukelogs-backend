// GET /api/whale-log
//
// Every individual whale ever identified on this operator's trips, newest
// sighting first. The naturalist's mic notes: open it on the boat, see that
// the whale the matcher just named has been seen four times this month and
// carries twenty years of history, and tell the guests something true.
//
// The data lives in Flukesend's happywhale_matches table, which is fine and
// intended: the two apps share one database, and this endpoint reads through
// the service role exactly like every other api/*.js here. Matches join to
// deliveries only for the trip date, so the log can say "you last saw this
// whale on July 28" in the operator's own terms.
//
// Grouped per individual, not per photo: three photos of Croc on one trip is
// one sighting of Croc. Each row carries what the record honestly holds and
// nothing more. sex is almost always null in Happywhale's records, and calf
// relationships only exist when the catalogue baked them into the nickname,
// so both appear when present and are absent when not, never invented.
//
// Read only, operator scoped, nothing here can touch a trip or a card.

const { authenticate } = require('../lib/auth');

async function pgGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// "Spike (California)" reads as noise on a mic note; the qualifier is the
// catalogue's disambiguator, not the name. Same strip the guest card does.
function cleanName(nickname) {
  return (nickname || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
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

  try {
    const matches = await pgGet(
      `happywhale_matches?operator_id=eq.${operatorId}&status=eq.matched` +
      `&select=individual,fun_fact,created_at,delivery_id&order=created_at.desc&limit=500`
    );

    // Trip dates for the deliveries these matches came from, one query.
    const deliveryIds = [...new Set(matches.map(m => m.delivery_id).filter(Boolean))];
    const tripDateByDelivery = {};
    if (deliveryIds.length) {
      const deliveries = await pgGet(
        `deliveries?id=in.(${deliveryIds.join(',')})&select=id,trip_datetime`
      );
      for (const d of deliveries) tripDateByDelivery[d.id] = d.trip_datetime || null;
    }

    // One entry per individual. Newer matches come first, so the first row
    // seen for an id supplies the freshest record and fact; later rows only
    // add earlier sighting dates.
    const byId = new Map();
    for (const m of matches) {
      const ind = (m.individual && m.individual.individual) || {};
      const id = ind.id;
      if (!id) continue;
      const seenAt = tripDateByDelivery[m.delivery_id] || m.created_at;

      let row = byId.get(id);
      if (!row) {
        const encs = (m.individual.encs || []).filter(e => e && e.date);
        const dates = encs.map(e => String(e.date)).sort();
        /*
          Place names, de-stuttered. The catalogue spells one place five ways
          ("Moss Landing", "Moss Landing, CA", "Moss Landing, California"),
          and the first field screenshot read like a skipping record. When one
          name is a prefix of another, the shorter wins: it is the same place
          and the cleaner thing to say on a mic.
        */
        const rawPlaces = [...new Set(
          encs.map(e => (e.location || e.region || '').trim()).filter(Boolean)
        )].sort((a, b) => a.length - b.length);
        const places = [];
        for (const cand of rawPlaces) {
          const norm = cand.toLowerCase();
          if (!places.some(kept => norm.startsWith(kept.toLowerCase()))) places.push(cand);
        }
        // The catalogue's reference photo of this animal, for matching by
        // eye: the avatar is Happywhale's chosen representative shot, and an
        // encounter photo stands in when an individual has none.
        let photoUrl = (ind.avatar && ind.avatar.url) || null;
        if (!photoUrl) {
          const withMedia = (m.individual.encs || []).find(e => e && e.media && e.media.url);
          photoUrl = withMedia ? withMedia.media.url : null;
        }
        // Relayed through our own domain: Happywhale's CDN sends no CORS
        // headers, so a direct URL can't be cached for offline (tainted
        // canvas) and loads slowly at sea. See api/whale-photo.js.
        if (photoUrl) photoUrl = '/api/whale-photo?u=' + encodeURIComponent(photoUrl);
        row = {
          individualId: id,
          photoUrl,
          name: cleanName(ind.nickname) || ind.primaryId || `Whale ${id}`,
          nickname: cleanName(ind.nickname) || null,
          // The raw nickname kept when it carries information the clean one
          // drops, which is where calf relationships live when they exist at
          // all ("2023-2024 calf of CRC-19489").
          fullNickname: (ind.nickname || '').trim() || null,
          catalogId: ind.primaryId || null,
          species: ind.species || null,
          sex: ind.sex || null,
          encountersOnRecord: encs.length,
          firstIdentified: dates[0] || null,
          latestOnRecord: dates[dates.length - 1] || null,
          places: places.slice(0, 5),
          fact: m.fun_fact || null,
          happywhaleUrl: `https://happywhale.com/individual/${id}`,
          seenByUs: [],
        };
        byId.set(id, row);
      }
      row.seenByUs.push(seenAt);
    }

    const whales = [...byId.values()].map(w => {
      const seen = w.seenByUs.filter(Boolean).sort();
      return Object.assign(w, {
        timesSeenByUs: w.seenByUs.length,
        firstSeenByUs: seen[0] || null,
        lastSeenByUs: seen[seen.length - 1] || null,
        // The dates themselves, newest first, for the in-app whale card:
        // "you saw this whale Aug 6, Aug 5, Jul 28" is mic material, and the
        // detail screen renders offline from this payload, so the dates have
        // to travel with it.
        seenByUs: seen.slice(-20).reverse(),
      });
    }).sort((a, b) => String(b.lastSeenByUs || '').localeCompare(String(a.lastSeenByUs || '')));

    return res.status(200).json({ whales });
  } catch (e) {
    console.error('whale-log failed:', e.message);
    return res.status(500).json({ error: 'Could not load the whale log' });
  }
};
