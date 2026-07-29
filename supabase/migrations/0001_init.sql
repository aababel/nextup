-- NextUp initial schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).

-- ============================================================================
-- Extensions
-- ============================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()
create extension if not exists "pg_trgm"; -- gin_trgm_ops, powers name search indexes

-- ============================================================================
-- profiles (public-schema mirror of auth.users)
--
-- Supabase already maintains `auth.users` (id, email, created_at, etc.) in the
-- protected `auth` schema. We do NOT duplicate that table. Instead we keep a
-- thin `public.profiles` row per user, 1:1 with auth.users, because:
--   1. `auth.users` is not exposed via the PostgREST API, so client-side
--      queries/joins (e.g. "recommendations for this user") can't reach it.
--   2. Foreign keys from public tables read more clearly pointing at a public
--      table, and it gives us a place to add profile fields later (display
--      name, avatar, preferences) without touching the auth schema.
-- `profiles.id` IS `auth.users.id` (same value, enforced by the FK below), so
-- there is no separate identity to manage.
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- titles (movies / tv shows, sourced from TMDB)
-- ============================================================================

create table public.titles (
  id uuid primary key default gen_random_uuid(),
  tmdb_id integer not null,
  name text not null,
  type text not null check (type in ('movie', 'tv')),
  genres text[] not null default '{}',
  keywords text[] not null default '{}',
  overview text,
  release_year integer,
  poster_url text,
  created_at timestamptz not null default now(),
  unique (tmdb_id, type)
);

create index titles_type_idx on public.titles (type);
create index titles_release_year_idx on public.titles (release_year);
create index titles_genres_gin_idx on public.titles using gin (genres);
create index titles_keywords_gin_idx on public.titles using gin (keywords);
create index titles_name_trgm_idx on public.titles using gin (name gin_trgm_ops);

-- ============================================================================
-- artists (musicians/bands, sourced from Last.fm)
-- ============================================================================

create table public.artists (
  id uuid primary key default gen_random_uuid(),
  lastfm_id text not null unique,
  name text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index artists_tags_gin_idx on public.artists using gin (tags);
create index artists_name_trgm_idx on public.artists using gin (name gin_trgm_ops);

-- ============================================================================
-- quiz_responses (taste-quiz answers, one row per title OR artist rated)
-- ============================================================================

create table public.quiz_responses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title_id uuid references public.titles (id) on delete cascade,
  artist_id uuid references public.artists (id) on delete cascade,
  response text not null check (response in ('loved', 'liked', 'meh', 'havent_seen')),
  created_at timestamptz not null default now(),
  constraint quiz_responses_exactly_one_subject check (
    (title_id is not null and artist_id is null) or
    (title_id is null and artist_id is not null)
  )
);

create index quiz_responses_user_id_idx on public.quiz_responses (user_id);
create index quiz_responses_title_id_idx on public.quiz_responses (title_id);
create index quiz_responses_artist_id_idx on public.quiz_responses (artist_id);

-- One response per user per title/artist (re-answering updates, not duplicates).
create unique index quiz_responses_user_title_uidx
  on public.quiz_responses (user_id, title_id) where title_id is not null;
create unique index quiz_responses_user_artist_uidx
  on public.quiz_responses (user_id, artist_id) where artist_id is not null;

-- ============================================================================
-- taste_profiles (synthesized summary of a user's taste, one row per user)
-- ============================================================================

create table public.taste_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  profile_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- recommendations (a generated batch of recommendations for a user)
-- ============================================================================

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  context_input text,
  recommended_items_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index recommendations_user_id_idx on public.recommendations (user_id);
create index recommendations_created_at_idx on public.recommendations (created_at desc);

-- ============================================================================
-- feedback (thumbs up/down etc. on a specific recommended item)
--
-- The brief describes a single `item_id`, but recommended items can be either
-- a title or an artist (same ambiguity as quiz_responses). A bare `item_id`
-- can't carry a real foreign key since it might point at either table, so it
-- mirrors the quiz_responses pattern: two nullable FKs + a check constraint
-- that exactly one is set. That keeps referential integrity instead of a
-- dangling, unconstrained uuid.
-- ============================================================================

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  recommendation_id uuid references public.recommendations (id) on delete cascade,
  title_id uuid references public.titles (id) on delete cascade,
  artist_id uuid references public.artists (id) on delete cascade,
  reaction text not null check (reaction in ('thumbs_up', 'thumbs_down', 'seen', 'not_for_me')),
  created_at timestamptz not null default now(),
  constraint feedback_exactly_one_subject check (
    (title_id is not null and artist_id is null) or
    (title_id is null and artist_id is not null)
  )
);

create index feedback_user_id_idx on public.feedback (user_id);
create index feedback_recommendation_id_idx on public.feedback (recommendation_id);
create index feedback_title_id_idx on public.feedback (title_id);
create index feedback_artist_id_idx on public.feedback (artist_id);

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.titles enable row level security;
alter table public.artists enable row level security;
alter table public.quiz_responses enable row level security;
alter table public.taste_profiles enable row level security;
alter table public.recommendations enable row level security;
alter table public.feedback enable row level security;

-- profiles: a user can see and update only their own row. Inserts happen only
-- via the handle_new_user trigger (security definer), so no insert policy.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- titles / artists: shared catalog data. Readable by any signed-in user;
-- writes are intentionally left to the service_role key (e.g. an ingestion
-- job), so no insert/update/delete policies are defined for regular users.
create policy "titles_select_authenticated" on public.titles
  for select using (auth.role() = 'authenticated');
create policy "artists_select_authenticated" on public.artists
  for select using (auth.role() = 'authenticated');

-- quiz_responses: full CRUD, but only on your own rows.
create policy "quiz_responses_select_own" on public.quiz_responses
  for select using (auth.uid() = user_id);
create policy "quiz_responses_insert_own" on public.quiz_responses
  for insert with check (auth.uid() = user_id);
create policy "quiz_responses_update_own" on public.quiz_responses
  for update using (auth.uid() = user_id);
create policy "quiz_responses_delete_own" on public.quiz_responses
  for delete using (auth.uid() = user_id);

-- taste_profiles: full CRUD, own row only.
create policy "taste_profiles_select_own" on public.taste_profiles
  for select using (auth.uid() = user_id);
create policy "taste_profiles_insert_own" on public.taste_profiles
  for insert with check (auth.uid() = user_id);
create policy "taste_profiles_update_own" on public.taste_profiles
  for update using (auth.uid() = user_id);

-- recommendations: read your own; inserts are made with the caller's own
-- user_id. Treated as immutable once created, so no update policy.
create policy "recommendations_select_own" on public.recommendations
  for select using (auth.uid() = user_id);
create policy "recommendations_insert_own" on public.recommendations
  for insert with check (auth.uid() = user_id);

-- feedback: full CRUD, own row only.
create policy "feedback_select_own" on public.feedback
  for select using (auth.uid() = user_id);
create policy "feedback_insert_own" on public.feedback
  for insert with check (auth.uid() = user_id);
create policy "feedback_update_own" on public.feedback
  for update using (auth.uid() = user_id);
create policy "feedback_delete_own" on public.feedback
  for delete using (auth.uid() = user_id);
