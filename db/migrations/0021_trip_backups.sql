-- 0021: cloud backup of in-progress trips.
--
-- Until "Send Report" succeeds, a captain's phone is the ONLY holder of an
-- active trip (localStorage). Deleting the app, a dead phone, or a phone
-- overboard loses the entire trip — happened for real on 2026-07-30 (route
-- + sightings unrecoverable; trip had to be reconstructed by hand).
--
-- The app now upserts the serialized trip here every couple of minutes
-- during an active trip (and on end-trip). On boot, if a captain has no
-- local trip but a cloud backup exists, the app offers to restore it.
-- One row per captain user — they run one trip at a time.
--
-- Service-role access only (via /api/trip-backup): RLS enabled with NO
-- policies, same posture as trip_track.

create table if not exists public.trip_backups (
  user_id     uuid primary key,
  operator_id uuid not null references public.operators(id) on delete cascade,
  trip_json   jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.trip_backups enable row level security;
