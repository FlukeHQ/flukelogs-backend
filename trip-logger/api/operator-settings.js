// GET / PATCH /api/operator-settings
//
// Lets the logged-in operator user read and update their own operator row,
// restricted to the fields explicitly listed in OPERATOR_EDITABLE. Anything
// outside that list (NOAA buoy station, FareHarbor keys, gmail_user
// override, name/slug, etc.) stays super-admin-only and is ignored if it
// shows up in a PATCH body.
//
// Sensitive credentials (Mailchimp API key, Gmail App Password) are NEVER
// returned by GET — the response carries has_X booleans instead. A PATCH
// with an empty string for those fields means "leave it alone," so the
// captain can edit other Settings without re-pasting their secrets.

const { authenticate } = require('../lib/auth');
const { getOperator } = require('../lib/operators');

// Single source of truth for what the operator can edit themselves. Mirror
// of the user's product spec: logo, review link, species list, from email +
// Gmail app password, Mailchimp credentials.
const OPERATOR_EDITABLE = [
  'logo_url',
  'logo_url_email',
  'tagline',
  'review_url',
  'species_list',
  'from_email',
  'gmail_app_password',
  'mailchimp_api_key',
  'mailchimp_audience_id',
  'mailchimp_server_prefix',
  'show_map_on_widget',
  'widget_host_url',
];

// Sensitive fields where an empty-string PATCH means "keep current value."
// The captain types into a masked input, so an empty input is the natural
// "I'm not changing this" signal.
const SECRET_FIELDS = new Set(['mailchimp_api_key', 'gmail_app_password']);

function operatorSettingsView(operator) {
  if (!operator) return null;
  return {
    id:                       operator.id,
    slug:                     operator.slug,
    name:                     operator.name,
    logo_url:                 operator.logo_url,
    logo_url_email:           operator.logo_url_email,
    tagline:                  operator.tagline || null,
    review_url:               operator.review_url,
    species_list:             operator.species_list || [],
    from_email:               operator.from_email,
    has_gmail_app_password:   !!operator.gmail_app_password,
    mailchimp_audience_id:    operator.mailchimp_audience_id,
    mailchimp_server_prefix:  operator.mailchimp_server_prefix,
    has_mailchimp_api_key:    !!operator.mailchimp_api_key,
    show_map_on_widget:       operator.show_map_on_widget !== false,
    widget_host_url:          operator.widget_host_url || null,
    // Read-only here (admin-managed): branded domain serving the widget
    // standalone. Settings uses it to generate the embed snippet's src.
    widget_standalone_url:    operator.widget_standalone_url || null,
  };
}

async function patchOperator(operatorId, updates) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const res = await fetch(`${url}/rest/v1/operators?id=eq.${operatorId}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PostgREST ${res.status}: ${detail.slice(0, 200)}`);
  }
  const rows = await res.json();
  return rows[0];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { operatorId } = auth;

  if (req.method === 'GET') {
    const operator = await getOperator(operatorId);
    return res.status(200).json(operatorSettingsView(operator));
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const updates = {};
    for (const field of OPERATOR_EDITABLE) {
      if (!(field in body)) continue;
      const val = body[field];
      // Empty value on a masked secret field means "keep what's there" — the
      // captain can save other Settings without re-pasting their credentials.
      if (SECRET_FIELDS.has(field) && (val === '' || val === null || val === undefined)) continue;
      // Light shape check on species_list. Anything else passes through
      // and the JSONB column accepts it as-is.
      if (field === 'species_list' && !Array.isArray(val)) {
        return res.status(400).json({ error: 'species_list must be an array' });
      }
      updates[field] = val;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }

    try {
      const updated = await patchOperator(operatorId, updates);
      return res.status(200).json(operatorSettingsView(updated));
    } catch (err) {
      console.error('operator-settings PATCH failed:', err.message);
      return res.status(500).json({ error: 'Update failed', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
