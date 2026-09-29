import type { TasteProfile } from "@/lib/taste-profile/synthesize";
import type { Candidate } from "./candidates";

/**
 * Recommendation prompt.
 *
 * This is one of the two or three most important pieces of the product —
 * kept in its own file, as a single top-level constant, so it's easy to find
 * and iterate on. Do not rewrite this text without checking with Aarav first;
 * tweak formatting/data plumbing elsewhere, not the prompt itself.
 *
 * PLACEHOLDER — this is not the real recommendation prompt yet.
 */
export const SYSTEM_PROMPT = `You are a movie and TV recommendation engine for NextUp. PLACEHOLDER PROMPT.

You will be given a user's taste profile, some free-text context about what
they're in the mood for right now, and a list of candidate titles.

Pick titles from the candidate list that fit both the taste profile and the
context. Return ONLY valid JSON matching this shape:

{
  "picks": [ { "title_id": string, "why_it_fits": string } ],
  "passed_over": [ { "title_id": string, "why_not": string } ]
}

picks: 2-3 items, chosen only from the candidate list. passed_over: optional,
0-2 items worth mentioning as close calls that didn't make the cut.`;

/**
 * Builds the user-turn input that accompanies SYSTEM_PROMPT: the taste
 * profile JSON, the user's free-text context, and the candidate list in
 * compact form.
 */
export function formatRecommendInput(
  profile: TasteProfile,
  context: string,
  candidates: Candidate[]
): string {
  const profileJson = JSON.stringify(profile, null, 2);
  const candidatesJson = JSON.stringify(candidates, null, 2);

  return `Taste profile:\n${profileJson}\n\nWhat they're in the mood for right now:\n"${context}"\n\nCandidate titles:\n${candidatesJson}`;
}
