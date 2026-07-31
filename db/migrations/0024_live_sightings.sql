-- 0024: live sightings on the broadcast row.
--
-- When the captain logs a sighting mid-trip, the app's status push now
-- carries the position too, appended here as [{species,count,lat,lng,t}].
-- Same privacy model as track: exact values live only in this table;
-- /api/widget-data applies the operator's delay + fuzz before anything is
-- published. Ephemeral like the rest of the row — the permanent sighting
-- record still comes from the trip report at trip end.

alter table live_trips add column if not exists
  sightings jsonb not null default '[]'::jsonb;
