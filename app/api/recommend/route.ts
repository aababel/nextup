import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCandidatesForUser } from "@/lib/recommend/candidates";
import { getRecommendations, RecommendError } from "@/lib/recommend/recommend";
import type { TasteProfile } from "@/lib/taste-profile/synthesize";

// Always recommends for the caller's own session (never a client-supplied
// user_id) — same pattern as app/api/taste-profile/route.ts, so this route
// can't be used to read another user's taste profile or write recommendation
// rows on their behalf.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { context?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  if (typeof body.context !== "string" || body.context.trim() === "") {
    return NextResponse.json({ error: "context is required" }, { status: 400 });
  }
  const context = body.context;

  const { data: profileRow, error: profileError } = await supabase
    .from("taste_profiles")
    .select("profile_json")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Failed to load taste profile", profileError);
    return NextResponse.json({ error: "Failed to load taste profile" }, { status: 500 });
  }
  if (!profileRow) {
    return NextResponse.json({ error: "No taste profile yet — generate one first" }, { status: 400 });
  }

  try {
    const candidates = await getCandidatesForUser(user.id);
    const result = await getRecommendations(profileRow.profile_json as TasteProfile, context, candidates);

    const { error: insertError } = await supabase.from("recommendations").insert({
      user_id: user.id,
      context_input: context,
      recommended_items_json: result,
    });
    if (insertError) {
      console.error("Failed to save recommendation", insertError);
      return NextResponse.json({ error: "Failed to save recommendation" }, { status: 500 });
    }

    const pickIds = result.picks.map((p) => p.title_id);
    const { data: titleRows, error: titlesError } = await supabase
      .from("titles")
      .select("id, name, poster_url, type, release_year")
      .in("id", pickIds);
    if (titlesError) {
      console.error("Failed to load recommended titles", titlesError);
      return NextResponse.json({ error: "Failed to load recommended titles" }, { status: 500 });
    }

    const titleById = new Map((titleRows ?? []).map((t) => [t.id, t]));
    const picks = result.picks.map((pick) => {
      const title = titleById.get(pick.title_id);
      return {
        title_id: pick.title_id,
        why_it_fits: pick.why_it_fits,
        name: title?.name ?? null,
        poster_url: title?.poster_url ?? null,
        type: title?.type ?? null,
        release_year: title?.release_year ?? null,
      };
    });

    return NextResponse.json({ picks, passed_over: result.passed_over });
  } catch (err) {
    if (err instanceof RecommendError) {
      const status = err.reason === "api_error" ? 502 : 422;
      return NextResponse.json({ error: err.message, reason: err.reason }, { status });
    }
    console.error("Recommendation generation failed", err);
    return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 });
  }
}
