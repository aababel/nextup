import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AskClient } from "./AskClient";

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
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load taste profile: ${error.message}`);
  }

  if (!data) {
    redirect("/quiz");
  }

  return <AskClient userEmail={user.email ?? ""} />;
}
