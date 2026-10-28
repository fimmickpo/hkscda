import { describe, expect, test } from "bun:test";
import { PAYME_POLL_AFTER_MS, refreshPendingPayMeDonation } from "./payme-status.server";
import type { PayMeClient } from "./payme-client.server";

type Row = {
  id: string;
  provider_ref: string | null;
  amount_cents: number;
  status: string;
  created_at: string;
};

const NOW = new Date("2026-10-26T12:10:00.000Z");
const iso = (secondsBeforeNow: number) =>
  new Date(NOW.getTime() - secondsBeforeNow * 1000).toISOString();

function row(overrides: Partial<Row> = {}): Row {
  // Created ten minutes ago, so the 60 second wait for a webhook is long over.
  return {
    id: "p1",
    provider_ref: "pr1",
    amount_cents: 30000,
    status: "pending",
    created_at: iso(600),
    ...overrides,
  };
}

// Every call is old enough and unthrottled unless a test says otherwise.
const due = { now: () => NOW, allowCall: async () => true };

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
      client: fakeClient(row()),
      createClient: () => statusClient("PR005"),
      reconcile: async () => {
        reconciled = true;
        return {};
      },
      fail: async () => ({}),
      ...due,
    });
    expect(reconciled).toBe(true);
    expect(res.kind).toBe("reconciled");
  });

  test("PR007 fails", async () => {
    let failed = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row()),
      createClient: () => statusClient("PR007"),
      reconcile: async () => ({}),
      fail: async () => {
        failed = true;
        return {};
      },
      ...due,
    });
    expect(failed).toBe(true);
    expect(res.kind).toBe("failed");
  });

  test("PR004 fails", async () => {
    let failed = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row()),
      createClient: () => statusClient("PR004"),
      reconcile: async () => ({}),
      fail: async () => {
        failed = true;
        return {};
      },
      ...due,
    });
    expect(failed).toBe(true);
    expect(res.kind).toBe("failed");
  });

  test("PR001 stays pending", async () => {
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row()),
      createClient: () => statusClient("PR001"),
      ...due,
    });
    expect(res.kind).toBe("pending");
  });

  test("a status that has not ended the request is neither reconciled nor failed", async () => {
    for (const statusCode of ["PR001", "PR999"]) {
      const calls: string[] = [];
      const res = await refreshPendingPayMeDonation({
        donationId: "d1",
        client: fakeClient(row()),
        createClient: () => statusClient(statusCode),
        reconcile: async () => {
          calls.push("reconcile");
          return {};
        },
        fail: async () => {
          calls.push("fail");
          return {};
        },
        ...due,
      });
      expect(calls).toEqual([]);
      expect(res).toEqual({ kind: "pending", statusCode });
    }
  });

  test("already-succeeded recovers side effects", async () => {
    let recovered = false;
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row({ status: "succeeded" })),
      recoverSideEffects: async () => {
        recovered = true;
        return {};
      },
    });
    expect(recovered).toBe(true);
    expect(res.kind).toBe("recovered");
  });

  test("an unreachable PayMe leaves the payment pending as unavailable", async () => {
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row()),
      createClient: () => ({
        getPaymentRequestStatus: async () => {
          throw new Error("PayMe get status failed with 500");
        },
      }),
      ...due,
    });
    expect(res).toEqual({ kind: "pending", statusCode: "unavailable" });
  });
});

describe("refreshPendingPayMeDonation timing", () => {
  function spyClient() {
    const calls: string[] = [];
    return {
      calls,
      createClient: (): Pick<PayMeClient, "getPaymentRequestStatus"> => ({
        getPaymentRequestStatus: async (id) => {
          calls.push(id);
          return { statusCode: "PR001" };
        },
      }),
    };
  }

  test("leaves PayMe alone for the first 60 seconds, so the webhook can arrive first", async () => {
    for (const age of [0, 1, 30, 59]) {
      const { calls, createClient } = spyClient();
      const res = await refreshPendingPayMeDonation({
        donationId: "d1",
        client: fakeClient(row({ created_at: iso(age) })),
        createClient,
        ...due,
      });
      expect(res).toEqual({ kind: "pending", statusCode: "awaiting_notification" });
      expect(calls).toEqual([]);
    }
  });

  test("asks PayMe once 60 seconds have passed with no notification", async () => {
    for (const age of [60, 61, 300]) {
      const { calls, createClient } = spyClient();
      const res = await refreshPendingPayMeDonation({
        donationId: "d1",
        client: fakeClient(row({ created_at: iso(age) })),
        createClient,
        ...due,
      });
      expect(res).toEqual({ kind: "pending", statusCode: "PR001" });
      expect(calls).toEqual(["pr1"]);
    }
  });

  test("waits PAYME_POLL_AFTER_MS, which is 60 seconds", () => {
    expect(PAYME_POLL_AFTER_MS).toBe(60_000);
  });

  test("makes no call while a status call for the same payment is still within its 10 seconds", async () => {
    const { calls, createClient } = spyClient();
    const asked: string[] = [];
    const res = await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row()),
      createClient,
      now: () => NOW,
      allowCall: async (paymentId) => {
        asked.push(paymentId);
        return false;
      },
    });
    expect(res).toEqual({ kind: "pending", statusCode: "throttled" });
    expect(asked).toEqual(["p1"]);
    expect(calls).toEqual([]);
  });

  test("does not spend a throttle slot while it is still waiting for the webhook", async () => {
    const asked: string[] = [];
    await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row({ created_at: iso(5) })),
      now: () => NOW,
      allowCall: async (paymentId) => {
        asked.push(paymentId);
        return true;
      },
    });
    expect(asked).toEqual([]);
  });

  test("a payment that succeeded is recovered at once, whatever its age", async () => {
    let recovered = 0;
    await refreshPendingPayMeDonation({
      donationId: "d1",
      client: fakeClient(row({ status: "succeeded", created_at: iso(2) })),
      recoverSideEffects: async () => {
        recovered += 1;
        return {};
      },
      now: () => NOW,
    });
    expect(recovered).toBe(1);
  });
});
