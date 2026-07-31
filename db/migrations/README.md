# Frozen — do not add migrations here

These files (0001–0024) built the original standalone trip-logger Supabase
project and are kept as history. Since the 2026-07-31 merge, both products run
on the Flukesend Supabase project, and **every schema change is a numbered
migration in `flukesend/docs/`** (the logbook tables were recreated there as
`0041_logbook_merge`, storage as `0042`, `logbook_trips` as `0043`).

Adding a file here would create a second, conflicting migration history against
the same shared database. Don't.
