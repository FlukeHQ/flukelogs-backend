// POST /api/app-open — the boat app announcing it was opened.
//
// Exists because operator adoption was invisible. Discovery and Pacwhale
// each sent once and evaporated, and nobody could see whether either ever
// opened anything again; when Latitude Encounters joined, "did she try the
// app yet" was unanswerable. Now it is a glance at the admin card.
//
// The app calls this once per half day at most (throttled client side in
// localStorage), fire and forget: a failure here must never delay the app
// booting, so the client does not await the response and this handler does
// not do anything worth waiting for.
//
// Platform from the user agent, same three way split the trip attribution
// uses: the Capacitor shells present the platform webview's own UA, so
// Android/iPhone markers identify the build and anything else is a browser.
const { authenticate } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req, res);
  if (!auth) return;

  const ua = String(req.headers['user-agent'] || '');
  let platform = 'web';
  if (/Android/i.test(ua)) platform = 'android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'ios';

  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/app_opens`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        operator_id: auth.operatorId,
        user_id: auth.user && auth.user.id ? auth.user.id : null,
        platform,
      }),
    });
    if (!r.ok) console.error('app-open insert failed:', r.status);
  } catch (e) {
    console.error('app-open failed:', e.message);
  }
  // 204 whatever happened: the app is booting and owes this call nothing.
  return res.status(204).end();
};
