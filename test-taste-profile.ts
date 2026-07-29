/**
 * NextUp — taste-profile synthesis test harness
 *
 * Lets you iterate on the synthesis prompt (lib/taste-profile/prompt.ts)
 * against a real user's quiz answers or a hand-written fake persona, without
 * creating extra accounts or clicking through the quiz UI. Runs through
 * lib/taste-profile/synthesize.ts — the exact same prompt + Claude API call
 * used by app/api/taste-profile/route.ts.
 *
 * Never writes to taste_profiles, in either mode — this is for prompt
 * iteration only. Prints the resulting profile JSON to stdout.
 *
 * ---- Setup ----
 * Needs ANTHROPIC_API_KEY. --user mode also needs SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY (same as seed-titles-omdb.mjs) to read real quiz
 * data, bypassing RLS.
 *
 * ---- Run ----
 *   npx tsx --env-file=.env.local test-taste-profile.ts --user <user_id>
 *   npx tsx --env-file=.env.local test-taste-profile.ts --input ./personas/comfort-viewer.json
 *
 * ---- --input file format ----
 *   {
 *     "quiz_responses": [
 *       { "title": "The Shawshank Redemption", "genres": ["Drama"], "keywords": [], "overview": "...", "release_year": 1994, "response": "loved" },
 *       ...
 *     ],
 *     "framing_answers": [
 *       { "question": "Do you prefer being comforted or challenged by what you watch?", "answer": "Challenged" },
 *       ...
 *     ]
 *   }
 *   `response` should use the prompt's vocabulary directly: loved | liked |
 *   not_for_me | havent_seen. (The app's DB enum stores "meh" instead of
 *   "not_for_me" for that reaction — see the normalizeResponse note in
 *   lib/taste-profile/generate.ts. --input files skip that translation, so
 *   just write "not_for_me" yourself.)
 */

import fs from "node:fs";
import path from "node:path";
import {
  synthesizeTasteProfile,
  type QuizResponseInput,
  type FramingAnswerInput,
} from "./lib/taste-profile/synthesize";

function parseArgs() {
  const args = process.argv.slice(2);
  const userIdx = args.indexOf("--user");
  const inputIdx = args.indexOf("--input");
  const userId = userIdx !== -1 ? args[userIdx + 1] : undefined;
  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : undefined;

  if ((!userId && !inputPath) || (userId && inputPath)) {
    console.error("Usage: npx tsx --env-file=.env.local test-taste-profile.ts --user <user_id>");
    console.error("   or: npx tsx --env-file=.env.local test-taste-profile.ts --input <path-to-json>");
    process.exit(1);
  }

  return { userId, inputPath };
}

// DB enum stores "meh"; the prompt's vocabulary uses "not_for_me" for the
// same reaction (see lib/taste-profile/generate.ts).
function normalizeResponse(response: string): string {
  return response === "meh" ? "not_for_me" : response;
}

async function loadFromSupabase(
  userId: string
): Promise<{ quizResponses: QuizResponseInput[]; framingAnswers: FramingAnswerInput[] }> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("--user requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.");
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const [responsesRes, framingRes] = await Promise.all([
    supabase
      .from("quiz_responses")
      .select("response, titles(name, genres, keywords, overview, release_year)")
      .eq("user_id", userId)
      .not("title_id", "is", null),
    supabase.from("quiz_framing_responses").select("question_key, response").eq("user_id", userId),
  ]);

  if (responsesRes.error) {
    console.error("Failed to load quiz responses:", responsesRes.error.message);
    process.exit(1);
  }
  if (framingRes.error) {
    console.error("Failed to load framing responses:", framingRes.error.message);
    process.exit(1);
  }

  type ResponseRow = {
    response: string;
    titles: {
      name: string;
      genres: string[];
      keywords: string[];
      overview: string | null;
      release_year: number | null;
    } | null;
  };

  const quizResponses: QuizResponseInput[] = ((responsesRes.data ?? []) as unknown as ResponseRow[])
    .filter((row) => row.titles !== null)
    .map((row) => ({
      title: row.titles!.name,
      genres: row.titles!.genres ?? [],
      keywords: row.titles!.keywords ?? [],
      overview: row.titles!.overview,
      release_year: row.titles!.release_year,
      response: normalizeResponse(row.response),
    }));

  const { FRAMING_QUESTIONS } = await import("./lib/quiz/framing-questions");
  const framingAnswers: FramingAnswerInput[] = (framingRes.data ?? []).map((row) => {
    const question = FRAMING_QUESTIONS.find((q) => q.key === row.question_key);
    return { question: question?.prompt ?? row.question_key, answer: row.response };
  });

  return { quizResponses, framingAnswers };
}

function loadFromFile(inputPath: string): {
  quizResponses: QuizResponseInput[];
  framingAnswers: FramingAnswerInput[];
} {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Couldn't find ${resolved}`);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return {
    quizResponses: parsed.quiz_responses ?? [],
    framingAnswers: parsed.framing_answers ?? [],
  };
}

async function main() {
  const { userId, inputPath } = parseArgs();

  const { quizResponses, framingAnswers } = userId
    ? await loadFromSupabase(userId)
    : loadFromFile(inputPath!);

  console.error(
    `Synthesizing from ${quizResponses.length} quiz response(s) and ${framingAnswers.length} framing answer(s)...\n`
  );

  const profile = await synthesizeTasteProfile(quizResponses, framingAnswers);
  console.log(JSON.stringify(profile, null, 2));
}

main().catch((err) => {
  console.error("Synthesis failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
