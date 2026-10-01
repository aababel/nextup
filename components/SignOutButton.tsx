"use client";

import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // Full page load rather than router.push: it drops the client router
    // cache, so Back or revisiting /ask hits the server and redirects to
    // /login instead of showing a stale signed-in page.
    window.location.assign("/login");
  }

  return (
    <button onClick={handleSignOut} className="underline hover:text-zinc-900 dark:hover:text-zinc-50">
      Sign out
    </button>
  );
}
