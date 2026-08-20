/*
  One Happywhale individual record turned into the row the app's whale card
  reads.

  Extracted from api/whale-log.js when Whale Search arrived, because the
  search results open the SAME card as the whale log and the two normalisers
  drifting apart would mean a whale that reads one way when you find it and
  another way when you look it up later. The log adds its own fields on top
  (which of our trips saw it, our own frame of it); everything here is what
  the catalogue says about the animal itself.
*/

/* "Willy (Nicaragua)" -> "Willy". The qualifier means nothing on a mic. */
function cleanName(nickname) {
  return (nickname || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/*
  Place names, de-stuttered. The catalogue spells one place five ways
  ("Moss Landing", "Moss Landing, CA", "Moss Landing, California"), and the
  first field screenshot read like a skipping record. When one name is a
  prefix of another the shorter wins: same place, cleaner to say out loud.
*/
function tidyPlaces(encs) {
  const raw = [...new Set(
    encs.map(e => (e.location || e.region || '').trim()).filter(Boolean)
  )].sort((a, b) => a.length - b.length);
  const out = [];
  for (const cand of raw) {
    const norm = cand.toLowerCase();
    if (!out.some(kept => norm.startsWith(kept.toLowerCase()))) out.push(cand);
  }
  return out;
}

/*
  The catalogue's reference photo, for matching by eye: the avatar is
  Happywhale's chosen representative shot, and an encounter photo stands in
  when an individual has none.

  Relayed through our own domain. Happywhale's CDN sends no CORS headers, so
  a direct URL cannot be cached for offline (a tainted canvas throws on
  toDataURL) and loads slowly at sea. See api/whale-photo.js.
*/
function catalogPhotoUrl(ind, encs) {
  let url = (ind.avatar && ind.avatar.url) || null;
  if (!url) {
    const withMedia = encs.find(e => e && e.media && e.media.url);
    url = withMedia ? withMedia.media.url : null;
  }
  return url ? '/api/whale-photo?u=' + encodeURIComponent(url) : null;
}

/*
  record is the hwx individual response: { individual, encs }. Returns null
  when there is no individual id, which is the one field everything else
  hangs off.
*/
function rowFromRecord(record) {
  const ind = (record && record.individual) || {};
  const id = ind.id;
  if (!id) return null;
  const encs = ((record && record.encs) || []).filter(e => e && e.date);
  const dates = encs.map(e => String(e.date)).sort();

  return {
    individualId: id,
    photoUrl: catalogPhotoUrl(ind, ((record && record.encs) || [])),
    name: cleanName(ind.nickname) || ind.primaryId || `Whale ${id}`,
    nickname: cleanName(ind.nickname) || null,
    // The raw nickname kept when it carries information the clean one drops,
    // which is where calf relationships live ("2023-2024 calf of CRC-19489").
    fullNickname: (ind.nickname || '').trim() || null,
    catalogId: ind.primaryId || null,
    species: ind.species || null,
    sex: ind.sex || null,
    encountersOnRecord: encs.length,
    firstIdentified: dates[0] || null,
    latestOnRecord: dates[dates.length - 1] || null,
    places: tidyPlaces(encs).slice(0, 5),
    happywhaleUrl: `https://happywhale.com/individual/${id}`,
  };
}

module.exports = { cleanName, tidyPlaces, catalogPhotoUrl, rowFromRecord };
