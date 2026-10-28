import { describe, expect, test } from "bun:test";

import { handlePayCodeRequest } from "./paycode";
import type { LoadPayCodeResult } from "../../../../lib/donations/payme-paycode.server";

const ID = "11111111-1111-4111-8111-111111111111";
const okLimit = async () => ({ ok: true }) as never;
const client = () => ({}) as never;

function req() {
  return new Request(`https://app.test/api/donations/${ID}/paycode`);
}

function deps(result: LoadPayCodeResult | Error, extra: Record<string, unknown> = {}) {
  const loads: Array<{ donationId: string; effectiveDurationSeconds: number }> = [];
  return {
    loads,
    deps: {
      enforce: okLimit,
      createClient: client,
      getDuration: () => 600,
      load: async (args: { donationId: string; effectiveDurationSeconds: number }) => {
        loads.push({
          donationId: args.donationId,
          effectiveDurationSeconds: args.effectiveDurationSeconds,
        });
        if (result instanceof Error) throw result;
        return result;
      },
      ...extra,
    },
  };
}

describe("handlePayCodeRequest", () => {
  test("returns the PayCode for a donation that is waiting on PayMe, uncached", async () => {
    const body = {
      status: "pending",
      webLink: "https://payme.example/pay/pr1",
      amountCents: 30000,
      currency: "HKD",
      expiresAt: "2026-10-26T12:10:00.000Z",
      serverNow: "2026-10-26T12:00:07.000Z",
      language: "zh-HK",
    };
    const h = deps({ kind: "ok", body } as LoadPayCodeResult);
    const res = await handlePayCodeRequest(req(), { donationId: ID }, h.deps as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(body);
    expect(h.loads).toEqual([{ donationId: ID, effectiveDurationSeconds: 600 }]);
  });

  test("429 with a retry hint when rate limited, before touching the database", async () => {
    const h = deps(
      { kind: "not_found" },
      {
        enforce: async () => ({ ok: false, reset: Date.now() + 5000 }) as never,
      },
    );
    const res = await handlePayCodeRequest(req(), { donationId: ID }, h.deps as never);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.loads).toEqual([]);
  });

  test("404 for an id that is not a UUID, without a lookup", async () => {
    const h = deps({ kind: "not_found" });
    for (const donationId of [undefined, "", "not-a-uuid", "1; drop table payment"]) {
      const res = await handlePayCodeRequest(req(), { donationId }, h.deps as never);
      expect(res.status).toBe(404);
    }
    expect(h.loads).toEqual([]);
  });

  test("404 for a donation with no PayMe payment", async () => {
    const h = deps({ kind: "not_found" });
    const res = await handlePayCodeRequest(req(), { donationId: ID }, h.deps as never);
    expect(res.status).toBe(404);
  });

  test("409 while the PayCode has not been created yet", async () => {
    const h = deps({ kind: "not_ready" });
    const res = await handlePayCodeRequest(req(), { donationId: ID }, h.deps as never);
    expect(res.status).toBe(409);
  });

  test("500, with no detail, when the lookup fails", async () => {
    const h = deps(new Error("password=hunter2 db down"));
    const res = await handlePayCodeRequest(req(), { donationId: ID }, h.deps as never);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });

  test("500 when the PayCode lifetime is misconfigured", async () => {
    const h = deps(
      { kind: "not_found" },
      {
        getDuration: () => {
          throw new Error("PAYME_EFFECTIVE_DURATION must be an integer >= 15");
        },
      },
    );
    const res = await handlePayCodeRequest(req(), { donationId: ID }, h.deps as never);
    expect(res.status).toBe(500);
  });
});
