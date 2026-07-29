import { createClient } from "@/lib/supabase/server";
import { FRAMING_QUESTIONS } from "@/lib/quiz/framing-questions";
import {
  synthesizeTasteProfile,
  type QuizResponseInput,
  type FramingAnswerInput,
  type TasteProfile,
} from "./synthesize";

// quiz_responses.response stores "meh" (the DB enum value); the synthesis
// prompt's vocabulary (lib/taste-profile/prompt.ts) uses "not_for_me" for the
// same reaction. Translate here rather than touching either the DB enum or
// the prompt text.
function normalizeResponse(response: string): string {
  return response === "meh" ? "not_for_me" : response;
}

/**
 * Pulls a user's quiz data (title responses + open framing answers), sends it
 * to Claude for taste-profile synthesis, and upserts the result into
 * taste_profiles. Throws on any Supabase or SynthesisError failure — the
 * caller (API route) decides how to surface that.
 */
export async function generateTasteProfileForUser(userId: string): Promise<TasteProfile> {
  const supabase = await createClient();

  const [responsesRes, framingRes] = await Promise.all([
    supabase
      .from("quiz_responses")
      .select("response, titles(name, genres, keywords, overview, release_year)")
      .eq("user_id", userId)
      .not("title_id", "is", null),
    supabase
      .from("quiz_framing_responses")
      .select("question_key, response")
      .eq("user_id", userId),
  ]);

  if (responsesRes.error) {
    throw new Error(`Failed to load quiz responses: ${responsesRes.error.message}`);
  }
  if (framingRes.error) {
    throw new Error(`Failed to load framing responses: ${framingRes.error.message}`);
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

  const framingAnswers: FramingAnswerInput[] = (framingRes.data ?? []).map((row) => {
    const question = FRAMING_QUESTIONS.find((q) => q.key === row.question_key);
    return {
      question: question?.prompt ?? row.question_key,
      answer: row.response,
    };
  });

  const profile = await synthesizeTasteProfile(quizResponses, framingAnswers);

  const { error: upsertError } = await supabase
    .from("taste_profiles")
    .upsert(
      { user_id: userId, profile_json: profile, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  if (upsertError) {
    throw new Error(`Failed to save taste profile: ${upsertError.message}`);
  }

  return profile;
}
