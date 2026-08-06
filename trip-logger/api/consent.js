// POST /api/consent — the crew member just ticked the box.
//
// Records that the authenticated user accepted the current version of the
// location-tracking disclosure. The version is server-side truth: the
// client does not get to say which wording it showed, because a stale tab
// accepting an old version would quietly punch a hole in the record. If the
// client's version does not match, the response says so and the app shows
// the current wording instead.

const { authenticate } = require('../lib/auth');
const { CONSENT_VERSION, recordConsent } = require('../lib/consent');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req, res, { requireOperator: false });
  if (!auth) return;

  const clientVersion = req.body && req.body.version;
  if (clientVersion !== CONSENT_VERSION) {
    return res.status(409).json({
      error: 'Consent wording has changed. Reload to see the current version.',
      version: CONSENT_VERSION,
    });
  }

  const ok = await recordConsent(auth.user.id, auth.operatorId || null);
  if (!ok) return res.status(500).json({ error: 'Could not record consent. Try again.' });

  return res.status(200).json({ success: true, version: CONSENT_VERSION });
};
