// GET /api/whale-photo?u=<happywhale media url>
//
// Same-origin relay for Happywhale catalogue photos. Their media CDN sends
// no CORS headers, which broke the whale card twice over: the offline photo
// cache failed silently (a cross-origin canvas is tainted, toDataURL throws),
// and every card open re-downloaded the photo from their CDN, which is the
// visible pause on a boat connection. Serving the bytes from our own domain
// fixes both, and Vercel's CDN caches the copy so repeat loads never leave
// the edge.
//
// Restricted to happywhale.com hosts on purpose: this must never become an
// open proxy. No auth, matching the public nature of catalogue photos, and
// because an Authorization header would defeat the CDN cache.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const raw = req.query.u;
  let url;
  try {
    url = new URL(String(raw));
  } catch (e) {
    return res.status(400).json({ error: 'Bad url' });
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (host !== 'happywhale.com' && !host.endsWith('.happywhale.com'))) {
    return res.status(400).json({ error: 'Only Happywhale photos' });
  }

  try {
    const upstream = await fetch(url.toString(), { redirect: 'follow' });
    if (!upstream.ok) return res.status(502).json({ error: `Upstream ${upstream.status}` });
    const type = upstream.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return res.status(502).json({ error: 'Not an image' });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', type);
    // Catalogue photos are effectively immutable per URL; a day in the
    // browser, a year at the edge.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000');
    return res.status(200).send(bytes);
  } catch (e) {
    console.error('whale-photo relay failed:', e.message);
    return res.status(502).json({ error: 'Could not fetch photo' });
  }
};
