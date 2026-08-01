# Flukelogs

The boat app of the **Flukesend platform**: captains log whale-watch trips from the water — GPS route, sightings, conditions, voice notes, photos — and everything lands in the shared Flukesend database, where it powers the operator's public sightings widget, live boat map, and pre-fills their Flukesend photo delivery.

**Flukelogs sends no guest email.** That's a design decision (2026-07-31, the "one guest email" architecture): guests scan the operator's Flukesend QR on the boat, the captain logs the trip here, and at home the operator's Flukesend send arrives **pre-filled** — species, head counts, boat, departure, crew — so the guest gets exactly one email: their branded gallery with the trip report. The PDF/Gmail/Mailchimp recap pipeline that used to live here is retired (legacy code paths remain until a cleanup pass; nothing calls them from current clients).

Sister repo: [`flukesend-hub/flukesend`](https://github.com/flukesend-hub/flukesend) — the Next.js app (delivery, reviews, billing, admin) **and the home of all database migrations** (`docs/0001…`). This repo's `db/migrations/` is frozen history from before the merge.

## The one-database architecture

Both products run on the **Flukesend Supabase project** (`ockpylhphwhumgulhvzv`) since the 2026-07-31 merge. Consequences that matter here:

- `operators` is the shared tenant table. Flukelogs reads its per-operator config (slug, logo, species list, buoy, map defaults, live-widget knobs) from columns on that row; Flukesend keeps its own settings in `branding`.
- **Auth is shared.** `lib/auth.js` resolves membership from `operator_users` first, then falls back to Flukesend's `operator_members` — so any existing Flukesend login (e.g. a Princess photographer) opens this app with zero provisioning.
- The Start screen's boat / departure / crew pickers read the operator's Flukesend roster live (`boats`, `crew_members`, `branding.trip_times`) via `/api/me`'s `roster` block. Set up once in Flukesend Settings, appears here automatically.
- Every logged trip writes `logbook_trips` (boat, departure, crew per `trip_id`) alongside `sightings` / `trip_track` — that row is what lets Flukesend's send form fill its whole Trip step.
- **Schema changes go in `flukesend/docs/` as numbered migrations.** Never here.

All client and API reads/writes go through service-role serverless endpoints (`api/*.js`); the logbook tables have RLS enabled with **no policies** on purpose — direct PostgREST access returns nothing.

## What it does (current flow)

1. Guest books on FareHarbor → webhook (`api/fh-webhook.js`, secret-keyed) saves the booking → trip-morning slot picker pre-fills passenger count
2. Captain picks boat / departure / crew (from the Flukesend roster; pickers only appear when there's a real choice; last-used defaults), sea conditions auto-fill from a NOAA buoy
3. GPS tracks the route (background-capable in the iOS app), distance in nautical miles
4. Captain logs each sighting: species (operator's own list), count, time, position; depth attached from NOAA bathymetry. Positions read in plotter format everywhere they appear — `N 36 47.331  W 121 50.570`, degrees and decimal minutes, so they can be compared to the helm without converting
5. Live position + live sighting dots stream to the public widget (delayed + fuzzed per operator settings) while the trip runs. **Several boats can broadcast at once**: each gets its own marker, dashed track, and roster colour (the same colour as that boat's Flukesend QR card), and the banner summarises the fleet ("2 boats out")
6. **End Trip → Log Trip**: sightings, track, and the `logbook_trips` record are written; nobody is emailed. The success screen states what's now public and hands off to Flukesend for photo delivery
7. Afterwards, per trip: audio recap (plays on the widget), photo gallery (widget hero/carousel), or **delete the trip** (type-to-confirm; removes rows + storage everywhere)
8. The operator's website widget (`/api/sightings?op=<slug>`) updates automatically; the same feed powers a ticket-office live display

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS single-page PWA (`trip-logger/index.html`), no build step |
| iOS | Capacitor shell (`mobile/`), bundle `com.flukesend.flukelogs`, **unlisted App Store distribution** — the binary pins `server.url` to this deployment, so web changes ship without App Review |
| Auth | Supabase Auth (shared with Flukesend; email+password in-app with a Forgot-password flow; Google exists on the Flukesend side only — OAuth can't run in the WKWebView) |
| Backend | Node serverless functions on Vercel (`trip-logger/api/*.js`) |
| Database | The **Flukesend** Supabase project — see architecture above |
| Storage | `media`, `trip-audio`, `trip-photos`, `operator-logos` buckets (all public) |
| Maps | Leaflet + markercluster (widget), Google Static Maps (server-rendered track) |
| Data feeds | NOAA NDBC buoys (conditions), NOAA NCEI DEM (per-sighting depth) |
| Bookings | FareHarbor outgoing webhooks |
| Hosting | Vercel — the deployment URL must stay `trip-logger-backend.vercel.app` (the shipped iOS binary, the FareHarbor webhook config, and operator embeds all pin it) |

## Key endpoints

- `/api/me` — user + operator config + roster (boats, crew, trip times)
- `/api/send-report` — **`mode: 'log-only'`** writes the trip (sightings, track, `logbook_trips`); the legacy full-send mode remains for old cached clients only
- `/api/operator/trips` — GET recent trips; **DELETE `?tripId=`** removes a trip everywhere (rows + storage files, operator-scoped)
- `/api/live-trip` — the app's live broadcast (heartbeat, sighting status, boat identity); tracks are thinned to one point per 20s server-side so a full-length trip fits under the row cap instead of losing its head
- `/api/widget-data?op=<slug>` — the only public reader, and where the privacy transforms live. Returns `live.boats[]` (one entry per broadcasting boat, each delay- and fuzz-transformed) and `trip_meta` (boat name + departure per `trip_id`, so two same-day trips label apart). The legacy single-boat fields still mirror `boats[0]`, so widget pages loaded before a deploy keep working
- `/api/sightings?op=<slug>` — serves the embeddable widget page (server-rendered for SEO)
- `/api/trip-audio`, `/api/trip-photos`, `/api/operator-settings`, `/api/admin/*`

## Environment variables (Vercel)

`SUPABASE_URL` + `SUPABASE_SECRET_KEY` (**the Flukesend project**), `GOOGLE_MAPS_API_KEY`, `FH_WEBHOOK_SECRET` + `FH_WEBHOOK_ENFORCE`, `PUBLIC_APP_URL`, plus legacy `FROM_EMAIL` / `FROM_NAME` / `GMAIL_USER` / `GMAIL_APP_PASSWORD` (unused by the log-only flow; removable once the legacy send path is deleted).

Note: `SUPABASE_URL` and the anon key are **also hardcoded client-side** in `trip-logger/index.html`, `trip-logger/profile.html`, and `trip-logger/api/sightings-widget.html` — changing projects means changing both the env vars *and* those three files (learned the hard way during the merge).

## Onboarding a new operator

Since the merge this is mostly data on the shared `operators` row:

1. The operator exists in Flukesend already (or create them there). On their `operators` row set: `slug`, `logo_url` / `logo_url_email`, `species_list` (grouped; **use their Flukesend `species_options` names verbatim** so send-form prefill matches exactly), and any non-default map / buoy / timezone values.
2. Logins: none needed — their Flukesend members sign in directly (membership fallback). Google-only accounts need a password: the in-app **Forgot password** flow sets one. If sign-in still fails after that, the account may lack an `email` identity row in `auth.identities` — add one.
3. Boats / crew / trip times: already theirs, from Flukesend Settings.
4. The public widget is theirs to configure in **Settings → Public Widget**: show the sightings map, show the live boat while on the water, and the live position delay (5 / 10 / 15 min). The live layer is **off until the operator turns it on** — no operator row editing required, and nothing about a trip is published live until they opt in.
5. Share the unlisted App Store link (App Store Connect → Pricing and Availability). The native app is required for locked-screen GPS; the web app is fine for everything else.
6. FareHarbor prefill (optional): their `fh_company_shortname` / keys on the operator row, and their FH webhook pointed at `/api/fh-webhook?key=…` (Bookings-only schema, New + Updated triggers).

Operators as of 2026-08-01: Enocean Tours (`enocean`), Princess Whale Watching (`princess`), Bayside Whale Watch (`demo` — the Apple-reviewer tenant; keep it working).

### Operators who run several boats at once

Princess runs concurrent departures with a different photographer on each boat, which is the case the app is now built for. Worth knowing:

- Trip identity is **per device**, not per login, so two photographers can share one account or use their own and still log fully independent trips.
- The departure picker defaults to the **nearest** scheduled time, not the latest one already past, so boarding the 10:00 at 09:50 does not stamp the trip 09:00 — the departure another boat may be out running.
- Flukesend's send prefill matches a logged trip on **boat + date + departure**, so each photographer's send fills from their own boat's log ([`src/lib/logbook.ts`](https://github.com/flukesend-hub/flukesend/blob/main/src/lib/logbook.ts)).
- Widget trip cards on a multi-trip day are titled with the departure and boat (`9:00 AM · Princess`) instead of a bare daypart that would read identically for both.

## History

This repo began as "Enocean Tours Trip Logger" with its own Supabase project (`czotpzjtnuukoxscjduj`, now dormant), and emailed guests PDF recaps via per-operator Gmail + Mailchimp. Renamed Flukelogs 2026-07-02 (App Store saga documented in `docs/app-store-submission.md`); merged onto the Flukesend database 2026-07-31 (migrations `flukesend/docs/0041–0043`); guest email moved wholly to Flukesend the same day. Everything in `docs/` and `db/migrations/` here is historical context from that era.

**2026-08-01 — first real multi-boat day.** Princess ran concurrent departures with a photographer on each boat, which surfaced a batch of single-boat assumptions, all now fixed: the widget's live layer published only the newest heartbeat (so two live boats made one marker flip-flop between two routes), the departure picker defaulted to the latest time already past, and the send prefill matched without regard to boat. Same day: the live track was thinned so a full-length trip stays on the map instead of losing its head to the row cap, the live banner stopped throwing away the day's best sighting after 15 minutes, the live-widget toggle and position delay became operator settings instead of hand-edited columns, and coordinates everywhere switched to plotter format. Migration `flukesend/docs/0046` added boat identity to `live_trips`.

Built by Slater Moore — Captain, Marine Wildlife Cinematographer, Moss Landing Harbor.
