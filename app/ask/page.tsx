import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { TasteProfile } from "@/lib/taste-profile/synthesize";

// Placeholder: confirms the taste profile was generated after the quiz.
export default async function AskPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("taste_profiles")
    .select("profile_json")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load taste profile: ${error.message}`);
  }

  const profile = data?.profile_json as TasteProfile | undefined;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {profile?.summary ? (
        <>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Profile ready
          </h1>
          <p className="max-w-lg text-sm text-zinc-600 dark:text-zinc-400">
            {profile.summary}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            No taste profile yet
          </h1>
          <Link
            href="/quiz"
            className="text-sm font-medium text-zinc-900 underline dark:text-zinc-50"
          >
            Take the quiz
          </Link>
        </>
      )}
    </div>
  );
}
