// GET /api/capture-qr — the operator's guest sign-up QR codes, for showing
// on the boat.
//
// Crews walk the deck in the last half hour of a trip holding a phone out so
// guests can scan and leave their email. That code already exists: Flukesend
// mints one standing capture link per operator, plus one per boat once they
// run more than one, and prints them on cards. This serves the same codes to
// the boat app so the crew does not need a laminated card, and so the code
// shown is automatically the one for the boat they are actually on.
//
// Rendered here as PNG data URLs rather than handing over the URL, because
// the app caches the response and shows it OFFLINE: they are miles out when
// they need it, and a QR library fetched at display time would never load.
// Cached client side, so this endpoint is hit about once per login.
//
// Colors match Flukesend's printed cards and the live map's boat tracks (the
// same palette, indexed by the same boat order), so a boat is one color
// everywhere a guest or a captain sees it.
//
// Read only: unlike Flukesend's settings page this never creates a missing
// link, so two apps can't race to mint one. An operator with no code yet
// gets an empty list and a message pointing at Flukesend.

const QRCode = require('qrcode');
const { authenticate } = require('../lib/auth');

// Same array as Flukesend's BOAT_QR_COLORS and the widget's live boat colors.
const BOAT_COLORS = ['#1f3a8a', '#0f5a4e', '#8a2b3a', '#5b3a8a', '#7a4a12', '#245a3a'];
const CAPTURE_APEX = 'flukesend.com';
const CANONICAL_ORIGIN = 'https://www.flukesend.com';

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
    const [ops, links, boats] = await Promise.all([
      pgGet(`operators?id=eq.${operatorId}&select=capture_subdomain&limit=1`),
      pgGet(`capture_links?operator_id=eq.${operatorId}&select=token,boat_id`),
      pgGet(`boats?operator_id=eq.${operatorId}&select=id,name&order=sort_order.asc,created_at.asc`),
    ]);

    // The printed cards carry the operator's canonical capture origin, so the
    // on-screen code must resolve to exactly the same URL.
    const sub = ops && ops[0] && (ops[0].capture_subdomain || '').trim();
    const origin = sub ? `https://${sub}.${CAPTURE_APEX}` : CANONICAL_ORIGIN;

    const rows = links || [];
    const boatList = boats || [];
    const colorByBoatId = {};
    boatList.forEach((b, i) => { colorByBoatId[b.id] = BOAT_COLORS[i % BOAT_COLORS.length]; });
    const nameByBoatId = {};
    boatList.forEach(b => { nameByBoatId[b.id] = b.name; });

    const png = (url, color) => QRCode.toDataURL(url, {
      margin: 1,
      width: 640,
      errorCorrectionLevel: 'M',
      color: { dark: color, light: '#ffffff' },
    });

    // Operator wide code: the catch-all, and the only code a single boat
    // operator ever needs.
    const wide = rows.find(r => !r.boat_id);
    const operatorQr = wide
      ? { url: `${origin}/j/${wide.token}`, data_url: await png(`${origin}/j/${wide.token}`, '#55606a') }
      : null;

    // Per boat codes, in roster order so the colors line up with the cards.
    const perBoat = [];
    for (const b of boatList) {
      const link = rows.find(r => r.boat_id === b.id);
      if (!link) continue;
      const url = `${origin}/j/${link.token}`;
      perBoat.push({
        boat_id: b.id,
        boat_name: nameByBoatId[b.id] || null,
        color: colorByBoatId[b.id],
        url,
        data_url: await png(url, colorByBoatId[b.id]),
      });
    }

    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).json({ operator: operatorQr, boats: perBoat });
  } catch (err) {
    console.error('capture-qr error:', err.message);
    return res.status(500).json({ error: 'Could not build sign-up codes' });
  }
};
