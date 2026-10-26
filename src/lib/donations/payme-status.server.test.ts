import { describe, expect, test } from "bun:test";
import { refreshPendingPayMeDonation } from "./payme-status.server";
import type { PayMeClient } from "./payme-client.server";

type Row = { id: string; provider_ref: string | null; amount_cents: number; status: string };

function fakeClient(paymentRow: Row | null) {
  // Minimal Supabase query-builder chain returning paymentRow via .maybeSingle().
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
    in() {
      return this;
    },
    maybeSingle: async () => ({ data: paymentRow, error: null }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}
function statusClient(statusCode: string): Pick<PayMeClient, "getPaymentRequestStatus"> {
  return { getPaymentRequestStatus: async () => ({ statusCode, transactionId: "t1" }) };
}

describe("refreshPendingPayMeDonation", () => {
  test("returns not_applicable when there is no payme payment", async () => {
    const res = await refreshPendingPayMeDonation({ donationId: "d1", client: fakeClient(null) });
    expect(res.kind).toBe("not_applicable");
  });

  test("PR005 reconciles", async () => {
    let reconciled = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR005"),
      reconcile: async () => {
        reconciled = true;
        return {};
      },
      fail: async () => ({}),
    });
    expect(reconciled).toBe(true);
    expect(res.kind).toBe("reconciled");
  });

  test("PR007 fails", async () => {
    let failed = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR007"),
      reconcile: async () => ({}),
      fail: async () => {
        failed = true;
        return {};
      },
    });
    expect(failed).toBe(true);
    expect(res.kind).toBe("failed");
  });

  test("PR004 fails", async () => {
    let failed = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR004"),
      reconcile: async () => ({}),
      fail: async () => {
        failed = true;
        return {};
      },
    });
    expect(failed).toBe(true);
    expect(res.kind).toBe("failed");
  });

  test("PR001 stays pending", async () => {
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({ id: "p1", provider_ref: "pr1", amount_cents: 30000, status: "pending" }),
      createClient: () => statusClient("PR001"),
    });
    expect(res.kind).toBe("pending");
  });

  test("a status that has not ended the request is neither reconciled nor failed", async () => {
    for (const statusCode of ["PR001", "PR999"]) {
      const calls: string[] = [];
      const res = await refreshPendingPayMeDonation({
        donationId: "d1",
        client: fakeClient({
          id: "p1",
          provider_ref: "pr1",
          amount_cents: 30000,
          status: "pending",
        }),
        createClient: () => statusClient(statusCode),
        reconcile: async () => {
          calls.push("reconcile");
          return {};
        },
        fail: async () => {
          calls.push("fail");
          return {};
        },
      });
      expect(calls).toEqual([]);
      expect(res).toEqual({ kind: "pending", statusCode });
    }
  });

  test("already-succeeded recovers side effects", async () => {
    let recovered = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient({
        id: "p1",
        provider_ref: "pr1",
        amount_cents: 30000,
        status: "succeeded",
      }),
      recoverSideEffects: async () => {
        recovered = true;
        return {};
      },
    });
    expect(recovered).toBe(true);
    expect(res.kind).toBe("recovered");
  });
});
