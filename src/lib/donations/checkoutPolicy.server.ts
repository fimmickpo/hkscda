import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { donationMethods } from "./contracts";
import type { CheckoutPurpose } from "./checkoutPolicy";
import { hasPaymentInstructionDetails } from "../paymentPublicConfig/instructions";
import type { PublicPaymentMethod } from "../paymentPublicConfig/types";

const policyRow = z.object({ enabled: z.boolean(), version: z.number().int().positive() });
const approvalRow = z.object({
  method: z.enum(donationMethods),
  purpose: z.enum(["donation", "sponsorship"]),
  config_id: z.string().uuid(),
  config_version: z.number().int().positive(),
  enabled: z.boolean(),
});
const configRow = z.object({
  id: z.string().uuid(),
  method: z.enum(donationMethods),
  state: z.literal("published"),
  is_publicly_visible: z.literal(true),
  version: z.number().int().positive(),
  display_label_zh: z.string().min(1),
  display_label_en: z.string().min(1),
  details: z.record(z.string(), z.string()),
});

export type PublicCheckoutMethod = PublicPaymentMethod & {
  configId: string;
  configVersion: number;
  purposes: CheckoutPurpose[];
};
export type PublicCheckoutState =
  | { state: "ready"; methods: PublicCheckoutMethod[] }
  | { state: "disabled" | "not_configured" | "unavailable"; methods: [] };

const noMethods = (state: "disabled" | "not_configured" | "unavailable"): PublicCheckoutState => ({
  state,
  methods: [],
});

export async function loadPublicCheckoutState(
  client: SupabaseClient,
): Promise<PublicCheckoutState> {
  const { data: rawPolicy, error: policyError } = await client
    .from("checkout_policy")
    .select("enabled,version")
    .eq("singleton", true)
    .maybeSingle();
  if (policyError) {
    console.error("Checkout policy read failed", policyError.code);
    return noMethods("unavailable");
  }
  const policy = policyRow.safeParse(rawPolicy);
  if (!policy.success) return noMethods("unavailable");
  if (!policy.data.enabled) return noMethods("disabled");

  const { data: rawApprovals, error: approvalError } = await client
    .from("checkout_method_approval")
    .select("method,purpose,config_id,config_version,enabled")
    .eq("enabled", true);
  if (approvalError) {
    console.error("Checkout approvals read failed", approvalError.code);
    return noMethods("unavailable");
  }
  const approvals = z.array(approvalRow).safeParse(rawApprovals);
  if (!approvals.success) return noMethods("unavailable");
  if (approvals.data.length === 0) return noMethods("not_configured");

  const ids = [...new Set(approvals.data.map((entry) => entry.config_id))];
  const { data: rawConfigs, error: configError } = await client
    .from("payment_public_config")
    .select("id,method,state,is_publicly_visible,version,display_label_zh,display_label_en,details")
    .in("id", ids);
  if (configError) {
    console.error("Checkout config read failed", configError.code);
    return noMethods("unavailable");
  }
  const configs = z.array(configRow).safeParse(rawConfigs);
  if (!configs.success) return noMethods("unavailable");
  const byId = new Map(configs.data.map((config) => [config.id, config]));
  const methods: PublicCheckoutMethod[] = [];
  for (const approval of approvals.data) {
    const config = byId.get(approval.config_id);
    if (
      !config ||
      config.version !== approval.config_version ||
      config.method !== approval.method ||
      (approval.method === "fps" && !hasPaymentInstructionDetails(config.details))
    ) {
      return noMethods("unavailable");
    }
    const existing = methods.find((entry) => entry.configId === config.id);
    if (existing) {
      existing.purposes.push(approval.purpose);
    } else {
      methods.push({
        method: config.method,
        displayLabelZh: config.display_label_zh,
        displayLabelEn: config.display_label_en,
        details: config.details,
        configId: config.id,
        configVersion: config.version,
        purposes: [approval.purpose],
      });
    }
  }
  return methods.length ? { state: "ready", methods } : noMethods("not_configured");
}
