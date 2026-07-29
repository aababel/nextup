import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Supabase client for use in Server Components, Server Functions, and Route
 * Handlers. Must be created fresh per request (it closes over the request's
 * cookies), so call this inside the function that needs it rather than at
 * module scope.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // `set` is called from a Server Component during rendering, where
            // cookie writes aren't allowed. Safe to ignore here because the
            // proxy (see proxy.ts) refreshes the session on every request.
          }
        },
      },
    }
  );
}
