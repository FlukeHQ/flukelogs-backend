// POST /api/widget-event — anonymous traffic beacon for the public widget.
//
// Records widget page views and Book Now clicks into widget_events
// (flukesend migration 0068) so "the widget drives bookings" becomes a
// number instead of a belief. The widget fires one 'view' per page load and
// one 'book_click' per Book Now tap, via fetch keepalive from
// sightings-widget.html.
//
// Same tenant-resolution rule as widget-data: the client sends the ?op=
// slug, never an operator_id, and the server resolves it. Unknown slug is a
// silent 204 (a beacon has no user to show an error to, and a probe learns
// nothing about which slugs exist).
//
// Unauthenticated on purpose: the widget is a public page, so its beacon is
// public too. That means the counts are directional and bot-inflatable;
// widget_events' table comment says the same. Payloads are whitelisted to
// two kinds and two sources, so the worst a spammer can do is inflate a
// counter that was never billing-grade.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const KINDS = ['view', 'book_click'];
const SOURCES = ['live_banner', 'cta_strip'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const slug = typeof body.op === 'string' ? body.op.trim().toLowerCase() : '';
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const source = typeof body.source === 'string' && SOURCES.includes(body.source)
      ? body.source
      : null;

    // Bad shape gets a 204 too: nothing retries a beacon, and a 4xx would
    // only show up as console noise on every operator's embed if a future
    // widget edit drifts. The whitelist above is the real gate.
    if (!slug || !KINDS.includes(kind)) return res.status(204).end();

    const opRes = await fetch(
      `${SUPABASE_URL}/rest/v1/operators?slug=eq.${encodeURIComponent(slug)}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!opRes.ok) return res.status(204).end();
    const ops = await opRes.json();
    const operatorId = Array.isArray(ops) && ops[0] ? ops[0].id : null;
    if (!operatorId) return res.status(204).end();

    await fetch(`${SUPABASE_URL}/rest/v1/widget_events`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ operator_id: operatorId, kind, source }),
    });

    return res.status(204).end();
  } catch (err) {
    // A beacon failure must never surface anywhere a guest can see.
    console.error('widget-event failed:', err.message);
    return res.status(204).end();
  }
};
