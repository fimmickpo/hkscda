import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { paymentPublicConfigMethodSchema } from "./schemas";
import { hasPaymentInstructionDetails } from "./instructions";
import type { PaymentAvailability, PublicPaymentMethod } from "./types";

const publicPaymentMethodRowSchema = z.object({
  method: paymentPublicConfigMethodSchema,
  display_label_zh: z.string(),
  display_label_en: z.string(),
  details: z.record(z.string(), z.string()),
});

export async function loadPublicPaymentMethods(
  client: SupabaseClient,
): Promise<PaymentAvailability> {
  const { data, error } = await client
    .from("payment_public_config")
    .select("method,display_label_zh,display_label_en,details")
    .eq("state", "published")
    .eq("is_publicly_visible", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("Failed to load public payment methods", error.code ?? "unknown");
    return { state: "unavailable", methods: [] };
  }

  const rows: PublicPaymentMethod[] = [];
  for (const raw of data ?? []) {
    const parsed = publicPaymentMethodRowSchema.safeParse(raw);
    if (
      !parsed.success ||
      (parsed.data.method === "fps" && !hasPaymentInstructionDetails(parsed.data.details))
    ) {
      return { state: "unavailable", methods: [] };
    }
    rows.push({
      method: parsed.data.method,
      displayLabelZh: parsed.data.display_label_zh,
      displayLabelEn: parsed.data.display_label_en,
      details: parsed.data.details,
    });
  }
  return rows.length ? { state: "ready", methods: rows } : { state: "not_configured", methods: [] };
}
