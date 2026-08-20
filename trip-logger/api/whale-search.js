/*
  POST /api/whale-search  { image: "<base64 jpeg>" }

  Whale Search: the naturalist photographs the back of their camera and this
  answers "which animal is this?" while they are still looking at it, instead
  of the automatic tagging that happens hours later after a send.

  WHY THIS HOP EXISTS. The Happywhale credentials and client live in
  Flukesend, deliberately: per operator organisation keys are the agreed
  architecture once Happywhale grants them, and credentials copied into a
  second Vercel project would be two places to rotate. So this endpoint
  authenticates the captain, forwards the photo to Flukesend once, and
  normalises what comes back into the same row shape the whale card already
  reads. The slow leg, the phone's upload on marine signal, happens once;
  the second hop is server to server.

  Nothing is recorded. A search is a question, not a sighting: no row in
  happywhale_matches, nothing in the whale log, nothing on a guest's card.
  Slater can search the same fluke ten times and the record is unchanged.
*/

const { authenticate } = require('../lib/auth');
const { rowFromRecord } = require('../lib/whale-row');

const FLUKESEND_ORIGIN = process.env.FLUKESEND_ORIGIN || 'https://www.flukesend.com';
// Identify plus one catalogue lookup per candidate, over a boat connection.
const UPSTREAM_TIMEOUT_MS = 55000;
const MAX_BODY_BYTES = 14 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req, res);
  if (!auth) return;

  const image = req.body && typeof req.body.image === 'string' ? req.body.image : '';
  if (!image) return res.status(400).json({ error: 'No photo received.' });
  if (image.length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'That photo is too large. Try again.' });
  }

  // The caller's own token is forwarded: Flukesend verifies it against the
  // same Supabase project and resolves the operator itself, so this hop
  // cannot widen who is allowed to spend Happywhale quota.
  const token = String(req.headers.authorization || '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(`${FLUKESEND_ORIGIN}/api/whale-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token },
      body: JSON.stringify({ image }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === 'AbortError';
    console.error('whale-search upstream failed:', e && e.message);
    return res.status(504).json({
      error: timedOut ? 'The search took too long. Try again with more signal.' : 'Could not reach the matcher.',
    });
  }
  clearTimeout(timer);

  let payload;
  try {
    payload = await upstream.json();
  } catch (e) {
    return res.status(502).json({ error: 'The matcher gave an unreadable answer.' });
  }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: payload.error || 'Search failed.' });
  }

  /*
    Each candidate becomes the same row the whale log produces, so tapping one
    opens the existing whale card with no second renderer to keep in step. The
    score rides along on top: it is the one thing a search knows that the log
    does not.
  */
  const candidates = (payload.candidates || []).map((c) => {
    const row = rowFromRecord(c.individual);
    if (!row) {
      // A catalogue lookup that failed still leaves a real match worth showing.
      return {
        individualId: c.individualId || null,
        name: c.catalogId || (c.individualId ? `Whale ${c.individualId}` : 'Unknown'),
        photoUrl: null,
        catalogId: c.catalogId || null,
        species: c.species || null,
        score: typeof c.score === 'number' ? c.score : null,
        detailUnavailable: true,
        seenByUs: [],
        timesSeenByUs: 0,
      };
    }
    row.score = typeof c.score === 'number' ? c.score : null;
    // The card prints "you saw this whale on..." from these; a searched whale
    // has no history with us unless the log says so, and this endpoint does
    // not claim one.
    row.seenByUs = [];
    row.timesSeenByUs = 0;
    row.fact = null;
    return row;
  });

  return res.status(200).json({ candidates });
};
