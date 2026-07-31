-- 0021: live trip broadcasting for the public sightings widget.
--
-- One row per in-progress trip, keyed by a client-minted live id (the real
-- trip_id isn't minted until the report is sent). Exact coordinates live
-- ONLY in this table and are served to the public through /api/widget-data,
-- which applies the operator's privacy transform (delay + fuzz) at READ
-- time — so the published position is always both minutes old and rounded
-- to a coarse grid, while the knobs stay tunable per operator without a
-- deploy.
--
-- RLS is enabled with NO policies: direct anon/authenticated PostgREST
-- reads return nothing; all access goes through service-role endpoints
-- (same isolation model as trip_track, see migration 0018/0019).

create table if not exists live_trips (
  trip_id        uuid primary key,
  operator_id    uuid not null references operators(id) on delete cascade,
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  status_species text,                                 -- "currently watching X"
  status_at      timestamptz,
  track          jsonb not null default '[]'::jsonb,   -- [{lat,lng,t}] exact; capped by the endpoint
  ended_at       timestamptz                           -- null = live
);

alter table live_trips enable row level security;

create index if not exists live_trips_active_idx
  on live_trips (operator_id) where ended_at is null;

-- Per-operator knobs for the live layer. Off by default — each operator
-- opts in (Enocean flipped on at rollout). fuzz 0.01 deg ~= 0.6 nm.
alter table operators add column if not exists live_widget_enabled boolean not null default false;
alter table operators add column if not exists live_delay_minutes  integer not null default 2;
alter table operators add column if not exists live_fuzz_deg       numeric not null default 0.01;
