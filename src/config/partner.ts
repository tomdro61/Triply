import { createAdminClient } from "@/lib/supabase/server";

export interface Partner {
  id: string;
  user_id: string;
  email: string;
  reslab_location_id: number;
  location_name: string;
  company_name: string | null;
  is_active: boolean;
}

export async function getPartnerByUserId(
  userId: string
): Promise<Partner | null> {
  const supabase = await createAdminClient();

  const { data, error } = await supabase
    .from("partners")
    .select(
      "id, user_id, email, reslab_location_id, location_name, company_name, is_active"
    )
    .eq("user_id", userId)
    .eq("is_active", true)
    .single();

  if (error || !data) return null;
  return data as Partner;
}
