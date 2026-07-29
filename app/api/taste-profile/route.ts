import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateTasteProfileForUser } from "@/lib/taste-profile/generate";
import { SynthesisError } from "@/lib/taste-profile/synthesize";

// Always synthesizes for the caller's own session (never a client-supplied
// user_id) — same pattern as the quiz server actions, so this route can't be
// used to read or overwrite another user's taste profile.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const profile = await generateTasteProfileForUser(user.id);
    return NextResponse.json({ profile });
  } catch (err) {
    if (err instanceof SynthesisError) {
      const status = err.reason === "api_error" ? 502 : 422;
      return NextResponse.json({ error: err.message, reason: err.reason }, { status });
    }
    console.error("Taste profile generation failed", err);
    return NextResponse.json({ error: "Failed to generate taste profile" }, { status: 500 });
  }
}
