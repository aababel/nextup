-- NextUp: switch the catalog source from OMDb to TMDB.
--
-- The OMDb seed wrote IMDb ids ("tt0034583") into `tmdb_id`, and that column
-- was changed to text directly in the SQL Editor. This migration gives each id
-- its own honest column:
--   imdb_id: the curator-verified id from titles.csv (renamed from tmdb_id)
--   tmdb_id: TMDB's numeric id, filled in by the new TMDB seed script
-- Rows are kept in place, so titles.id (referenced by quiz_responses) never changes.

begin;

alter table public.titles rename column tmdb_id to imdb_id;

alter table public.titles add column tmdb_id integer;
alter table public.titles add column runtime_minutes integer;

create unique index titles_tmdb_id_type_uidx
  on public.titles (tmdb_id, type);

commit;