/**
 * NextUp: title-seeding script (TMDB version)
 *
 * Replaces seed-titles-omdb.mjs. Reads the same curated titles.csv
 * (Title,Type,ImdbId,ExpectedYear) and, for each row:
 *   1. Maps the curator-verified IMDb id to a TMDB id via /find (exact lookup,
 *      no fuzzy title search, so nothing like the old "Se7en" mismatch).
 *   2. Fetches full details plus keywords from /movie/{id} or /tv/{id}.
 *   3. Upserts into `titles` on (imdb_id, type). Existing rows are UPDATED IN
 *      PLACE, so titles.id never changes and quiz_responses stay linked.
 *
 * Requires migration 0004_titles_tmdb_ids.sql (imdb_id + tmdb_id columns).
 *
 * Safety checks. A row is NOT written, and is logged to
 * tmdb-review-needed.log instead, when:
 *   - TMDB has no entry for the IMDb id
 *   - TMDB only has it as the other type (e.g. csv says Movie, TMDB says TV)
 *   - the year differs by more than 1 from ExpectedYear in the csv, or from
 *     the release_year already stored in the database (the OMDb value)
 *
 * `active` is never written: new rows get the default (true) and existing
 * rows keep whatever flag they have, so re-running never un-retires a title.
 *
 * ---- Env vars (read from .env.local via --env-file) ----
 *   TMDB_READ_ACCESS_TOKEN     the long "API Read Access Token"
 *   SUPABASE_URL               (falls back to NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY  service role, needed to write past RLS
 *
 * ---- Run ----
 *   node --env-file=.env.local seed-titles-tmdb.mjs            # dry run, no DB writes
 *   node --env-file=.env.local seed-titles-tmdb.mjs --insert   # write to Supabase
 *
 * TMDB has no daily cap (only a per-second rate limit), so the whole list
 * runs in one go. Re-running is safe: every write is an idempotent upsert.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOULD_INSERT = process.argv.includes("--insert");

const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const REQUEST_DELAY_MS = 120; // well under TMDB's ~50 req/s limit
const MAX_KEYWORDS = 25;

const CSV_PATH = path.resolve("./titles.csv");
const OUT_PATH = path.resolve("./titles-tmdb-seed.json");
const REVIEW_LOG_PATH = path.resolve("./tmdb-review-needed.log");
const FAILED_LOG_PATH = path.resolve("./tmdb-failed.log");

for (const [name, value] of [
  ["TMDB_READ_ACCESS_TOKEN", TMDB_TOKEN],
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
]) {
  if (!value) {
    console.error(`Missing ${name}. Add it to .env.local and run with --env-file=.env.local.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CSV parsing (same rules as the OMDb script: quoted fields, "" escapes, BOM)
// ---------------------------------------------------------------------------

function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function parseCsv(text) {
  const clean = text.replace(/^﻿/, "").trim();
  const lines = clean.split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf("title");
  const typeIdx = header.indexOf("type");
  const imdbIdx = header.indexOf("imdbid");
  const yearIdx = header.indexOf("expectedyear");
  if (titleIdx === -1 || typeIdx === -1 || imdbIdx === -1) {
    throw new Error(`titles.csv needs Title, Type, ImdbId columns. Found: ${header.join(", ")}`);
  }
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = parseCsvLine(line);
    const rawType = (cols[typeIdx] ?? "").trim().toLowerCase();
    const expectedYearRaw = yearIdx === -1 ? "" : (cols[yearIdx] ?? "").trim();
    return {
      title: cols[titleIdx].trim(),
      type: rawType === "tv" ? "tv" : rawType === "movie" ? "movie" : null,
      imdb_id: (cols[imdbIdx] ?? "").trim(),
      expected_year: expectedYearRaw ? parseInt(expectedYearRaw, 10) : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// TMDB helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmdbGet(pathAndQuery, attempt = 1) {
  const res = await fetch(`${TMDB_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, accept: "application/json" },
  });
  if (res.status === 429 && attempt <= 3) {
    const waitSec = Number(res.headers.get("retry-after")) || 2;
    await sleep(waitSec * 1000);
    return tmdbGet(pathAndQuery, attempt + 1);
  }
  if (res.status === 401) {
    console.error("TMDB rejected the token (401). Check TMDB_READ_ACCESS_TOKEN in .env.local.");
    process.exit(1);
  }
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} on ${pathAndQuery}`);
  }
  return res.json();
}

function yearOf(dateStr) {
  const match = String(dateStr ?? "").match(/^(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

function buildRecord(row, details) {
  const isMovie = row.type === "movie";
  const keywordList = isMovie ? details.keywords?.keywords : details.keywords?.results;
  const runtime = isMovie ? details.runtime : details.episode_run_time?.[0];
  return {
    imdb_id: row.imdb_id,
    tmdb_id: details.id,
    type: row.type,
    name: isMovie ? details.title : details.name,
    genres: (details.genres ?? []).map((g) => g.name),
    keywords: (keywordList ?? []).slice(0, MAX_KEYWORDS).map((k) => k.name),
    overview: details.overview || null,
    release_year: yearOf(isMovie ? details.release_date : details.first_air_date),
    poster_url: details.poster_path ? `${POSTER_BASE}${details.poster_path}` : null,
    runtime_minutes: runtime || null,
  };
}

function appendLog(logPath, entry) {
  fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf-8"));
  console.log(`Loaded ${rows.length} titles from titles.csv`);

  for (const row of rows) {
    if (!/^tt\d+$/.test(row.imdb_id) || !row.type) {
      console.error(`Bad ImdbId or Type for "${row.title}". Fix titles.csv and re-run.`);
      process.exit(1);
    }
  }

  // Fresh logs each run, so they only describe this run.
  for (const p of [REVIEW_LOG_PATH, FAILED_LOG_PATH]) if (fs.existsSync(p)) fs.unlinkSync(p);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Existing rows, used for the year cross-check and to report updates vs inserts.
  const { data: existingRows, error: readError } = await supabase
    .from("titles")
    .select("imdb_id, type, release_year");
  if (readError) {
    console.error(`Couldn't read titles table: ${readError.message}`);
    console.error("Has migration 0004_titles_tmdb_ids.sql been run?");
    process.exit(1);
  }
  const existing = new Map(existingRows.map((r) => [`${r.imdb_id}|${r.type}`, r]));

  const seeded = [];
  let updated = 0;
  let inserted = 0;
  let needsReview = 0;
  let failed = 0;

  for (const [i, row] of rows.entries()) {
    const label = `[${i + 1}/${rows.length}]`;
    try {
      const found = await tmdbGet(`/find/${row.imdb_id}?external_source=imdb_id`);
      await sleep(REQUEST_DELAY_MS);

      const matches = row.type === "movie" ? found.movie_results : found.tv_results;
      const otherType = row.type === "movie" ? found.tv_results : found.movie_results;
      if (!matches?.length) {
        const reason = otherType?.length ? "tmdb_has_other_type" : "tmdb_not_found";
        appendLog(REVIEW_LOG_PATH, { title: row.title, imdb_id: row.imdb_id, type: row.type, reason });
        console.log(`${label} NEEDS REVIEW: ${row.title} (${reason})`);
        needsReview++;
        continue;
      }

      const details = await tmdbGet(
        `/${row.type}/${matches[0].id}?append_to_response=keywords&language=en-US`
      );
      await sleep(REQUEST_DELAY_MS);

      const record = buildRecord(row, details);
      const prior = existing.get(`${row.imdb_id}|${row.type}`);
      const checkYear = row.expected_year ?? prior?.release_year;
      if (checkYear && (!record.release_year || Math.abs(record.release_year - checkYear) > 1)) {
        appendLog(REVIEW_LOG_PATH, {
          title: row.title,
          imdb_id: row.imdb_id,
          reason: "year_mismatch",
          expected_year: checkYear,
          tmdb_title: record.name,
          tmdb_year: record.release_year,
        });
        console.log(`${label} NEEDS REVIEW: ${row.title} (expected ${checkYear}, TMDB says ${record.release_year})`);
        needsReview++;
        continue;
      }

      if (SHOULD_INSERT) {
        const { error } = await supabase.from("titles").upsert(record, { onConflict: "imdb_id,type" });
        if (error) throw new Error(`DB write: ${error.message}`);
      }

      prior ? updated++ : inserted++;
      seeded.push(record);
      console.log(`${label} ok: ${record.name} (${record.keywords.length} keywords)`);
    } catch (err) {
      appendLog(FAILED_LOG_PATH, { title: row.title, imdb_id: row.imdb_id, error: err.message });
      console.log(`${label} FAILED: ${row.title} (${err.message})`);
      failed++;
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(seeded, null, 2));

  const noKeywords = seeded.filter((r) => r.keywords.length === 0).length;
  const noPoster = seeded.filter((r) => !r.poster_url).length;
  const verb = SHOULD_INSERT ? "" : "would be ";

  console.log("\n---- Summary ----");
  console.log(`${seeded.length} ok: ${updated} ${verb}updated in place, ${inserted} ${verb}inserted as new`);
  console.log(`${noKeywords} with no keywords, ${noPoster} with no poster`);
  if (needsReview) console.log(`${needsReview} need review, see ${path.basename(REVIEW_LOG_PATH)}`);
  if (failed) console.log(`${failed} failed (safe to re-run), see ${path.basename(FAILED_LOG_PATH)}`);
  console.log(`Full output in ${path.basename(OUT_PATH)}`);
  if (!SHOULD_INSERT) console.log("\nDry run only, nothing written. Re-run with --insert when it looks right.");
}

main();
