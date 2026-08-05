# Flukelogs

The boat app of the **Flukesend platform**. Captains log whale watch trips from
the water (GPS route, sightings, conditions, voice notes, photos); the data
lands in the shared Flukesend database, powers the operator's public sightings
widget and live boat map, and pre-fills their Flukesend photo delivery.

Read the README first. It covers the one database architecture, the current
flow, and operator onboarding. Everything in `docs/` and `db/migrations/` is
historical context from before the July 31, 2026 merge; do not treat it as
current.

## Standing constraints

- **The database is the Flukesend project** (`ockpylhphwhumgulhvzv`), shared
  with the other app (repo `FlukeHQ/flukesend`, separate deployment).
  **Schema changes go in that repo's `docs/` as numbered migrations**, never in
  this repo's frozen `db/migrations/`.
- **`trip-logger-backend.vercel.app` must keep serving this app.** The shipped
  unlisted iOS binary pins it as `server.url`, the FareHarbor webhook points at
  it, and operator embeds load from it. Changing the deployment URL means a new
  App Store binary. This is also why **Vercel deployment protection must stay
  OFF on this project**: Standard Protection walls the generated production
  URL, which would lock every captain out. Revisit only after a binary ships
  pointing at a custom domain (`flukelogs.com` is bought and already aliases
  this deployment, unused until then).
- **Where things live (since 2026-08-04):** this repo is
  `FlukeHQ/flukelogs-backend` on GitHub; the Vercel project is
  `trip-logger-backend` in the FlukeSend team. The name mismatch is
  intentional, see the constraint above. Do not rename either side.
- **Flukelogs sends no guest email.** Guest delivery is Flukesend's job, one
  gallery email per guest. The legacy PDF, Gmail SMTP, and Mailchimp code paths
  are dead and awaiting a cleanup pass; do not revive them or route new guest
  mail through here.
- `SUPABASE_URL` and the anon key are **hardcoded client side** in
  `trip-logger/index.html`, `trip-logger/profile.html`, and
  `trip-logger/api/sightings-widget.html`, as well as being Vercel env vars.
  Both must change together; missing this broke every login during the merge.
- The service role key is server only. Logbook tables have RLS on with **no
  policies** on purpose: all access goes through `api/*.js` service role
  endpoints, so a direct PostgREST read returns nothing. Keep it that way.
- Live production with real operators (Enocean, Princess) logging real trips.
  Be careful with data fixes; do not touch a trip that is currently live.
- **The live layer is deliberately imprecise.** Positions published while a boat
  is out are delayed (operator picks 5/10/15 min) and snapped to a coarse grid,
  so nobody can steer to the boat or the animals in real time. Do not print
  coordinates for a live boat or live sighting dot, do not shrink the delay
  below the operator's setting, and do not add a "precise" mode. Finished trips
  are a different matter: their positions are exact and public by design.
- **Assume several boats are out at once.** Princess runs concurrent departures
  with a photographer on each. Anything keyed to "the operator's current trip"
  or "today's trip" is a bug waiting to happen; key on `trip_id`, and on
  boat + date + departure when matching across to Flukesend.
- No em dashes in copy or comments, matching the sister repo.

## Stack

Vanilla HTML/CSS/JS single page PWA (`trip-logger/index.html`, no build step)
plus Node serverless functions (`trip-logger/api/*.js`) on Vercel. Capacitor
shell in `mobile/` for the iOS app (bundle `com.flukesend.flukelogs`, unlisted
distribution). Auth is Supabase, shared with Flukesend: `lib/auth.js` resolves
membership from `operator_users` then falls back to `operator_members`, so any
Flukesend login opens this app.

## Ship loop

Edit, syntax check (`node --check` for API files; extract and check the inline
script block for index.html), commit, push the working branch, wait for the
Vercel preview to go READY, verify on the preview URL, open a PR, merge, then
confirm production. Web changes reach the iOS app with no App Store review
because the shell loads `server.url`.
