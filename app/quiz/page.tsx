import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FRAMING_QUESTIONS } from "@/lib/quiz/framing-questions";
import { QUIZ_TITLE_COUNT } from "@/lib/quiz/config";
import { QuizClient } from "./QuizClient";

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export default async function QuizPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [answeredTitlesRes, answeredFramingRes, titlesRes] = await Promise.all([
    supabase
      .from("quiz_responses")
      .select("title_id")
      .eq("user_id", user.id)
      .not("title_id", "is", null),
    supabase
      .from("quiz_framing_responses")
      .select("question_key")
      .eq("user_id", user.id),
    supabase
      .from("titles")
      .select("id, name, release_year, poster_url")
      .eq("active", true),
  ]);

  const answeredTitleIds = new Set(
    (answeredTitlesRes.data ?? []).map((row) => row.title_id)
  );
  const answeredFramingKeys = new Set(
    (answeredFramingRes.data ?? []).map((row) => row.question_key)
  );

  const unansweredTitles = (titlesRes.data ?? []).filter(
    (title) => !answeredTitleIds.has(title.id)
  );
  const titles = shuffle(unansweredTitles).slice(0, QUIZ_TITLE_COUNT);

  const framingQuestions = FRAMING_QUESTIONS.filter(
    (q) => !answeredFramingKeys.has(q.key)
  );

  return (
    <QuizClient
      titles={titles}
      framingQuestions={framingQuestions}
      userEmail={user.email ?? ""}
    />
  );
}
