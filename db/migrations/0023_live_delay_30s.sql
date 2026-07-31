-- 0023: shorten the live-position delay to 30 seconds.
--
-- Two minutes of trailing made the live layer feel laggy without buying
-- meaningful extra privacy on top of the 0.01-degree fuzz grid, which stays
-- unchanged. live_delay_minutes becomes numeric so it can hold sub-minute
-- values (0.5 = 30s); /api/widget-data already computes the cutoff in ms
-- from a fractional minute.

alter table operators alter column live_delay_minutes drop default;
alter table operators alter column live_delay_minutes type numeric
  using live_delay_minutes::numeric;
alter table operators alter column live_delay_minutes set default 0.5;

update operators set live_delay_minutes = 0.5;
