import type { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Where a signed-in user should land: /ask once they have a taste profile,
 * otherwise /quiz. Takes the caller's request-scoped Supabase client.
 */
export async function getHomePath(
  supabase: ServerSupabaseClient,
  userId: string
): Promise<"/ask" | "/quiz"> {
  const { data, error } = await supabase
    .from("taste_profiles")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load taste profile: ${error.message}`);
  }

  return data ? "/ask" : "/quiz";
}
