/**
 * NextUp — recommendation test harness
 *
 * Lets you iterate on the recommendation prompt (lib/recommend/prompt.ts)
 * against a real user's candidate pool or a hand-written taste profile,
 * without clicking through the app. Runs through lib/recommend/recommend.ts —
 * the exact same prompt + Claude API call used by app/api/recommend/route.ts.
 *
 * Never writes to the database, in either mode — this is for prompt
 * iteration only. Prints the picks (with titles, not just ids) to stdout.
 *
 * ---- Setup ----
 * Needs ANTHROPIC_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY (same
 * as seed-titles-omdb.mjs) to read the title catalog, bypassing RLS. --user
 * mode additionally reads that user's taste profile and quiz responses from
 * Supabase; --profile mode reads the taste profile from a local file instead,
 * and builds the candidate pool from the full active catalog with no
 * per-user exclusions (there's no real user to exclude "liked"/"not_for_me"
 * titles for).
 *
 * ---- Run ----
 *   npx tsx --env-file=.env.local test-recommend.ts --user <user_id> --context "something light before bed"
 *   npx tsx --env-file=.env.local test-recommend.ts --profile ./personas/comfort-viewer.json --context "something light before bed"
 *
 * ---- --profile file format ----
 *   The taste profile JSON itself, same shape as taste_profiles.profile_json
 *   / the output of test-taste-profile.ts:
 *   {
 *     "favorite_genres": [...],
 *     "favorite_eras": [...],
 *     "preferred_tones": [...],
 *     "preferred_themes": [...],
 *     "pacing_preference": "...",
 *     "comfort_vs_challenge": "...",
 *     "things_to_avoid": [...],
 *     "confidence": "...",
 *     "summary": "..."
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { getRecommendations } from "./lib/recommend/recommend";
import { buildCandidates, type Candidate } from "./lib/recommend/candidates";
import type { TasteProfile } from "./lib/taste-profile/synthesize";

function parseArgs() {
  const args = process.argv.slice(2);
  const userIdx = args.indexOf("--user");
  const profileIdx = args.indexOf("--profile");
  const contextIdx = args.indexOf("--context");

  const userId = userIdx !== -1 ? args[userIdx + 1] : undefined;
  const profilePath = profileIdx !== -1 ? args[profileIdx + 1] : undefined;
  const context = contextIdx !== -1 ? args[contextIdx + 1] : undefined;

  if ((!userId && !profilePath) || (userId && profilePath) || !context) {
    console.error('Usage: npx tsx --env-file=.env.local test-recommend.ts --user <user_id> --context "..."');
    console.error('   or: npx tsx --env-file=.env.local test-recommend.ts --profile <path-to-json> --context "..."');
    process.exit(1);
  }

  return { userId, profilePath, context: context! };
}

async function getSupabase() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.");
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

async function loadProfileForUser(
  supabase: Awaited<ReturnType<typeof getSupabase>>,
  userId: string
): Promise<TasteProfile> {
  const { data, error } = await supabase
    .from("taste_profiles")
    .select("profile_json")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load taste profile:", error.message);
    process.exit(1);
  }
  if (!data) {
    console.error(`User ${userId} has no taste_profiles row yet — generate one first.`);
    process.exit(1);
  }

  return data.profile_json as TasteProfile;
}

async function loadCandidatesForUser(
  supabase: Awaited<ReturnType<typeof getSupabase>>,
  userId: string
): Promise<Candidate[]> {
  const [titlesRes, responsesRes] = await Promise.all([
    supabase
      .from("titles")
      .select("id, name, type, release_year, genres, keywords, runtime_minutes")
      .eq("active", true),
    supabase.from("quiz_responses").select("title_id, response").eq("user_id", userId).not("title_id", "is", null),
  ]);

  if (titlesRes.error) {
    console.error("Failed to load titles:", titlesRes.error.message);
    process.exit(1);
  }
  if (responsesRes.error) {
    console.error("Failed to load quiz responses:", responsesRes.error.message);
    process.exit(1);
  }

  return buildCandidates(titlesRes.data ?? [], responsesRes.data ?? []);
}

async function loadFullCatalogCandidates(
  supabase: Awaited<ReturnType<typeof getSupabase>>
): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from("titles")
    .select("id, name, type, release_year, genres, keywords, runtime_minutes")
    .eq("active", true);

  if (error) {
    console.error("Failed to load titles:", error.message);
    process.exit(1);
  }

  return buildCandidates(data ?? [], []);
}

function loadProfileFromFile(profilePath: string): TasteProfile {
  const resolved = path.resolve(profilePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Couldn't find ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf-8"));
}

async function main() {
  const { userId, profilePath, context } = parseArgs();

  const supabase = await getSupabase();

  const [profile, candidates] = userId
    ? await Promise.all([loadProfileForUser(supabase, userId), loadCandidatesForUser(supabase, userId)])
    : await Promise.all([Promise.resolve(loadProfileFromFile(profilePath!)), loadFullCatalogCandidates(supabase)]);

  console.error(`Recommending from a candidate pool of ${candidates.length} title(s)...\n`);

  const result = await getRecommendations(profile, context, candidates);
  const candidateById = new Map(candidates.map((c) => [c.id, c]));

  console.log("Picks:");
  for (const pick of result.picks) {
    const title = candidateById.get(pick.title_id);
    const label = title ? `${title.name}${title.release_year ? ` (${title.release_year})` : ""}` : pick.title_id;
    console.log(`- ${label}\n    ${pick.why_it_fits}`);
  }

  if (result.passed_over.length > 0) {
    console.log("\nPassed over:");
    for (const p of result.passed_over) {
      const title = candidateById.get(p.title_id);
      const label = title ? `${title.name}${title.release_year ? ` (${title.release_year})` : ""}` : p.title_id;
      console.log(`- ${label}\n    ${p.why_not}`);
    }
  }
}

main().catch((err) => {
  console.error("Recommendation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
