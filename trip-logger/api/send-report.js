const mailchimp = require('@mailchimp/mailchimp_marketing');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const https = require('https');
const crypto = require('crypto');

const { authenticate } = require('../lib/auth');
const { getOperator, pick } = require('../lib/operators');

// Per-request transporter — Gmail credentials live on the operator row now,
// so we can't build a module-level singleton. createTransport returns a fresh
// pool that's used once and discarded; nodemailer handles the actual reuse
// internally for the duration of a single sendMail call.
//
// Credentials come strictly from the operator row. gmail_user falls back to
// from_email since for plain Gmail accounts those are always the same; the
// captain only sees one field in Settings ("From" Email Address) plus their
// 16-char App Password. The gmail_user column stays in the schema for
// Workspace-alias setups where they legitimately differ — super-admin sets
// that via the Admin UI when needed.
function buildTransporter(operator) {
  const user = (operator && (operator.gmail_user || operator.from_email)) || null;
  const pass = (operator && operator.gmail_app_password) || null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

// Mailchimp's SDK is a singleton — calling setConfig mutates global state.
// In Vercel serverless this is fine because each function invocation runs in
// its own (or warm-reused) instance; we re-set per request to make sure the
// right operator's audience is targeted.
//
// Credentials come strictly from the operator row. There used to be env-var
// fallbacks (MAILCHIMP_API_KEY etc.) for single-tenant back-compat, but those
// would silently route a misconfigured operator's signups through whoever
// owned the env var — a footgun once we onboard a second operator.
function configureMailchimp(operator) {
  mailchimp.setConfig({
    apiKey: operator && operator.mailchimp_api_key,
    server: (operator && operator.mailchimp_server_prefix) || 'us1',
  });
}

// ─── Per-guest whale log (migration 0004) ──────────────────────────────
// Records who's been emailed on which trip so the next email can open with
// "Welcome back — your 3rd trip with us. You've now spotted 8 species..."
// instead of the generic greeting.

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

// Insert one row per guest into trip_guests for this trip. Keyed on trip_id
// so two trips the same day record their guests separately. Uses
// resolution=merge-duplicates so a duplicated email in the same payload
// collapses to one row.
async function recordGuestsForTrip(operatorId, tripDate, tripId, emails) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !operatorId || !tripDate || !tripId || !emails || emails.length === 0) return;
  const rows = emails.map(e => ({
    operator_id: operatorId,
    trip_date:   tripDate,
    trip_id:     tripId,
    email:       String(e).toLowerCase().trim(),
  }));
  try {
    const res = await fetch(`${url}/rest/v1/trip_guests?on_conflict=trip_id,email`, {
      method: 'POST',
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) console.error('recordGuestsForTrip:', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('recordGuestsForTrip error:', err.message);
  }
}

// Asks Postgres for how many trips and species this email has logged with
// the operator. Falls back to {trips: 1, species: 0} on any failure so the
// email still sends with the first-timer copy.
async function getGuestStats(operatorId, email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const fallback = { trips: 1, species: 0 };
  if (!url || !key || !operatorId || !email) return fallback;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/guest_stats`, {
      method: 'POST',
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ op_id: operatorId, email_in: String(email).toLowerCase().trim() }),
    });
    if (!res.ok) return fallback;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return fallback;
    return {
      trips:   Number.isFinite(+row.trips)   ? +row.trips   : 1,
      species: Number.isFinite(+row.species) ? +row.species : 0,
    };
  } catch (err) {
    console.error('getGuestStats error:', err.message);
    return fallback;
  }
}

// Resolves every per-operator branding string used by the PDF, email, and
// captain copy. Centralized so adding a new branded surface = one edit here
// instead of hunting for hardcoded "Enocean" strings.
function brand(operator) {
  // Fallbacks are intentionally GENERIC, never Enocean-specific. They fire only
  // for an operator that hasn't filled a field in yet — and a half-onboarded
  // operator must never inherit Enocean's name, logo, or links on their guest
  // email/PDF. Enocean's own operators row is fully populated, so none of these
  // fallbacks ever fire for it: its output is unchanged by this.
  const websiteUrl = pick(operator, 'website_url', '');
  const websiteHost = (websiteUrl || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toUpperCase();
  return {
    name:        pick(operator, 'name',               'Your Tour Company'),
    slug:        pick(operator, 'slug',               'operator'),
    tagline:     pick(operator, 'tagline',            ''),
    // No generic logo asset exists, so the fallback is "no image" — the PDF
    // header then draws an initials wordmark and the email omits the logo,
    // rather than showing another operator's logo.
    logoPdf:     pick(operator, 'logo_url',           null),
    logoEmail:   pick(operator, 'logo_url_email',     null),
    reviewUrl:   pick(operator, 'review_url',         ''),
    // PDF static-map center; Enocean's row value equals the previous hardcoded
    // constant, so the map frames identically.
    mapCenter:   pick(operator, 'default_map_center', '36.78,-122.05'),
    websiteUrl,
    websiteHost,
    fromEmail:   operator && operator.from_email,
    audienceId:  operator && operator.mailchimp_audience_id,
  };
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Auth helpers live in ../lib/auth.js so /api/me and future endpoints share
// the same JWT verification and operator-resolution logic.

function getFormattedDuration(startTime, endTime) {
  const diffMs = new Date(endTime) - new Date(startTime);
  const diffMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMins / 60);
  const minutes = diffMins % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// Render the YYYY-MM-DD calendar date of `when` in a given IANA timezone.
// Used as the server-side fallback for trip_date when the client didn't
// send its own local date. Falls back to the UTC date when the timezone is
// missing or not a name the runtime recognises.
function localDateInTimeZone(when, timeZone) {
  const d = new Date(when);
  if (isNaN(d.getTime())) return null;
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d);
      const get = (t) => (parts.find(p => p.type === t) || {}).value;
      const y = get('year'), m = get('month'), day = get('day');
      if (y && m && day) return `${y}-${m}-${day}`;
    } catch (e) {
      // Unrecognised timezone — fall through to the UTC date below.
    }
  }
  return d.toISOString().split('T')[0];
}

// Bucket a trip's start time into Morning / Afternoon / Evening in the
// operator's timezone. Stored on every sighting row so the widget, captain
// app and guest profile can label a trip — especially when a day has more
// than one — without re-deriving anything. Null when it can't be resolved.
function tripPartInTimeZone(when, timeZone) {
  const d = new Date(when);
  if (isNaN(d.getTime())) return null;
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hour: '2-digit', hourCycle: 'h23',
    }).format(d)) % 24;
  } catch (e) {
    return null;
  }
  if (!Number.isFinite(hour)) return null;
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

// Resolve the trip's calendar date. Prefers the local date already stashed
// on `tripData.tripDate` — the handler puts there either the client-supplied
// date or, for older clients that don't send one, a date derived from
// startTime in the operator's timezone. The UTC split is a last-resort
// guard for a payload that somehow carries neither.
function resolveTripDate(tripData) {
  const t = tripData && tripData.tripDate;
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return new Date(tripData.startTime).toISOString().split('T')[0];
}

// ─── Fetch Google Maps Static Image ──────────────────────────────────────────

function fetchMapImage(sightings, center) {
  return new Promise((resolve) => {
    const withCoords = sightings.filter(s => s.lat && s.lng);

    const CENTER = center || '36.78,-122.05';
    const ZOOM   = '10';

    if (withCoords.length === 0) {
      const url = `https://maps.googleapis.com/maps/api/staticmap?center=${CENTER}&zoom=${ZOOM}&size=640x400&scale=2&maptype=hybrid&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      fetchURL(url).then(resolve).catch(() => resolve(null));
      return;
    }

    const markers = withCoords.map((s, i) =>
      `markers=color:white|label:${i + 1}|${s.lat},${s.lng}`
    ).join('&');

    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${CENTER}&zoom=${ZOOM}&size=640x400&scale=2&maptype=hybrid&${markers}&key=${process.env.GOOGLE_MAPS_API_KEY}`;

    fetchURL(url).then(resolve).catch(() => resolve(null));
  });
}

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Bathymetry (NOAA NCEI global DEM mosaic) ───────────────────────────────
// Returns positive depth in meters at the given lat/lng, or null if the point
// is above sea level, the request times out (3s), or the API errors out.
//
// NOAA's DEM_global_mosaic returns elevation in meters: negative = below sea
// level, positive = above. We invert the sign so callers always see depth as
// a positive number, and discard land readings (positive elevation -> null).
function fetchDepth(lat, lng) {
  return new Promise((resolve) => {
    const geometry = encodeURIComponent(JSON.stringify({
      x: lng, y: lat, spatialReference: { wkid: 4326 },
    }));
    const url = `https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/identify`
      + `?geometry=${geometry}&geometryType=esriGeometryPoint&returnGeometry=false&f=json`;

    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const req = https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const raw = body && body.value;
          const elevation = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
          if (!Number.isFinite(elevation) || elevation >= 0) return done(null);
          done(Math.abs(elevation));
        } catch (e) {
          done(null);
        }
      });
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
    req.setTimeout(3000, () => { req.destroy(); done(null); });
  });
}

// Mutates the sightings array, attaching depth_meters to every sighting that
// has valid lat/lng. All lookups run in parallel (each capped at 3s by
// fetchDepth's internal timeout), so total wall time is ~3s worst case
// regardless of how many sightings the trip has.
async function attachDepthsToSightings(sightings) {
  if (!Array.isArray(sightings) || sightings.length === 0) return;
  const depths = await Promise.all(sightings.map(s =>
    (s && s.lat != null && s.lng != null) ? fetchDepth(s.lat, s.lng) : Promise.resolve(null)
  ));
  sightings.forEach((s, i) => { s.depth_meters = depths[i]; });
}

// Format depth for display: "847m" under 1km, "1.2km" otherwise. Returns
// null when input is null/undefined/non-numeric so callers can use as a guard.
function formatDepthLabel(m) {
  if (m == null || !Number.isFinite(Number(m))) return null;
  const v = Number(m);
  return v < 1000 ? `${Math.round(v)}m` : `${(v / 1000).toFixed(1)}km`;
}

// ─── PDF Generator ───────────────────────────────────────────────────────────

async function generatePDF(tripData, b) {
  const mapImageBuffer = await fetchMapImage(tripData.sightings, b.mapCenter);

  let logoBuffer = null;
  try {
    logoBuffer = await fetchURL(b.logoPdf);
  } catch(e) {
    console.log('Logo fetch failed:', e.message);
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 0,
      size: 'LETTER',
      autoFirstPage: false,
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BLACK = '#000000';
    const WHITE = '#ffffff';
    const GRAY  = '#f0f0f0';
    const MID   = '#777777';
    const RULE  = '#cccccc';

    const W  = 612;
    const H  = 792;
    const M  = 40;
    const CW = W - M * 2;
    const bold = 'Helvetica-Bold';
    const reg  = 'Helvetica';

    const date     = new Date(tripData.startTime).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const duration = getFormattedDuration(tripData.startTime, tripData.endTime);

    doc.addPage({ size: 'LETTER', margin: 0 });

    // ── HEADER ──
    const headerH = 72;
    doc.rect(0, 0, W, headerH).fill(BLACK);

    const logoRadius = 24;
    const logoCX = M + logoRadius;
    const logoCY = headerH / 2;
    doc.circle(logoCX, logoCY, logoRadius).fill(WHITE);
    // Wordmark fallback when an operator has no logo image. Generic operator
    // initials (centered in the circle) so a logo-less operator never renders
    // "ENOCEAN TOURS". Enocean has a logo set, so this never runs for it.
    const initials = (b.name || '').split(/\s+/).filter(Boolean)
      .map(w => w[0]).join('').slice(0, 3).toUpperCase() || 'TL';
    const drawWordmark = () => {
      doc.fillColor(BLACK).font(bold).fontSize(13)
         .text(initials, logoCX - logoRadius, logoCY - 7, { width: logoRadius * 2, align: 'center', lineBreak: false });
    };
    if (logoBuffer) {
      try {
        const logoSize = logoRadius * 2 - 4;
        doc.image(logoBuffer, logoCX - logoSize/2, logoCY - logoSize/2, { width: logoSize, height: logoSize });
      } catch(e) {
        drawWordmark();
      }
    } else {
      drawWordmark();
    }

    doc.fillColor(WHITE).font(bold).fontSize(18)
       .text('TRIP REPORT', 0, headerH/2 - 10, { align: 'center', width: W, lineBreak: false, characterSpacing: 3 });

    doc.fillColor(WHITE).font(reg).fontSize(8)
       .text(date.toUpperCase(), M, headerH/2 + 10, { align: 'right', width: CW, lineBreak: false, characterSpacing: 0.5 });

    let y = headerH;

    // ── PHOTO (left) + STATS (right) ──
    const photoW = Math.round(W * 0.58);
    const photoH = 200;

    if (tripData.photoData) {
      try {
        const b64 = tripData.photoData.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        doc.save();
        doc.rect(0, y, photoW, photoH).clip();
        doc.image(buf, 0, y, { cover: [photoW, photoH], align: 'center', valign: 'center' });
        doc.restore();
      } catch(e) {
        doc.rect(0, y, photoW, photoH).fill('#111');
      }
    } else {
      doc.rect(0, y, photoW, photoH).fill('#111');
      doc.fillColor(MID).font(reg).fontSize(9)
         .text('No photo', 0, y + photoH/2 - 6, { align: 'center', width: photoW, lineBreak: false });
    }

    const statsX = photoW + 1;
    const statsW = W - photoW - 1;
    doc.rect(statsX, y, statsW, photoH).fill(GRAY);

    const distanceNM = tripData.distanceNM ? tripData.distanceNM.toFixed(2) + ' NM' : 'N/A';
    const statItems = [
      { label: 'DURATION',   value: duration },
      { label: 'DISTANCE',   value: distanceNM },
      { label: 'PASSENGERS', value: String(tripData.passengers) },
      { label: 'SIGHTINGS',  value: String(tripData.sightings.length) },
    ];

    const statBlockH = photoH / statItems.length;
    statItems.forEach((stat, i) => {
      const sy = y + i * statBlockH;
      if (i > 0) doc.rect(statsX + 12, sy, statsW - 24, 0.5).fill(RULE);
      doc.fillColor(MID).font(reg).fontSize(7)
         .text(stat.label, statsX + 16, sy + 10, { width: statsW - 24, lineBreak: false, characterSpacing: 1 });
      doc.fillColor(BLACK).font(bold).fontSize(20)
         .text(stat.value, statsX + 16, sy + 22, { width: statsW - 24, lineBreak: false });
    });

    y += photoH;

    // ── CONDITIONS STRIP ──
    doc.rect(0, y, W, 26).fill(BLACK);
    const condParts = [];
    if (tripData.visibility) condParts.push('Visibility: ' + tripData.visibility);
    if (tripData.conditions)  condParts.push('Sea: ' + tripData.conditions);
    if (tripData.waterTemp)   condParts.push('Water: ' + tripData.waterTemp + '°F');
    doc.fillColor(WHITE).font(reg).fontSize(8)
       .text(condParts.join('   •   ') || 'Monterey Bay', 0, y + 8, { align: 'center', width: W, lineBreak: false, characterSpacing: 0.8 });
    y += 26;

    // ── MAP ──
    const mapH = 180;
    if (mapImageBuffer) {
      try {
        doc.image(mapImageBuffer, 0, y, { width: W, height: mapH });
      } catch(e) {
        doc.rect(0, y, W, mapH).fill('#ddd');
        console.error('Map error:', e.message);
      }
    } else {
      doc.rect(0, y, W, mapH).fill('#e5e5e5');
      doc.fillColor(MID).font(reg).fontSize(9)
         .text('Map unavailable', 0, y + mapH/2, { align: 'center', width: W, lineBreak: false });
    }
    y += mapH;

    // ── SIGHTINGS LOG ──
    y += 12;
    doc.fillColor(BLACK).font(bold).fontSize(9)
       .text('SIGHTINGS LOG', M, y, { lineBreak: false, characterSpacing: 1.5 });
    y += 13;
    doc.rect(M, y, CW, 1).fill(BLACK);
    y += 8;

    const cols = [200, 60, 60, CW - 320];
    const headers = ['SPECIES', 'COUNT', 'TIME', 'NOTES & LOCATION'];
    let cx = M;
    headers.forEach((h, i) => {
      doc.fillColor(MID).font(bold).fontSize(7)
         .text(h, cx, y, { width: cols[i], lineBreak: false, characterSpacing: 0.8 });
      cx += cols[i];
    });
    y += 14;
    doc.rect(M, y, CW, 0.5).fill(RULE);
    y += 6;

    const footerY = H - 44;
    const availableH = footerY - y - 10;
    const totalRows = tripData.sightings.length || 1;
    const maxRowH = 28;
    const minRowH = 18;
    const rowH = Math.min(maxRowH, Math.max(minRowH, Math.floor(availableH / totalRows)));
    const fontSize = rowH <= 20 ? 7 : rowH <= 24 ? 8 : 9;

    if (tripData.sightings.length === 0) {
      doc.fillColor(MID).font(reg).fontSize(9).text('No sightings logged', M, y, { lineBreak: false });
    } else {
      tripData.sightings.forEach((s, i) => {
        const bg = i % 2 === 0 ? WHITE : GRAY;
        doc.rect(M - 4, y - 2, CW + 8, rowH).fill(bg);
        doc.rect(M - 4, y - 2, 3, rowH).fill(BLACK);

        const textY = y + (rowH - fontSize) / 2 - 2;

        doc.fillColor(BLACK).font(bold).fontSize(fontSize)
           .text(s.species.toUpperCase(), M, textY, { width: cols[0] - 8, lineBreak: false });
        doc.fillColor(BLACK).font(reg).fontSize(fontSize)
           .text('×' + s.count, M + cols[0], textY, { width: cols[1], lineBreak: false });
        doc.fillColor(BLACK).font(reg).fontSize(fontSize)
           .text(s.time, M + cols[0] + cols[1], textY, { width: cols[2], lineBreak: false });

        const notesX = M + cols[0] + cols[1] + cols[2];
        let noteText = s.notes || '';
        if (s.lat && s.lng) {
          const coords = s.lat.toFixed(4) + ', ' + s.lng.toFixed(4);
          noteText = noteText ? noteText + '  •  ' + coords : coords;
        }
        const depthLabel = formatDepthLabel(s.depth_meters);
        if (depthLabel) {
          noteText = noteText ? noteText + '  ·  ' + depthLabel + ' depth' : depthLabel + ' depth';
        }
        doc.fillColor(MID).font(reg).fontSize(Math.max(fontSize - 1, 6))
           .text(noteText, notesX, textY, { width: cols[3], lineBreak: false });

        y += rowH;
        doc.rect(M, y - 2, CW, 0.5).fill(RULE);
      });
    }

    // ── FOOTER ──
    doc.rect(0, H - 44, W, 44).fill(BLACK);
    const footerText = [b.name.toUpperCase(), b.tagline, b.websiteHost].filter(Boolean).join('  •  ');
    doc.fillColor(WHITE).font(bold).fontSize(7)
       .text(footerText, M, H - 26, { align: 'center', width: CW, lineBreak: false, characterSpacing: 1 });

    doc.end();
  });
}

// ─── Save to Supabase ─────────────────────────────────────────────────────────

async function saveToSupabase(tripData, operatorId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log('Supabase not configured, skipping save');
    return;
  }
  if (!operatorId) {
    console.error('saveToSupabase called without operatorId — refusing to insert untagged rows');
    return;
  }

  const tripDate = resolveTripDate(tripData);
  const durationMs = new Date(tripData.endTime) - new Date(tripData.startTime);
  const durationMinutes = Math.floor(durationMs / 60000);

  const rows = tripData.sightings.map(s => ({
    operator_id: operatorId,
    trip_date: tripDate,
    trip_id: tripData.tripId,
    trip_part: tripData.tripPart || null,
    sighting_time: s.time || null,
    duration_minutes: durationMinutes,
    distance_nm: parseFloat((tripData.distanceNM || 0).toFixed(2)),
    passengers: tripData.passengers,
    water_temp: tripData.waterTemp ? parseFloat(tripData.waterTemp) : null,
    visibility: tripData.visibility || null,
    conditions: tripData.conditions || null,
    species: s.species,
    count: s.count,
    behavior_notes: s.notes || null,
    lat: s.lat ? parseFloat(s.lat.toFixed(6)) : null,
    lng: s.lng ? parseFloat(s.lng.toFixed(6)) : null,
    depth_meters: (s.depth_meters != null && Number.isFinite(Number(s.depth_meters)))
      ? parseFloat(Number(s.depth_meters).toFixed(2))
      : null,
  }));

  if (rows.length === 0) {
    console.log('No sightings to save');
    return;
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/sightings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Supabase save error:', err);
    } else {
      console.log(`Saved ${rows.length} sightings to Supabase`);
    }
  } catch(e) {
    console.error('Supabase fetch error:', e.message);
  }
}

// Persist the trip's continuous GPS breadcrumb. tripData.track is an array of
// { lat, lng, recorded_at [ISO], accuracy? } pushed by the captain app during
// the trip — natively via the background-location plugin on iOS, via
// navigator.geolocation on the PWA. Server-side downsample to 500 points max
// so a noisy device doesn't blow up the table, and silently no-op if the
// payload is empty (the widget then falls back to pin-to-pin lines).
// The trip-level record: which boat, which scheduled departure, who was
// aboard. Written once per logged trip so Flukesend's getLoggedTrip can
// fill the send form's whole Trip step, not just species. Upsert on
// trip_id so a retried log never duplicates the row.
async function saveLogbookTrip(tripData, operatorId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey || !operatorId || !tripData || !tripData.tripId) return;

  const row = {
    trip_id:     tripData.tripId,
    operator_id: operatorId,
    trip_date:   resolveTripDate(tripData),
    trip_part:   tripData.tripPart || null,
    trip_time:   (typeof tripData.tripTime === 'string' && /^\d{1,2}:\d{2}$/.test(tripData.tripTime))
      ? tripData.tripTime
      : null,
    boat_id:     (typeof tripData.boatId === 'string' && /^[0-9a-f-]{36}$/i.test(tripData.boatId))
      ? tripData.boatId
      : null,
    boat_name:   (typeof tripData.boatName === 'string' && tripData.boatName.trim())
      ? tripData.boatName.trim().slice(0, 120)
      : null,
    crew_names:  Array.isArray(tripData.crewNames)
      ? tripData.crewNames.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim().slice(0, 120)).slice(0, 30)
      : [],
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/logbook_trips?on_conflict=trip_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([row]),
    });
    if (!response.ok) {
      console.error('logbook_trips save error:', response.status, (await response.text()).slice(0, 200));
    }
  } catch (e) {
    console.error('logbook_trips fetch error:', e.message);
  }
}

// A logged trip should never lose its route to client-side state loss. The
// app broadcasts every GPS point to live_trips during the trip under
// tripData.liveId, so when a log arrives with an EMPTY track (it happened:
// a webview restore handed the log an empty array while the live row held
// the full 434-point route), the server rebuilds the track from its own
// live copy. Operator-scoped, so a crafted liveId can never read another
// tenant's route. Returns [] when there is nothing to backfill from.
async function backfillTrackFromLive(liveId, operatorId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(liveId || ''))) return [];
  try {
    const res = await fetch(
      `${url}/rest/v1/live_trips?trip_id=eq.${liveId}&operator_id=eq.${operatorId}&select=track`,
      { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } },
    );
    if (!res.ok) return [];
    const rows = await res.json();
    const pts = rows[0] && Array.isArray(rows[0].track) ? rows[0].track : [];
    const track = pts
      .filter(pt => Number.isFinite(+pt.lat) && Number.isFinite(+pt.lng) && pt.t)
      .map(pt => ({ lat: +pt.lat, lng: +pt.lng, recorded_at: pt.t }));
    if (track.length) console.log(`Track backfilled from live broadcast ${liveId}: ${track.length} points`);
    return track;
  } catch (e) {
    console.error('backfillTrackFromLive error:', e.message);
    return [];
  }
}

async function saveTrackToSupabase(track, operatorId, tripId) {
  if (!Array.isArray(track) || track.length === 0 || !operatorId || !tripId) return;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const MAX_POINTS = 500;
  let points = track;
  if (points.length > MAX_POINTS) {
    const step = points.length / MAX_POINTS;
    const sampled = [];
    for (let i = 0; i < MAX_POINTS; i++) sampled.push(points[Math.floor(i * step)]);
    points = sampled;
  }
  const rows = points
    .filter(p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && p.recorded_at)
    .map(p => ({
      trip_id:     tripId,
      operator_id: operatorId,
      lat:         parseFloat((+p.lat).toFixed(6)),
      lng:         parseFloat((+p.lng).toFixed(6)),
      recorded_at: p.recorded_at,
      accuracy_m:  (p.accuracy != null && Number.isFinite(+p.accuracy))
        ? parseFloat((+p.accuracy).toFixed(1))
        : null,
    }));
  if (rows.length === 0) return;

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/trip_track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!response.ok) {
      console.error('trip_track save error:', response.status, (await response.text()).slice(0, 200));
    } else {
      console.log(`Saved ${rows.length} track points to trip_track`);
    }
  } catch (e) {
    console.error('trip_track fetch error:', e.message);
  }
}

// ─── Mailchimp ────────────────────────────────────────────────────────────────

async function addToMailchimp(email, b) {
  if (!b.audienceId) { console.log('No Mailchimp audience configured for this operator, skipping'); return; }
  try {
    await mailchimp.lists.addListMember(b.audienceId, {
      email_address: email,
      status: 'subscribed',
      tags: ['Trip Guest'],
    });
  } catch (err) {
    console.log('Mailchimp note:', err.message);
  }
}

// ─── Send Email ───────────────────────────────────────────────────────────────

async function sendEmail(guestEmail, pdfBuffer, socialCardData, tripData, b, transporter, operatorId) {
  const date = new Date(tripData.startTime).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const speciesList = tripData.sightings.map(s => `${s.species} (×${s.count})`).join(', ') || 'No sightings logged';
  const duration = getFormattedDuration(tripData.startTime, tripData.endTime);

  // Profile signup CTA. PUBLIC_APP_URL is set on every Vercel deploy
  // (prod + previews), so the only time we skip the CTA is local dev
  // with no env var configured — there's no working link to point at.
  const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  const profileUrl = appUrl ? `${appUrl}/profile?email=${encodeURIComponent(guestEmail)}` : null;

  // Pull this guest's prior-trip stats (post-insert of today's row, so trips
  // includes today). Pick first-timer vs returning copy. If the lookup fails,
  // getGuestStats returns the first-timer fallback so the email still sends.
  const stats = await getGuestStats(operatorId, guestEmail);
  const greetingHTML = stats.trips <= 1
    ? `<p style="color:#f4f6f7;font-size:15px;line-height:1.45;margin:0 0 10px;font-weight:500;">Hi there,</p>
       <p style="color:rgba(244,246,247,0.62);font-size:14px;line-height:1.65;margin:0;">Welcome aboard your first ${b.name} trip — your wildlife log starts here. Your trip report and story card are attached.</p>`
    : `<p style="color:#f4f6f7;font-size:15px;line-height:1.45;margin:0 0 10px;font-weight:500;">Welcome back,</p>
       <p style="color:rgba(244,246,247,0.62);font-size:14px;line-height:1.65;margin:0;">This is your <strong style="color:#f4f6f7;font-weight:600;">${ordinal(stats.trips)} trip</strong> with us.${stats.species >= 2 ? ` You've now spotted <strong style="color:#f4f6f7;font-weight:600;">${stats.species} species</strong> across all your trips.` : ''} Your trip report and story card are attached.</p>`;

  // Mirrors the app's "ocean-deep" surface palette (see index.html :root):
  //   --ink #0a0c0e (page) / --ink-3 #161b1f (card) / --ink-4 #1d2429 (tile)
  //   hairline #242a30 ≈ rgba(255,255,255,0.08) on --ink-3
  //   --gold #c8a86b kicker, --teal #6fb1ac accents, #e6f0f0 primary CTA
  // Inline-styled because Gmail strips <style>; table layout for client compat.
  const tileStyle  = 'background:#1d2429;border:1px solid #242a30;border-left:3px solid #6fb1ac;border-radius:10px;padding:14px 16px;';
  const labelStyle = 'font:600 10px/1 \'Open Sans\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;letter-spacing:0.22em;text-transform:uppercase;color:rgba(244,246,247,0.42);';
  const valueStyle = 'font:500 17px/1.2 \'Open Sans\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;color:#f4f6f7;margin-top:8px;';

  const result = await transporter.sendMail({
    from: `"${b.name}" <${b.fromEmail}>`,
    to: guestEmail,
    subject: `Your ${b.name} Trip Report — ${date}`,
    html: `<body style="margin:0;padding:0;background:#0a0c0e;font-family:'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#f4f6f7;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0c0e;">
  <tr><td align="center" style="padding:28px 14px;">
    <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#161b1f;border:1px solid #242a30;border-radius:16px;overflow:hidden;">

      <tr><td style="background:#0a0c0e;padding:34px 24px 26px;text-align:center;border-bottom:1px solid #242a30;">
        ${b.logoEmail ? `<img src="${b.logoEmail}" alt="${b.name}" width="180" style="display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">` : ''}
        <div style="font:600 9px/1 'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;letter-spacing:0.34em;text-transform:uppercase;color:#c8a86b;">Trip Report</div>
        <div style="margin-top:10px;font:400 11px/1 'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;letter-spacing:0.18em;text-transform:uppercase;color:rgba(244,246,247,0.42);">${date}</div>
      </td></tr>

      <tr><td style="padding:26px 24px 6px;">${greetingHTML}</td></tr>

      <tr><td style="padding:18px 24px 6px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="48%" valign="top" style="${tileStyle}">
              <div style="${labelStyle}">Date</div>
              <div style="${valueStyle}font-size:14px;">${date}</div>
            </td>
            <td width="4%" style="font-size:0;line-height:0;">&nbsp;</td>
            <td width="48%" valign="top" style="${tileStyle}">
              <div style="${labelStyle}">Duration</div>
              <div style="${valueStyle}">${duration}</div>
            </td>
          </tr>
          <tr><td colspan="3" style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>
          <tr>
            <td width="48%" valign="top" style="${tileStyle}">
              <div style="${labelStyle}">Passengers</div>
              <div style="${valueStyle}">${tripData.passengers}</div>
            </td>
            <td width="4%" style="font-size:0;line-height:0;">&nbsp;</td>
            <td width="48%" valign="top" style="${tileStyle}">
              <div style="${labelStyle}">Sightings</div>
              <div style="${valueStyle}">${tripData.sightings.length}</div>
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:18px 24px 6px;">
        <div style="background:#1d2429;border:1px solid #242a30;border-radius:12px;padding:16px 18px;">
          <div style="font:700 10px/1 'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;letter-spacing:0.26em;text-transform:uppercase;color:#c8a86b;margin-bottom:10px;">What We Saw</div>
          <div style="color:#f4f6f7;font-size:14px;line-height:1.6;">${speciesList}</div>
        </div>
      </td></tr>

      <tr><td align="center" style="padding:26px 24px 10px;">
        <a href="${b.reviewUrl}" style="background:#e6f0f0;color:#0a0c0e;padding:14px 34px;text-decoration:none;font-weight:700;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;display:inline-block;border-radius:999px;">Leave Us a Review</a>
        <div style="margin-top:12px;color:rgba(244,246,247,0.42);font-size:12px;line-height:1.5;">It takes 2 minutes and means the world to us.</div>
      </td></tr>
${profileUrl ? `
      <tr><td style="padding:8px 24px 22px;">
        <div style="background:#1d2429;border:1px solid #242a30;border-radius:12px;padding:18px 20px;text-align:center;">
          <div style="font:700 10px/1 'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;letter-spacing:0.26em;text-transform:uppercase;color:#c8a86b;margin-bottom:8px;">Your Wildlife Log</div>
          <div style="color:rgba(244,246,247,0.62);font-size:13px;line-height:1.6;margin-bottom:14px;">Create a free profile to see every trip and every species you've spotted with us — past and future.</div>
          <a href="${profileUrl}" style="display:inline-block;background:transparent;color:#e6f0f0;border:1px solid #e6f0f0;padding:11px 26px;text-decoration:none;font-weight:700;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;border-radius:999px;">Create Profile</a>
        </div>
      </td></tr>` : ''}
      <tr><td style="border-top:1px solid #242a30;padding:22px 24px 26px;text-align:center;">
        <div style="font:600 10px/1.4 'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;letter-spacing:0.26em;text-transform:uppercase;color:rgba(244,246,247,0.62);">${b.tagline}</div>
        <a href="${b.websiteUrl}" style="display:inline-block;margin-top:8px;font-size:11px;color:#6fb1ac;text-decoration:none;letter-spacing:0.05em;">${b.websiteHost.toLowerCase()}</a>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>`,
    attachments: [
      {
        filename: `${b.slug}-trip-${resolveTripDate(tripData)}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
      ...(socialCardData ? [{
        filename: `${b.slug}-story-${resolveTripDate(tripData)}.jpg`,
        content: Buffer.from(socialCardData.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
        contentType: 'image/jpeg',
      }] : []),
    ],
  });

  console.log('Gmail sent:', result.messageId);
  return result;
}

// ─── Captain copy (IG-ready image) ────────────────────────────────────────────
// Sends a separate email back to the operator's from_email with the PDF-styled
// 1080x1920 captain card attached. The captain downloads it from their inbox
// and decides whether to post to Instagram. Best-effort: any failure here is
// logged but doesn't fail the trip end response.
async function sendCaptainCopy(captainCardData, tripData, b, transporter) {
  if (!captainCardData) return;
  if (!b.fromEmail) {
    console.log('No from_email configured for this operator, skipping captain copy');
    return;
  }
  try {
    const date = new Date(tripData.startTime).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    const dateSlug = resolveTripDate(tripData);
    const speciesList = tripData.sightings.map(s => `${s.species} (×${s.count})`).join(', ') || 'No sightings';

    await transporter.sendMail({
      from: `"${b.name}" <${b.fromEmail}>`,
      to: b.fromEmail,
      subject: `Captain copy — ${date} — ready for Instagram`,
      text: `Captain copy for the ${date} trip.\n\nSpecies: ${speciesList}\nSightings: ${tripData.sightings.length}\n\nDownload the attached image and post it to Instagram if you want — guests did NOT receive this.`,
      attachments: [{
        filename: `${b.slug}-captain-${dateSlug}.jpg`,
        content: Buffer.from(captainCardData.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
        contentType: 'image/jpeg',
      }],
    });
    console.log('Captain copy emailed to', b.fromEmail);
  } catch (err) {
    console.error('Captain copy email failed:', err.message);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Step 3 lockdown: every send must come from a logged-in operator user.
  // authenticate() returns null after writing the appropriate 401/403; we
  // bail out immediately so no PDF is rendered, no email is sent, no
  // sighting is saved on a request without a valid session.
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { operatorId } = auth;

  // Step 4: pull the full operator row so every branding string, credential,
  // and email destination comes from the database instead of process.env.
  const operator = await getOperator(operatorId);
  const b = brand(operator);
  const transporter = buildTransporter(operator);
  configureMailchimp(operator);

  const { tripData, tripDate, guestEmails, socialCardData, captainCardData } = req.body;
  // Log-only: write the trip (sightings + track) and send nothing. Guest
  // delivery now happens in Flukesend, so ending a trip must not require an
  // email address. The full-send path below stays intact for old cached
  // clients until they pick up the new build.
  const isLogOnly = req.body.mode === 'log-only';

  // The route to persist: the client's copy when it has one, else the
  // server's own live-broadcast copy (see backfillTrackFromLive).
  let tripTrack = Array.isArray(tripData.track) ? tripData.track : [];
  if (tripTrack.length === 0 && tripData.liveId) {
    tripTrack = await backfillTrackFromLive(tripData.liveId, operatorId);
  }
  if (!tripData || (!isLogOnly && !guestEmails && !Array.isArray(req.body.guests))) {
    return res.status(400).json({ error: 'Missing tripData or guests' });
  }
  // "Add a guest" resend: deliver the recap to a guest the captain forgot,
  // without re-logging the trip. The client passes the original trip's id.
  const isAddGuests = req.body.mode === 'add-guests';
  // Stash the trip's local calendar date on tripData so every downstream
  // helper (saveToSupabase, recordGuestsForTrip, filename slugs) sees the
  // operator's local YYYY-MM-DD instead of re-deriving it from startTime in
  // UTC. Prefer the client-supplied date; for older cached app builds that
  // don't send one, derive it from startTime in the operator's timezone —
  // an evening trip in a negative-UTC offset would otherwise be stamped with
  // tomorrow's UTC date.
  if (typeof tripDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tripDate)) {
    tripData.tripDate = tripDate;
  } else if (tripData.startTime) {
    tripData.tripDate = localDateInTimeZone(tripData.startTime, pick(operator, 'timezone', null));
  }
  // Identify this trip. A normal send mints a fresh trip_id that groups every
  // sighting + guest row from this report. An add-guests resend reuses the
  // original trip's id so the late guest is filed under the same trip.
  /*
    Declared out here, which is the whole fix.

    It was declared with const INSIDE the isAddGuests branch below and then
    used in that branch's else-if, and again in the log-only block further
    down. const is block scoped, so for every request that was NOT an
    add-guests resend, which is every ordinary Log Trip, evaluating the
    else-if threw ReferenceError before the handler's try block existed to
    catch it. The function 500'd, and the app could only report that the
    server said 500.

    It shipped at 19:24 on 2026-08-06 in the change that gave the client
    ownership of the trip id, after the day's trips were already logged, so
    nothing failed that evening and the first casualties were the next
    morning's departures. Nobody could log a trip for about seventeen hours.
  */
  const tripIdRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (isAddGuests) {
    if (!tripIdRe.test(String(req.body.tripId || ''))) {
      return res.status(400).json({ error: 'add-guests mode requires a valid tripId' });
    }
    tripData.tripId = req.body.tripId;
  } else if (tripIdRe.test(String(req.body.logTripId || ''))) {
    /*
      The client owns the trip's identity. The id used to be minted here, per
      request, which quietly defeated every downstream on_conflict=trip_id
      guard: a resubmission of the same trip arrived wearing a fresh uuid and
      the "idempotent" upsert dutifully created a second trip. The dangerous
      replay is real at sea: Log Trip tapped, the request crawling on marine
      signal, the webview reloaded before the response lands, so the logged
      marker never persisted and the app honestly re-asks. Same trip, new id,
      duplicate on the public widget.

      The app now mints one id per trip at Start Trip and resubmits under it,
      so a replay lands on the same row. Old cached clients send nothing and
      keep the minted-fresh behavior they always had.
    */
    tripData.tripId = req.body.logTripId;
  } else {
    tripData.tripId = crypto.randomUUID();
  }
  tripData.tripPart = tripPartInTimeZone(tripData.startTime, pick(operator, 'timezone', null));

  // Per-guest photos: prefer the guests[] payload ([{email, photoData|null}])
  // so each group on the boat gets a report with THEIR photo from a single
  // send (one trip on the widget). Older cached clients still send the flat
  // guestEmails list — those guests all share the trip photo.
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const rawGuests = Array.isArray(req.body.guests) && req.body.guests.length
    ? req.body.guests
    : (Array.isArray(guestEmails) ? guestEmails : [guestEmails]).map(e => ({ email: e }));
  const validGuests = rawGuests
    .map(g => ({
      email: String((g && g.email) || '').trim(),
      photoData: (g && typeof g.photoData === 'string' && /^data:image\//.test(g.photoData)) ? g.photoData : null,
      // Per-guest story card (client-rendered with this guest's photo).
      // Falls back to the shared legacy socialCardData when absent.
      socialCardData: (g && typeof g.socialCardData === 'string' && /^data:image\//.test(g.socialCardData)) ? g.socialCardData : null,
    }))
    .filter(g => emailRegex.test(g.email));
  const validEmails = validGuests.map(g => g.email);
  if (!isLogOnly && validEmails.length === 0) return res.status(400).json({ error: 'No valid email addresses provided' });

  try {
    // Fetch bathymetric depth for each sighting first so the PDF and
    // Supabase row both pick it up. Lookups run in parallel and are
    // capped at 3s each, so this adds at most ~3s to the trip end flow.
    await attachDepthsToSightings(tripData.sightings);

    // Log-only ends here: the trip is on the widget, nobody gets email.
    // Depths are attached above so the sighting rows match a full send's.
    if (isLogOnly) {
      /*
        Replay check, and it must come before any insert. logbook_trips
        upserts on trip_id, but the sightings insert is a plain POST, so a
        replayed submission would merge the trip row and still double every
        sighting inside it. When the client supplied a stable id and that id
        is already logged, the first request won: answer success with the
        same shape it got, insert nothing. Scoped to the operator so a
        guessed id from another tenant confirms nothing.
      */
      if (tripIdRe.test(String(req.body.logTripId || ''))) {
        const dupRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/logbook_trips?trip_id=eq.${tripData.tripId}&operator_id=eq.${operatorId}&select=trip_id&limit=1`,
          { headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` } },
        );
        if (dupRes.ok && (await dupRes.json()).length) {
          console.log(`send-report: trip ${tripData.tripId} already logged, replay answered idempotently`);
          const speciesCount = new Set((tripData.sightings || []).map(s => s.species)).size;
          const animalCount = (tripData.sightings || []).reduce((sum, s) => sum + (Number(s.count) || 0), 0);
          return res.status(200).json({
            success: true,
            trip_id: tripData.tripId,
            logged: { species: speciesCount, animals: animalCount },
            message: 'Trip already logged',
          });
        }
      }
      await saveToSupabase(tripData, operatorId);
      await saveLogbookTrip(tripData, operatorId);
      saveTrackToSupabase(tripTrack, operatorId, tripData.tripId)
        .catch(e => console.error('saveTrackToSupabase background error:', e.message));
      const speciesCount = new Set((tripData.sightings || []).map(s => s.species)).size;
      const animalCount = (tripData.sightings || []).reduce((sum, s) => sum + (Number(s.count) || 0), 0);
      return res.status(200).json({
        success: true,
        trip_id: tripData.tripId,
        logged: { species: speciesCount, animals: animalCount },
        message: 'Trip logged',
      });
    }

    // One PDF per distinct photo. Guests without their own photo share the
    // trip-photo PDF (tripData.photoData — may itself be absent). Generated
    // sequentially: PDFKit + embedded images are memory-heavy on a small
    // serverless function, and in practice there are only 1-3 groups.
    console.log('Generating PDFs...');
    const TRIP_PHOTO_KEY = '__trip__';
    const pdfByPhoto = new Map();
    for (const g of validGuests) {
      const key = g.photoData || TRIP_PHOTO_KEY;
      if (!pdfByPhoto.has(key)) {
        const data = g.photoData ? { ...tripData, photoData: g.photoData } : tripData;
        pdfByPhoto.set(key, await generatePDF(data, b));
      }
    }
    console.log('PDFs done:', pdfByPhoto.size);

    // Save to Supabase ONCE regardless of how many guests. Every row is
    // tagged with the operator_id derived from the verified JWT, so a
    // request from one operator can never write into another's data.
    // Skipped on an add-guests resend — the trip is already logged.
    if (!isAddGuests) {
      await saveToSupabase(tripData, operatorId);
      // GPS breadcrumb for the public widget's real boat-path render. Fire
      // and forget — a track failure shouldn't take down the report send.
      saveTrackToSupabase(tripTrack, operatorId, tripData.tripId)
        .catch(e => console.error('saveTrackToSupabase background error:', e.message));
    }

    // Record this trip's guests BEFORE the emails fire so getGuestStats()
    // (called inside sendEmail) sees today's row in its count. A first-timer
    // gets trips=1, a 2nd-trip guest gets trips=2.
    const tripDateISO = resolveTripDate(tripData);
    await recordGuestsForTrip(operatorId, tripDateISO, tripData.tripId, validEmails);

    // Send email + Mailchimp to each guest, plus the captain copy back to
    // ourselves — all in parallel. Captain copy failure never blocks the
    // guest emails (it swallows its own errors inside sendCaptainCopy).
    await Promise.all([
      ...validGuests.map(g => Promise.all([
        sendEmail(g.email, pdfByPhoto.get(g.photoData || TRIP_PHOTO_KEY), g.socialCardData || socialCardData, tripData, b, transporter, operatorId),
        addToMailchimp(g.email, b),
      ])),
      // The captain already got their copy on the original send — don't
      // re-send it on an add-guests resend.
      ...(isAddGuests ? [] : [sendCaptainCopy(captainCardData, tripData, b, transporter)]),
    ]);

    return res.status(200).json({ success: true, trip_id: tripData.tripId, message: `Trip report sent to ${validEmails.join(', ')}` });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: 'Failed to send trip report', detail: err.message });
  }
};
