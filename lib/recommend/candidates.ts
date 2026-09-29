import { createClient } from "@/lib/supabase/server";

export type Candidate = {
  id: string;
  name: string;
  type: "movie" | "tv";
  release_year: number | null;
  genres: string[];
  keywords: string[];
  runtime_minutes: number | null;
  previously_loved: boolean;
};

type TitleRow = {
  id: string;
  name: string;
  type: "movie" | "tv";
  release_year: number | null;
  genres: string[];
  keywords: string[];
  runtime_minutes: number | null;
};

/**
 * Builds the candidate pool for a recommendation pass: every active title,
 * minus ones the user already told us aren't for them (quiz response
 * "liked" or "not_for_me" — stored as "meh" in the DB enum, see the
 * normalizeResponse note in lib/taste-profile/generate.ts). Titles they
 * "loved" stay in the pool but are flagged previously_loved so the prompt
 * can offer them as a deliberate rewatch rather than a fresh discovery.
 */
export async function getCandidatesForUser(userId: string): Promise<Candidate[]> {
  const supabase = await createClient();

  const [titlesRes, responsesRes] = await Promise.all([
    supabase
      .from("titles")
      .select("id, name, type, release_year, genres, keywords, runtime_minutes")
      .eq("active", true),
    supabase
      .from("quiz_responses")
      .select("title_id, response")
      .eq("user_id", userId)
      .not("title_id", "is", null),
  ]);

  if (titlesRes.error) {
    throw new Error(`Failed to load titles: ${titlesRes.error.message}`);
  }
  if (responsesRes.error) {
    throw new Error(`Failed to load quiz responses: ${responsesRes.error.message}`);
  }

  return buildCandidates((titlesRes.data ?? []) as TitleRow[], responsesRes.data ?? []);
}

/**
 * Pure version of the filtering/flagging logic, split out so the test
 * harness (which reads via a service-role client, not the session-bound one
 * from lib/supabase/server) can reuse it without duplicating the rules.
 */
export function buildCandidates(
  titles: TitleRow[],
  quizResponses: { title_id: string | null; response: string }[]
): Candidate[] {
  const excluded = new Set<string>();
  const loved = new Set<string>();

  for (const row of quizResponses) {
    if (!row.title_id) continue;
    if (row.response === "liked" || row.response === "meh") {
      excluded.add(row.title_id);
    } else if (row.response === "loved") {
      loved.add(row.title_id);
    }
  }

  return titles
    .filter((t) => !excluded.has(t.id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      release_year: t.release_year,
      genres: t.genres ?? [],
      keywords: t.keywords ?? [],
      runtime_minutes: t.runtime_minutes,
      previously_loved: loved.has(t.id),
    }));
}
