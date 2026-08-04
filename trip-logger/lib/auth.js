// Shared authentication helpers for the API endpoints.
//
// Verifies a Supabase JWT against the project's auth server, then resolves
// which operator the user belongs to. Both lookups use the service role key
// so they bypass RLS — endpoints that import this code MUST gate any
// per-operator data access on the returned operatorId.

async function verifyJWT(token) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !token) return null;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.id ? body : null;
  } catch (e) {
    console.error('verifyJWT error:', e.message);
    return null;
  }
}

async function getOperatorIdForUser(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !userId) return null;
  // Membership lives in two tables since the Flukesend merge: operator_users
  // is the logbook's own roster, operator_members is Flukesend's. Checking
  // both means an existing Flukesend login — a Princess photographer, say —
  // opens the boat app with zero provisioning. operator_users wins when a
  // user somehow appears in both.
  const tables = ['operator_users', 'operator_members'];
  for (const table of tables) {
    try {
      const res = await fetch(
        `${url}/rest/v1/${table}?user_id=eq.${userId}&select=operator_id&limit=1`,
        { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
      );
      if (!res.ok) continue;
      const rows = await res.json();
      if (rows[0] && rows[0].operator_id) return rows[0].operator_id;
    } catch (e) {
      console.error(`getOperatorIdForUser (${table}) error:`, e.message);
    }
  }
  return null;
}

// Is the boat app part of what this operator bought? The Flukesend plan does
// not include Flukelogs, but membership alone opens the app (see
// getOperatorIdForUser), so without this check a Flukesend-only operator uses
// a product they have not paid for. Missing column or a failed read returns
// true: a broken entitlement lookup must never lock a working captain off the
// water mid-trip. Migration 0049 backfilled every existing operator to true.
async function isLogbookEnabled(operatorId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !operatorId) return true;
  try {
    const res = await fetch(
      `${url}/rest/v1/operators?id=eq.${operatorId}&select=logbook_enabled&limit=1`,
      { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
    );
    if (!res.ok) return true;
    const rows = await res.json();
    if (!rows[0] || rows[0].logbook_enabled === undefined) return true;
    return rows[0].logbook_enabled !== false;
  } catch (e) {
    console.error('isLogbookEnabled error:', e.message);
    return true;
  }
}

async function getUserProfile(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !userId) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/user_profiles?user_id=eq.${userId}&select=is_super_admin&limit=1`,
      { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch (e) {
    console.error('getUserProfile error:', e.message);
    return null;
  }
}

// Verifies the bearer token, resolves operator_id, and returns
// { user, operatorId, isSuperAdmin } — or null after writing a 401/403 to
// res. Caller should `return` immediately on null.
//
// Pass { requireOperator: false } if the endpoint is callable by a super
// admin who isn't bound to an operator (e.g., admin portal endpoints).
async function authenticate(req, res, opts = {}) {
  const requireOperator = opts.requireOperator !== false;

  const header = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization bearer token' });
    return null;
  }
  const user = await verifyJWT(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }

  const [operatorId, profile] = await Promise.all([
    getOperatorIdForUser(user.id),
    getUserProfile(user.id),
  ]);
  const isSuperAdmin = !!(profile && profile.is_super_admin);

  if (requireOperator && !operatorId) {
    res.status(403).json({ error: 'User is not linked to any operator' });
    return null;
  }

  // Plan gate. Super admins are exempt so support can always get in, and the
  // code is distinct from every other 403 so the app can show a plan message
  // instead of a generic sign-in failure.
  if (operatorId && !isSuperAdmin && !(await isLogbookEnabled(operatorId))) {
    res.status(403).json({
      error: 'Flukelogs is not included in this operator\'s plan.',
      code: 'logbook_not_enabled',
    });
    return null;
  }

  return { user, operatorId, isSuperAdmin };
}

// Convenience wrapper for admin endpoints. Returns the auth context only if
// the user is a super admin; writes 403 otherwise.
async function authenticateAsSuperAdmin(req, res) {
  const auth = await authenticate(req, res, { requireOperator: false });
  if (!auth) return null;
  if (!auth.isSuperAdmin) {
    res.status(403).json({ error: 'Super admin only' });
    return null;
  }
  return auth;
}

module.exports = { verifyJWT, getOperatorIdForUser, getUserProfile, authenticate, authenticateAsSuperAdmin };
