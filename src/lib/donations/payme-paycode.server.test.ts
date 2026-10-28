import { describe, expect, test } from "bun:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PayMeCancelOutcome, PayMeClient } from "./payme-client.server";
import { cancelPayMeDonation, loadPayMePayCode } from "./payme-paycode.server";
import type { ReconcileProviderArgs } from "./reconcile.server";

type Row = {
  id: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  provider_ref: string | null;
  amount_cents: number;
  checkout_url: string | null;
  created_at: string;
  donation: { contact_language: string | null } | null;
};

const CREATED = "2026-10-26T12:00:00.000Z";
const NOW = new Date("2026-10-26T12:00:07.000Z");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "p1",
    status: "pending",
    provider_ref: "pr1",
    amount_cents: 30000,
    checkout_url: "https://payme.example/pay/pr1",
    created_at: CREATED,
    donation: { contact_language: "zh-HK" },
    ...overrides,
  };
}

function fakeClient(paymentRow: Row | null, error: Error | null = null) {
  // Minimal Supabase query-builder chain: the lookup ends in .maybeSingle().
  return {
    from() {
      return this;
    },
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle: async () => ({ data: paymentRow, error }),
  } as unknown as SupabaseClient;
}

describe("loadPayMePayCode", () => {
  const load = (paymentRow: Row | null, effectiveDurationSeconds = 600) =>
    loadPayMePayCode({
      donationId: "d1",
      client: fakeClient(paymentRow),
      effectiveDurationSeconds,
      now: () => NOW,
    });

  test("a donation without a PayMe payment is not found", async () => {
    expect(await load(null)).toEqual({ kind: "not_found" });
  });

  test("a payable PayCode returns the link, the amount and when it stops being payable", async () => {
    expect(await load(row())).toEqual({
      kind: "ok",
      body: {
        status: "pending",
        webLink: "https://payme.example/pay/pr1",
        amountCents: 30000,
        currency: "HKD",
        expiresAt: "2026-10-26T12:10:00.000Z",
        serverNow: "2026-10-26T12:00:07.000Z",
        language: "zh-HK",
      },
    });
  });

  test("the expiry follows the configured PayCode lifetime", async () => {
    const result = await load(row(), 900);
    expect(result).toMatchObject({ body: { expiresAt: "2026-10-26T12:15:00.000Z" } });
  });

  test("the page speaks the language the donor used", async () => {
    const english = await load(row({ donation: { contact_language: "en" } }));
    expect(english).toMatchObject({ body: { language: "en" } });
    for (const donation of [null, { contact_language: null }, { contact_language: "fr" }]) {
      expect(await load(row({ donation }))).toMatchObject({ body: { language: "zh-HK" } });
    }
  });

  test("a PayCode that has not been created yet is not ready", async () => {
    expect(await load(row({ checkout_url: null }))).toEqual({ kind: "not_ready" });
  });

  test("a payment that has settled returns its outcome and never the link", async () => {
    for (const status of ["succeeded", "failed", "refunded"] as const) {
      const result = await load(row({ status }));
      expect(result).toEqual({ kind: "ok", body: { status, language: "zh-HK" } });
    }
  });

  test("a database error is not hidden as a missing donation", async () => {
    await expect(
      loadPayMePayCode({
        donationId: "d1",
        client: fakeClient(null, new Error("db down")),
        effectiveDurationSeconds: 600,
      }),
    ).rejects.toThrow("db down");
  });
});

describe("cancelPayMeDonation", () => {
  function harness(outcome: PayMeCancelOutcome | Error, failResult: unknown = { kind: "failed" }) {
    const cancelled: string[] = [];
    const failed: ReconcileProviderArgs[] = [];
    return {
      cancelled,
      failed,
      deps: {
        createClient: (): Pick<PayMeClient, "cancelPaymentRequest"> => ({
          cancelPaymentRequest: async (id) => {
            cancelled.push(id);
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
        }),
        fail: async (a: ReconcileProviderArgs) => {
          failed.push(a);
          return failResult;
        },
      },
    };
  }

  const run = (paymentRow: Row | null, h: ReturnType<typeof harness>) =>
    cancelPayMeDonation({ donationId: "d1", client: fakeClient(paymentRow), ...h.deps });

  test("PayMe cancelling the PayCode fails the payment and reports it cancelled", async () => {
    const h = harness({ kind: "cancelled" });
    expect(await run(row(), h)).toEqual({ kind: "ok", body: { status: "cancelled" } });
    expect(h.cancelled).toEqual(["pr1"]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toMatchObject({
      provider: "payme",
      providerRef: "pr1",
      providerEventId: "payme:cancel:pr1",
      eventType: "payment.cancelled",
      payload: { source: "cancel", outcome: "cancelled" },
    });
  });

  test("a PayCode PayMe says is already aborted or expired is failed the same way", async () => {
    const h = harness({ kind: "already_ended" });
    expect(await run(row(), h)).toEqual({ kind: "ok", body: { status: "cancelled" } });
    expect(h.failed).toHaveLength(1);
  });

  test("a PayCode that was paid is not cancelled and the payment is left alone", async () => {
    const h = harness({ kind: "paid" });
    expect(await run(row(), h)).toEqual({ kind: "ok", body: { status: "paid" } });
    expect(h.failed).toEqual([]);
  });

  test("a payment being processed is not cancelled and the payment is left alone", async () => {
    const h = harness({ kind: "in_progress" });
    expect(await run(row(), h)).toEqual({ kind: "ok", body: { status: "in_progress" } });
    expect(h.failed).toEqual([]);
  });

  test("a PayMe error is passed on, and nothing is failed", async () => {
    const h = harness(new Error("PayMe cancel payment request failed with 500"));
    await expect(run(row(), h)).rejects.toThrow("failed with 500");
    expect(h.failed).toEqual([]);
  });

  test("a second click on cancel still reads as cancelled", async () => {
    const h = harness({ kind: "cancelled" }, { kind: "duplicate" });
    expect(await run(row(), h)).toEqual({ kind: "ok", body: { status: "cancelled" } });
  });

  test("a payment that turns out not to be pending is not reported as cancelled", async () => {
    for (const failResult of [{ kind: "manual_review" }, { kind: "not_found" }, null]) {
      const h = harness({ kind: "cancelled" }, failResult);
      expect(await run(row(), h)).toEqual({ kind: "ok", body: { status: "in_progress" } });
    }
  });

  test("a payment that already succeeded is reported paid without asking PayMe", async () => {
    const h = harness({ kind: "cancelled" });
    expect(await run(row({ status: "succeeded" }), h)).toEqual({
      kind: "ok",
      body: { status: "paid" },
    });
    expect(h.cancelled).toEqual([]);
  });

  test("a payment that already ended is reported cancelled without asking PayMe", async () => {
    for (const status of ["failed", "refunded"] as const) {
      const h = harness({ kind: "cancelled" });
      expect(await run(row({ status }), h)).toEqual({ kind: "ok", body: { status: "cancelled" } });
      expect(h.cancelled).toEqual([]);
    }
  });

  test("a donation with no PayMe payment, or no PayMe request yet, is not found", async () => {
    const h = harness({ kind: "cancelled" });
    expect(await run(null, h)).toEqual({ kind: "not_found" });
    expect(await run(row({ provider_ref: null }), h)).toEqual({ kind: "not_found" });
    expect(h.cancelled).toEqual([]);
  });
});
