import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getHomePath } from "@/lib/routing/home-path";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  redirect(await getHomePath(supabase, user.id));
}
