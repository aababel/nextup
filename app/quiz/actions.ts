"use server";

import { createClient } from "@/lib/supabase/server";
import { FRAMING_QUESTIONS } from "@/lib/quiz/framing-questions";

export type TitleResponseValue = "loved" | "liked" | "meh" | "havent_seen";

const TITLE_RESPONSE_VALUES: TitleResponseValue[] = [
  "loved",
  "liked",
  "meh",
  "havent_seen",
];

export async function submitTitleResponse(
  titleId: string,
  response: TitleResponseValue
) {
  if (!TITLE_RESPONSE_VALUES.includes(response)) {
    throw new Error(`Invalid response value: ${response}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Unauthorized");
  }

  // quiz_responses.user_id/title_id is a *partial* unique index (it excludes
  // artist-only rows), so Postgres can't infer it from a plain
  // `ON CONFLICT (user_id, title_id)` — upsert() fails with "no unique or
  // exclusion constraint matching the ON CONFLICT specification". Do the
  // check-then-write by hand instead.
  const { data: existing, error: selectError } = await supabase
    .from("quiz_responses")
    .select("id")
    .eq("user_id", user.id)
    .eq("title_id", titleId)
    .maybeSingle();

  if (selectError) {
    throw new Error(selectError.message);
  }

  const { error } = existing
    ? await supabase
        .from("quiz_responses")
        .update({ response })
        .eq("id", existing.id)
    : await supabase
        .from("quiz_responses")
        .insert({ user_id: user.id, title_id: titleId, response });

  if (error) {
    throw new Error(error.message);
  }
}

export async function submitFramingResponse(
  questionKey: string,
  response: string
) {
  if (!FRAMING_QUESTIONS.some((q) => q.key === questionKey)) {
    throw new Error(`Invalid framing question key: ${questionKey}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Unauthorized");
  }

  const { error } = await supabase.from("quiz_framing_responses").upsert(
    {
      user_id: user.id,
      question_key: questionKey,
      response,
    },
    { onConflict: "user_id,question_key" }
  );

  if (error) {
    throw new Error(error.message);
  }
}
