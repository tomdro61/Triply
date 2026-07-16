import type { SupabaseClient } from "@supabase/supabase-js";

type UnlinkedCustomer = { id: string; email: string | null; user_id: string | null };

/**
 * Ids of UNLINKED customer rows (user_id IS NULL) whose email
 * case-insensitively equals `email`.
 *
 * The JS `lower()` equality filter is the AUTHORITATIVE guard: the server-side
 * `.ilike` only narrows the candidate set and can over-match a local-part
 * containing SQL wildcards (`_` / `%`). Shared by /api/user/bookings (Tier-2
 * count) and /api/user/link-bookings (the claim write) so this
 * security-load-bearing filter can never drift between the two routes.
 *
 * `email` MUST be the caller's own verified account email (never a client-
 * supplied value). Requires an admin (service-role) client — the caller's own
 * customer rows are user_id IS NULL, so RLS on the session client would hide
 * them. Throws on DB error; callers decide whether to degrade or 500.
 */
export async function getClaimableCustomerIds(
  admin: SupabaseClient,
  email: string
): Promise<string[]> {
  const emailLc = email.toLowerCase();
  const { data, error } = await admin
    .from("customers")
    .select("id, email, user_id")
    .is("user_id", null)
    .ilike("email", email);

  if (error) {
    throw new Error(`claimable customers lookup failed: ${error.message}`);
  }

  return ((data ?? []) as UnlinkedCustomer[])
    .filter((c) => (c.email ?? "").toLowerCase() === emailLc)
    .map((c) => c.id);
}
