import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createSupabaseServiceClient } from "../supabase.server";
import { createPublicIdentityRepository } from "../supporters/publicIdentity.server";
import { CheckoutPolicyError } from "./checkoutPolicy";
import { parsePaymentInstructionSnapshot } from "../paymentPublicConfig/instructions.server";
import { DonationIdempotencyConflictError } from "./service";
import { publicDonationStatuses, type PublicDonationStatus } from "./publicStatus";
import type { PublicDonationStatusRepository } from "./publicStatus.server";
import {
  projectDonationEffectStatuses,
  resolveCommittedPaymentStatus,
} from "./publicStatusProjection";
import type { DonationRepository } from "./service";

export { createSupabaseServiceClient };
export type { AdminUser } from "../admin/session.server";
export { getAdminUserFromRequest, requireAdmin } from "../admin/session.server";

export function createSupabaseDonationRepository(client: SupabaseClient): DonationRepository {
  const publicIdentity = createPublicIdentityRepository(client);
  return {
    async admitNewCheckout(input) {
      const { data, error } = await client.rpc("admit_new_checkout", {
        p_idempotency_key: input.idempotencyKey,
        p_request_fingerprint: input.fingerprint,
        p_method: input.method,
        p_purpose: input.purpose,
        p_expected_config_version: input.expectedConfigVersion,
      });
      if (!error) {
        const row = z
          .object({
            instruction_snapshot: z.unknown(),
            instructions_active: z.boolean(),
          })
          .safeParse(data);
        if (!row.success) throw new CheckoutPolicyError("unavailable");
        const snapshot = parsePaymentInstructionSnapshot(row.data.instruction_snapshot);
        return { snapshot, instructionsActive: row.data.instructions_active };
      }
      if (error.code === "P5101") throw new CheckoutPolicyError("disabled");
      if (error.code === "P5102") throw new CheckoutPolicyError("method_unavailable");
      if (error.code === "P5103") throw new CheckoutPolicyError("stale_config");
      if (error.code === "P5104") throw new DonationIdempotencyConflictError();
      if (["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code)) {
        throw new CheckoutPolicyError("unavailable");
      }
      throw error;
    },
    resolvePublicIdentity(contact) {
      return publicIdentity.resolve(contact);
    },
    async ensureSupporterRole(input) {
      const { error } = await client.from("supporter_role").upsert(
        {
          supporter_id: input.supporterId,
          role: input.role,
        },
        { ignoreDuplicates: true },
      );
      if (error) throw error;
    },
    async replaceConsents(rows) {
      if (rows.length === 0) return;
      const { error } = await client.from("consent").upsert(rows, {
        onConflict: "supporter_id,channel,status,source,timestamp",
        ignoreDuplicates: true,
      });
      if (error) throw error;
    },
    async findDonationByIdempotencyKey(key) {
      const { data, error } = await client
        .from("donation")
        .select("id,supporter_id,created_at,amount_cents,idempotency_fingerprint")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async createDonation(input) {
      const { data, error } = await client
        .from("donation")
        .insert(input)
        .select("id,supporter_id,created_at,amount_cents,idempotency_fingerprint")
        .single();
      if (error) throw error;
      return data;
    },
    async findPaymentByIdempotencyKey(key) {
      const { data, error } = await client
        .from("payment")
        .select(
          "id,donation_id,idempotency_key,provider,provider_ref,provider_order_ref,amount_cents,status,checkout_url,checkout_attempted_at",
        )
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async createPayment(input) {
      const { data, error } = await client.from("payment").insert(input).select("*").single();
      if (error) throw error;
      return data;
    },
    async beginCheckoutAttempt(paymentId, timestamp) {
      const { data, error } = await client
        .from("payment")
        .update({ checkout_attempted_at: timestamp })
        .eq("id", paymentId)
        .is("checkout_attempted_at", null)
        .select("checkout_attempted_at")
        .maybeSingle();
      if (error) throw error;
      if (data) return { attemptedAt: data.checkout_attempted_at as string, claimed: true };

      const { data: existing, error: readError } = await client
        .from("payment")
        .select("checkout_attempted_at")
        .eq("id", paymentId)
        .single();
      if (readError) throw readError;
      if (!existing.checkout_attempted_at) throw new Error("Checkout attempt could not be claimed");
      return { attemptedAt: existing.checkout_attempted_at as string, claimed: false };
    },
    async updatePaymentProviderRef(paymentId, providerRef, checkoutUrl, providerOrderRef) {
      const { data, error } = await client
        .from("payment")
        .update({
          provider_ref: providerRef,
          checkout_url: checkoutUrl,
          ...(providerOrderRef ? { provider_order_ref: providerOrderRef } : {}),
        })
        .eq("id", paymentId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("Donation payment no longer exists");
    },
  };
}
export function createSupabaseDonationStatusRepository(
  client: SupabaseClient,
  dependencies: Pick<
    PublicDonationStatusRepository,
    "refreshPendingCod" | "refreshPendingPayMe"
  > = {},
): PublicDonationStatusRepository {
  return {
    refreshPendingCod: dependencies.refreshPendingCod,
    refreshPendingPayMe: dependencies.refreshPendingPayMe,
    async findStatus(donationId) {
      const [donationResult, paymentResult] = await Promise.all([
        client
          .from("donation")
          .select("status")
          .eq("id", donationId)
          .maybeSingle<{ status: string }>(),
        client
          .from("payment")
          .select("status")
          .eq("donation_id", donationId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ status: string }>(),
      ]);
      if (donationResult.error) throw donationResult.error;
      if (paymentResult.error) throw paymentResult.error;
      const donationStatus = donationResult.data?.status;
      const paymentStatus = paymentResult.data?.status;
      if (
        !donationStatus ||
        !publicDonationStatuses.includes(donationStatus as PublicDonationStatus)
      )
        return null;
      if (paymentStatus && !publicDonationStatuses.includes(paymentStatus as PublicDonationStatus))
        return null;
      return resolveCommittedPaymentStatus(
        donationStatus as PublicDonationStatus,
        (paymentStatus as PublicDonationStatus | undefined) ?? null,
      );
    },
    async findEffects(donationId, status) {
      const { data: donation, error: donationError } = await client
        .from("donation")
        .select("supporter_id,receipt_requested,amount_cents,refunded_cents")
        .eq("id", donationId)
        .single<{
          supporter_id: string;
          receipt_requested: boolean;
          amount_cents: number;
          refunded_cents: number | null;
        }>();
      if (donationError) throw donationError;
      const [receiptResult, messageResult, jobResult] = await Promise.all([
        client
          .from("receipt")
          .select("status,pdf_url")
          .contains("donation_ids", [donationId])
          .order("issued_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ status: "issued" | "void"; pdf_url: string | null }>(),
        client
          .from("message")
          .select("status")
          .eq("supporter_id", donation.supporter_id)
          .eq("channel", "email")
          .contains("payload", { kind: "donation_acknowledgement", donationId })
          .maybeSingle<{ status: "queued" | "sent" | "delivered" | "failed" }>(),
        client
          .from("donation_delivery_job")
          .select("status")
          .eq("donation_id", donationId)
          .maybeSingle<{
            status: "pending" | "processing" | "retryable" | "attention_required" | "complete";
          }>(),
      ]);
      if (receiptResult.error) throw receiptResult.error;
      if (messageResult.error) throw messageResult.error;
      if (jobResult.error) throw jobResult.error;
      return projectDonationEffectStatuses({
        paymentStatus: status,
        receiptRequested: donation.receipt_requested,
        netAmountCents: donation.amount_cents - (donation.refunded_cents ?? 0),
        receipt: receiptResult.data,
        notification: messageResult.data?.status ?? null,
        deliveryJob: jobResult.data?.status ?? null,
      });
    },
  };
}

export async function listAdminPayments(client: SupabaseClient) {
  const { data, error } = await client
    .from("payment")
    .select(
      "id,provider,provider_ref,amount_cents,status,received_at,bank_reference,created_at,donation:donation_id(id,purpose,custom_purpose,receipt_requested,status,supporter:supporter_id(id,name,email,phone,language))",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return data ?? [];
}

export async function listAdminReceipts(client: SupabaseClient) {
  const { data, error } = await client
    .from("receipt")
    .select("id,receipt_no,donation_ids,status")
    .order("issued_at", { ascending: false })
    .limit(200);

  if (error) throw error;
  return data ?? [];
}

const FINANCE_ACTIVITY_ACTIONS = [
  "payment.mark_received",
  "receipt.issue",
  "receipt.void",
] as const;

export type FinanceActivityRow = {
  id: string;
  action: string;
  actorEmail: string | null;
  entityId: string;
  detail: unknown;
  createdAt: string;
};

export async function listFinanceActivity(client: SupabaseClient): Promise<FinanceActivityRow[]> {
  const { data, error } = await client
    .from("audit_log")
    .select("id,action,actor_user_id,entity_id,detail,timestamp")
    .in("action", FINANCE_ACTIVITY_ACTIONS as unknown as string[])
    .order("timestamp", { ascending: false })
    .limit(50);

  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    action: string;
    actor_user_id: string | null;
    entity_id: string;
    detail: unknown;
    timestamp: string;
  }>;

  const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter(Boolean))] as string[];
  let emailByAuthId = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: admins, error: adminError } = await client
      .from("admin_user")
      .select("auth_user_id,email")
      .in("auth_user_id", actorIds);
    if (adminError) throw adminError;
    emailByAuthId = new Map(
      ((admins ?? []) as Array<{ auth_user_id: string; email: string }>).map((a) => [
        a.auth_user_id,
        a.email,
      ]),
    );
  }

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorEmail: row.actor_user_id ? (emailByAuthId.get(row.actor_user_id) ?? null) : null,
    entityId: row.entity_id,
    detail: row.detail,
    createdAt: row.timestamp,
  }));
}
