/**
 * NextUp — title-seeding script (OMDb API version)
 *
 * Why OMDb instead of TMDB: TMDB signup is currently blocked by a CloudFront
 * 403 that survived DNS changes, a VPN, and multiple browsers — likely a
 * flagged IP range on TMDB's side. OMDb wraps IMDb data on separate
 * infrastructure and isn't affected.
 *
 * CALL TO MAKE LATER: OMDb's free tier caps at 1,000 requests/day, with no
 * documented way to buy more. TMDB (the original plan) has no daily cap, only
 * a per-second rate limit, and is also free. Fine for the current title
 * count, but once the catalog is in the thousands, a 1,000/day cap means a
 * multi-day initial seed AND every correction re-pull eats into that same
 * daily budget. Worth a conscious decision before scaling much further —
 * this script doesn't require the switch, but don't let it happen by default.
 *
 * ---- What changed from the original title-search version ----
 * The original script searched OMDb by title text (`t=<title>`), and OMDb's
 * fuzzy matching silently returned the wrong record for short/generic/oddly
 * punctuated titles (e.g. "Se7en" -> an unrelated 2016 student short, "Tár"
 * -> an unrelated monster movie). Both got past review and had to be fixed
 * with a one-off manual SQL patch.
 *
 * This version fetches by IMDb ID (`i=<imdb_id>`), which returns exactly one
 * specific record — there is no fuzzy match for OMDb to get wrong. The
 * imdb_id must be curator-verified (i.e. a human looked the title up on IMDb
 * and copied the tt####### id), which is what makes this safe.
 *
 * As a second line of defense, if you supply an `expected_year` and OMDb's
 * Year differs by more than 1, the row is NOT written — it's logged to
 * review-needed.log instead. This catches a curator-side typo'd imdb_id
 * (still a valid id, just for the wrong title) that `i=` alone can't catch.
 *
 * SCHEMA NOTE: your `titles` table has a `tmdb_id` column. This script writes
 * OMDb's imdbID (e.g. "tt0111161") into that column — the name is a leftover
 * from an earlier TMDB-based plan. Not renaming it here; a one-line ALTER
 * TABLE + column rename whenever it's convenient.
 *
 * OMDb has no keyword/tag data, so `keywords` is written as an empty array.
 *
 * ---- Setup ----
 * 1. Get a free OMDb key by email at https://www.omdbapi.com/apikey.aspx
 * 2. npm install @supabase/supabase-js
 * 3. Set env vars (e.g. in a .env you load, or export in your shell):
 *      OMDB_API_KEY=xxxxxxxx
 *      SUPABASE_URL=https://<project>.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY=xxxxxxxx   (service role, not anon — needed to bypass RLS for a seed script)
 * 4. Put your finalized title list in ./titles.csv with these columns:
 *      Title,Type,ImdbId,ExpectedYear
 *      The Godfather,Movie,tt0068646,1972
 *      Breaking Bad,TV,tt0903747,2008
 *    ImdbId is required and must be curator-verified (look it up on IMDb
 *    yourself — don't guess). ExpectedYear is optional but strongly
 *    recommended; leave it blank if you're not sure.
 *
 * ---- Run ----
 *   node seed-titles-omdb.mjs             # dry run: writes titles-seed.json, no DB writes
 *   node seed-titles-omdb.mjs --insert    # also upserts into Supabase `titles` table
 *   node seed-titles-omdb.mjs --insert --force   # re-fetch + re-upsert rows even if already processed
 *
 * ---- Resuming a large, multi-day pull ----
 * Every imdb_id successfully upserted (via --insert) is recorded in
 * processed_ids.json. The next run skips those automatically, so you can
 * split a large titles.csv across as many sessions as the 1,000/day OMDb cap
 * requires — just re-run the same command each day until nothing's left to
 * process. Pass --force to deliberately re-fetch + re-upsert specific rows
 * (e.g. after fixing a bad imdb_id), even though they're already checked off.
 *
 * If OMDb reports its daily request limit has been hit mid-run, the script
 * stops cleanly (not a crash) — whatever succeeded before that point is
 * already upserted and checked off, so just re-run tomorrow to continue.
 */

import fs from "node:fs";
import path from "node:path";

const OMDB_API_KEY = process.env.OMDB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOULD_INSERT = process.argv.includes("--insert");
const FORCE = process.argv.includes("--force");

const REQUEST_DELAY_MS = 300; // polite pacing between OMDb calls

const CSV_PATH = path.resolve("./titles.csv");
const OUT_PATH = path.resolve("./titles-seed.json");
const CHECKPOINT_PATH = path.resolve("./processed_ids.json");
const REVIEW_LOG_PATH = path.resolve("./review-needed.log");
const FAILED_LOG_PATH = path.resolve("./failed.log");

if (!OMDB_API_KEY) {
  console.error("Missing OMDB_API_KEY env var. Get a free key: https://www.omdbapi.com/apikey.aspx");
  process.exit(1);
}

// Parses one CSV line respecting quoted fields (so titles like
// "The Good, the Bad and the Ugly" that contain commas don't get split apart).
// Handles doubled "" as an escaped quote inside a quoted field, per RFC 4180.
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
  // Strip a UTF-8 BOM if present — Excel's "CSV UTF-8" export adds one,
  // and left in place it silently breaks matching the "Title" header.
  const clean = text.replace(/^﻿/, "").trim();
  const lines = clean.split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf("title");
  const typeIdx = header.indexOf("type");
  const imdbIdx = header.indexOf("imdbid");
  const yearIdx = header.indexOf("expectedyear");
  if (titleIdx === -1 || typeIdx === -1 || imdbIdx === -1) {
    throw new Error(
      `titles.csv must have "Title", "Type", and "ImdbId" columns (ExpectedYear is optional). Found: ${header.join(", ")}`
    );
  }
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = parseCsvLine(line);
    const expectedYearRaw = yearIdx === -1 ? "" : (cols[yearIdx] ?? "").trim();
    return {
      title: cols[titleIdx].trim(),
      type: cols[typeIdx].trim(),
      imdb_id: cols[imdbIdx].trim(),
      expected_year: expectedYearRaw ? parseInt(expectedYearRaw, 10) : undefined,
    };
  });
}

function normalizeType(omdbType) {
  return omdbType === "series" ? "tv" : "movie";
}

function parseYear(yearField) {
  // handles "1994", "2016–2023", "2016–"
  const match = String(yearField).match(/\d{4}/);
  return match ? parseInt(match[0], 10) : null;
}

function isRateLimitResponse(res, data) {
  const message = `${data?.Error ?? ""}`.toLowerCase();
  return res.status === 401 || message.includes("limit reached") || message.includes("request limit");
}

async function fetchOmdbById(imdbId) {
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, i: imdbId });
  const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
  const data = await res.json();
  return { res, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return new Set();
  try {
    const ids = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"));
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    console.warn(`Couldn't parse ${CHECKPOINT_PATH}, starting with an empty checkpoint.`);
    return new Set();
  }
}

function saveCheckpoint(processedIds) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify([...processedIds].sort(), null, 2));
}

function appendLog(logPath, entry) {
  fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Couldn't find ${CSV_PATH}. Create titles.csv with Title,Type,ImdbId,ExpectedYear columns first.`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf-8"));
  console.log(`Loaded ${rows.length} titles from titles.csv`);

  for (const row of rows) {
    if (!row.imdb_id || !/^tt\d+$/.test(row.imdb_id)) {
      console.error(`Bad or missing imdb_id for "${row.title}" (got: "${row.imdb_id}"). Fix titles.csv and re-run.`);
      process.exit(1);
    }
  }

  const processedIds = loadCheckpoint();
  const pending = FORCE ? rows : rows.filter((row) => !processedIds.has(row.imdb_id));
  const skippedCount = rows.length - pending.length;
  if (skippedCount > 0) {
    console.log(`Skipping ${skippedCount} already-processed title(s) (use --force to re-fetch them).`);
  }

  let supabase = null;
  if (SHOULD_INSERT) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("--insert requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.");
      process.exit(1);
    }
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }

  const seeded = [];
  let stoppedForRateLimit = false;

  for (const [i, row] of pending.entries()) {
    let res, data;
    try {
      ({ res, data } = await fetchOmdbById(row.imdb_id));
    } catch (err) {
      appendLog(FAILED_LOG_PATH, { title: row.title, imdb_id: row.imdb_id, reason: "network_error", error: err.message });
      process.stdout.write(`\r[${i + 1}/${pending.length}] NETWORK ERROR: ${row.title} (${err.message})\n`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (isRateLimitResponse(res, data)) {
      console.log(`\n\nOMDb daily request limit reached after ${i} of ${pending.length} pending titles this run.`);
      console.log("Stopping cleanly — already-upserted titles are checked off in processed_ids.json.");
      console.log("Re-run this same command tomorrow (once the OMDb quota resets) to continue.");
      stoppedForRateLimit = true;
      break;
    }

    if (data.Response === "False") {
      appendLog(REVIEW_LOG_PATH, {
        title: row.title,
        imdb_id: row.imdb_id,
        reason: "omdb_not_found",
        omdb_error: data.Error ?? "Unknown OMDb error",
      });
      process.stdout.write(`\r[${i + 1}/${pending.length}] NEEDS REVIEW: ${row.title} — OMDb: ${data.Error}\n`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const releaseYear = parseYear(data.Year);
    if (
      row.expected_year !== undefined &&
      (releaseYear === null || Math.abs(releaseYear - row.expected_year) > 1)
    ) {
      appendLog(REVIEW_LOG_PATH, {
        title: row.title,
        imdb_id: row.imdb_id,
        reason: "year_mismatch",
        expected_year: row.expected_year,
        omdb_year: data.Year,
        omdb_title: data.Title,
      });
      process.stdout.write(
        `\r[${i + 1}/${pending.length}] NEEDS REVIEW: ${row.title} — expected ${row.expected_year}, OMDb returned "${data.Title}" (${data.Year})\n`
      );
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const record = {
      // `active` is intentionally omitted here: on INSERT the column default
      // (true) applies, and on UPDATE (conflict) omitting it leaves an
      // existing row's active flag untouched — so re-running this script to
      // correct metadata never silently un-retires a title.
      tmdb_id: row.imdb_id, // see SCHEMA NOTE at top of file
      name: data.Title,
      type: normalizeType(data.Type),
      genres: data.Genre && data.Genre !== "N/A" ? data.Genre.split(",").map((g) => g.trim()) : [],
      keywords: [], // OMDb doesn't provide keyword/tag data
      overview: data.Plot && data.Plot !== "N/A" ? data.Plot : null,
      release_year: releaseYear,
      poster_url: data.Poster && data.Poster !== "N/A" ? data.Poster : null,
    };

    if (SHOULD_INSERT) {
      const { error } = await supabase
        .from("titles")
        .upsert(record, { onConflict: "tmdb_id,type" });

      if (error) {
        appendLog(FAILED_LOG_PATH, { title: row.title, imdb_id: row.imdb_id, reason: "db_write_error", error: error.message });
        process.stdout.write(`\r[${i + 1}/${pending.length}] DB WRITE FAILED: ${row.title} (${error.message})\n`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      processedIds.add(row.imdb_id);
      saveCheckpoint(processedIds); // flushed every row so a crash mid-run loses nothing
    }

    seeded.push(record);
    process.stdout.write(`\r[${i + 1}/${pending.length}] ok: ${row.title}          `);
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\n\nDone. ${seeded.length} succeeded this run.`);

  fs.writeFileSync(OUT_PATH, JSON.stringify(seeded, null, 2));
  console.log(`Wrote ${OUT_PATH}`);

  if (fs.existsSync(REVIEW_LOG_PATH)) {
    console.log(`See ${REVIEW_LOG_PATH} for titles that need a manual look (bad imdb_id or year mismatch).`);
  }
  if (fs.existsSync(FAILED_LOG_PATH)) {
    console.log(`See ${FAILED_LOG_PATH} for transient failures (network/DB errors) safe to retry.`);
  }

  if (!SHOULD_INSERT) {
    console.log("\nDry run only (no DB writes). Review titles-seed.json, then re-run with --insert.");
  } else if (stoppedForRateLimit) {
    process.exitCode = 0; // clean stop, not a failure
  }
}

main();
