# NextUp 🎬🎵📺

**A full-stack recommendation platform for movies, TV, and music that uses an LLM reasoning layer to give personalized recommendations and explain why each one fits.**

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://nextup-pi.vercel.app)
[![Built with Next.js](https://img.shields.io/badge/Next.js-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![Deployed on Vercel](https://img.shields.io/badge/Vercel-black?logo=vercel)](https://vercel.com/)

**Live app:** [nextup-pi.vercel.app](https://nextup-pi.vercel.app)

---

## Overview

Most recommenders match you on genre and hand back a ranked list. NextUp builds a single taste profile that spans movies, TV, and music, then asks an LLM to reason over that profile the way a friend with good taste would. It focuses on mood, tone, and pacing instead of genre labels.

Every recommendation is picked from a catalog of real titles and artists pulled from the TMDB and Last.fm APIs, so the model chooses from verified metadata instead of inventing things. Each pick comes with a short explanation of why it fits you.

**Example:** if your profile shows you love atmospheric, slow-burn films, NextUp can connect that to moody ambient music and recommend in either direction, with a note explaining the link.

## ✨ Features

- **Taste quiz onboarding:** rate titles and artists (Loved it / Liked it / Not for me / Haven't seen it), then answer a few open questions about how you like to watch and listen
- **LLM taste profile synthesis:** quiz answers are turned into a structured profile covering tone, themes, pacing, favorite eras, things to avoid, and a plain-language summary
- **Cross-media recommendations:** ask for a movie, a show, music, or "surprise me," and the engine draws on your whole profile across all three
- **Context-aware asks:** type what you're in the mood for ("something light, I'm tired tonight") or use quick chips for mood, time available, and who you're watching with
- **Explainable results:** every pick includes an LLM-written reason it fits your taste and the moment
- **Grounded in real metadata:** candidates are filtered from the TMDB and Last.fm catalog before the LLM ever sees them, so it can't recommend titles that don't exist
- **Feedback loop:** thumbs up/down, "already seen/heard," and "not for me" reactions feed back into your taste profile so future recommendations improve
- **Secure by design:** row-level security on every user table in a 7-table PostgreSQL schema
- **Auth and production deploy:** Supabase Auth, with continuous deployment from GitHub to Vercel

## 🏗️ Architecture

```
Taste quiz ─▶ Taste profile synthesis (Claude API) ─▶ taste_profiles
                                                          │
User ask + context ──────────────────────────────────────┤
                                                          ▼
          Candidate filtering from verified catalog (TMDB / Last.fm metadata)
                                                          │
                                                          ▼
          LLM reasoning layer (Claude API): picks + explanations
                                                          │
                                                          ▼
          Explainable recommendations ─▶ Next.js frontend
                                                          │
                                                          ▼
          User feedback ─▶ profile re-synthesis
```

### How a recommendation is made

1. **Profile:** the user's quiz responses and feedback history are synthesized into a structured taste profile stored as JSON.
2. **Candidates:** the catalog is narrowed to a candidate set using genre and tag overlap with the profile and the user's request. Trigram and GIN indexes keep this fast.
3. **Reasoning:** the profile, the request, and the candidate set go to Claude, which picks the best fits and writes an explanation for each one.
4. **Feedback:** reactions are saved and periodically fold back into the profile, so the next round of recommendations reflects what the user actually liked.

Because the model only chooses from candidates that already exist in the database, every recommendation maps to a real title or artist with a poster, overview, and metadata.

### Data layer

A 7-table PostgreSQL schema in Supabase:

| Table | Purpose |
|---|---|
| `profiles` | User records linked to Supabase Auth (created by trigger on signup) |
| `titles` | Movies and TV shows with TMDB metadata: genres, keywords, overview, year, poster |
| `artists` | Artists with Last.fm metadata and tags |
| `quiz_responses` | A user's ratings of titles and artists during onboarding |
| `taste_profiles` | The synthesized taste profile for each user (JSON) |
| `recommendations` | Each ask, its context, and the returned picks |
| `feedback` | Reactions to individual recommendations |

Row-level security policies make sure users can only read and write their own data. Trigram and GIN indexes support fast fuzzy search and tag overlap queries across the catalog.

## 🛠️ Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js (App Router), React, TypeScript, Tailwind CSS |
| Backend | Next.js API routes |
| Database | Supabase, PostgreSQL (RLS, trigram/GIN indexes) |
| Auth | Supabase Auth |
| LLM | Claude API (taste synthesis, reasoning, explanations) |
| External data | TMDB API, Last.fm API |
| Deploy / CI-CD | GitHub, Vercel (auto-deploy on push) |

## 📊 At a glance

- **3** media types (movies, TV, music) in one taste profile
- **2** external metadata sources (TMDB, Last.fm) grounding every recommendation
- **7** PostgreSQL tables, all user data protected by row-level security
- **1** LLM reasoning layer handling taste synthesis, picks, and explanations

<!-- Once measured, consider adding: catalog size (count(*) on titles + artists) and number of real test users. -->


## 🚀 Getting Started

### Prerequisites

- Node.js 22+
- A Supabase project
- API keys for TMDB, Last.fm, and Anthropic

### Setup

```bash
git clone https://github.com/aababel/nextup.git
cd nextup
npm install
cp .env.example .env.local   # add your Supabase, TMDB, Last.fm, and Claude keys
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

### Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
TMDB_API_KEY=
LASTFM_API_KEY=
ANTHROPIC_API_KEY=
```

### Seeding the catalog

The catalog is built from curated lists of titles and artists. Seed scripts take those lists, fetch full metadata from TMDB and Last.fm, and write the results to the `titles` and `artists` tables.

## 📸 Screenshots

<!-- Add 2-3 screenshots or a short GIF: the quiz, the ask screen, and a recommendation card with its explanation. -->

## 🧭 Design decisions

- **Open data over platform APIs.** Spotify has deprecated its recommendation and audio features endpoints for third-party developers, and Netflix has no public API. Building on TMDB and Last.fm keeps the product independent of integrations I don't control.
- **A quiz instead of OAuth for v1.** A well-designed onboarding quiz gets a strong taste signal without the complexity of account linking.
- **Reasoning is the product.** The value is in how the LLM connects taste across media, so the prompts for profile synthesis and cross-domain reasoning got the most iteration time.
- **Grounding before generation.** Filtering to real candidates first, then letting the model reason, prevents hallucinated recommendations.

## 🧠 What I learned

- Designing a normalized, secure relational schema with RLS and a deliberate indexing strategy
- Grounding LLM output against a source of truth to prevent hallucination
- Writing and iterating on prompts as core product logic, not an afterthought
- Shipping a real CI/CD pipeline from design to production

## 🔮 Future work

- Optional imports from Spotify and Netflix viewing history
- Expanding the catalog beyond the curated starter set
- Books and podcasts as additional domains

## 📄 License

MIT
