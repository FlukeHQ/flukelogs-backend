-- 0022: per-operator standalone widget URL.
--
-- widget_host_url (0008) is the operator's own page that EMBEDS the widget
-- in an iframe — right for share links, wrong for the full-screen breakout:
-- an iframe can't go full screen without the host granting it, so the
-- breakout needs the widget standing alone. This is that address — a bare
-- branded domain serving the widget directly (e.g. Enocean's
-- https://sightings.enoceantours.com) — used when the expand button has to
-- escape an embed. Null => fall back to the widget's own current URL.

alter table operators add column if not exists widget_standalone_url text;

update operators set widget_standalone_url = 'https://sightings.enoceantours.com'
  where slug = 'enocean';
