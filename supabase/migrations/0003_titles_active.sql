-- NextUp — record the `active` flag added to `titles` via the SQL Editor.
--
-- Retired titles are soft-deleted (active = false), never hard-deleted,
-- because existing quiz_responses rows reference them by title_id. The quiz
-- must filter on active = true so retired titles stop appearing in new
-- sessions; historical responses referencing them remain intact.
--
-- This file documents a change already applied directly in the Supabase SQL
-- Editor (not run through this repo). `if not exists` / idempotent guards are
-- used so re-running this migration against that already-patched database is
-- a no-op instead of an error.

alter table public.titles
  add column if not exists active boolean not null default true;

create index if not exists titles_active_idx on public.titles (active);
