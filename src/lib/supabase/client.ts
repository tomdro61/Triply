/**
 * Supabase Client Configuration
 *
 * This file sets up the Supabase client for use in the application.
 * TODO: Configure after Supabase project is created
 */

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
