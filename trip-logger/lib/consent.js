// The crew location-tracking disclosure: one version constant and the two
// database touches, shared by /api/me (has this user accepted?) and
// /api/consent (record that they just did).
//
// Bumping CONSENT_VERSION re-prompts every crew member on their next sign
// in. Do that whenever the wording changes in a way a person would care
// about, and never for typo fixes: each bump interrupts every captain on
// the platform once.

const CONSENT_VERSION = '2026-08';

function pgHeaders() {
  const key = process.env.SUPABASE_SECRET_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

// Whether this user has accepted the CURRENT version. Fails open: if the
// read breaks, the answer is "yes" and the gate stays out of the way. The
// same rule the entitlement gate follows — a broken lookup must never
// strand a working captain — applies double here, because this gate sits in
// front of Start Trip.
async function hasConsented(userId) {
  const url = process.env.SUPABASE_URL;
  if (!url || !userId) return true;
  try {
    const res = await fetch(
      `${url}/rest/v1/crew_consents?user_id=eq.${userId}&version=eq.${CONSENT_VERSION}&select=user_id&limit=1`,
      { headers: pgHeaders() },
    );
    if (!res.ok) return true;
    const rows = await res.json();
    return rows.length > 0;
  } catch (e) {
    console.error('consent lookup failed:', e.message);
    return true;
  }
}

// Records acceptance. Idempotent: accepting twice is a no-op, not an error,
// so a double tap or a retry after a dropped response cannot fail the gate.
async function recordConsent(userId, operatorId) {
  const url = process.env.SUPABASE_URL;
  if (!url || !userId) return false;
  const res = await fetch(`${url}/rest/v1/crew_consents`, {
    method: 'POST',
    headers: { ...pgHeaders(), 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      user_id: userId,
      version: CONSENT_VERSION,
      operator_id: operatorId || null,
    }),
  });
  if (!res.ok) {
    console.error('consent insert failed:', res.status, (await res.text()).slice(0, 200));
    return false;
  }
  return true;
}

module.exports = { CONSENT_VERSION, hasConsented, recordConsent };
