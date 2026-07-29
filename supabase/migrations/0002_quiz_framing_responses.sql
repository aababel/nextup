-- NextUp — Day 3: framing-question answers
--
-- The title-by-title quiz writes to `quiz_responses` (one row per title,
-- constrained response enum). The 3-4 open framing questions ("comforted or
-- challenged?", "fast-paced or slow-burn?", ...) don't fit that shape — one
-- row per question per user, free-form response text, no title/artist
-- subject. `taste_profiles` isn't the right home either: it's the
-- Day 4 *synthesized* output, not raw intake. Hence a small dedicated table,
-- confirmed with Aarav before adding it.

create table public.quiz_framing_responses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  question_key text not null,
  response text not null,
  created_at timestamptz not null default now()
);

create index quiz_framing_responses_user_id_idx on public.quiz_framing_responses (user_id);

-- One answer per user per question (re-answering updates, not duplicates).
create unique index quiz_framing_responses_user_question_uidx
  on public.quiz_framing_responses (user_id, question_key);

alter table public.quiz_framing_responses enable row level security;

create policy "quiz_framing_responses_select_own" on public.quiz_framing_responses
  for select using (auth.uid() = user_id);
create policy "quiz_framing_responses_insert_own" on public.quiz_framing_responses
  for insert with check (auth.uid() = user_id);
create policy "quiz_framing_responses_update_own" on public.quiz_framing_responses
  for update using (auth.uid() = user_id);
