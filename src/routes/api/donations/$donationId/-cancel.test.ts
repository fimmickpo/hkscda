import { describe, expect, test } from "bun:test";

import { handlePayCodeCancelRequest } from "./cancel";
import type { CancelPayMeResult } from "../../../../lib/donations/payme-paycode.server";

const ID = "11111111-1111-4111-8111-111111111111";
const okLimit = async () => ({ ok: true }) as never;
const client = () => ({}) as never;

function req() {
  return new Request(`https://app.test/api/donations/${ID}/cancel`, { method: "POST" });
}

function deps(result: CancelPayMeResult | Error, extra: Record<string, unknown> = {}) {
  const cancels: string[] = [];
  return {
    cancels,
    deps: {
      enforce: okLimit,
      createClient: client,
      cancel: async (args: { donationId: string }) => {
        cancels.push(args.donationId);
        if (result instanceof Error) throw result;
        return result;
      },
      ...extra,
    },
  };
}

describe("handlePayCodeCancelRequest", () => {
  test("reports what became of the PayCode, uncached", async () => {
    for (const status of ["cancelled", "paid", "in_progress"] as const) {
      const h = deps({ kind: "ok", body: { status } });
      const res = await handlePayCodeCancelRequest(req(), { donationId: ID }, h.deps as never);

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ status });
      expect(h.cancels).toEqual([ID]);
    }
  });

  test("429 when rate limited, and nothing is cancelled", async () => {
    const h = deps(
      { kind: "ok", body: { status: "cancelled" } },
      {
        enforce: async () => ({ ok: false, reset: Date.now() + 5000 }) as never,
      },
    );
    const res = await handlePayCodeCancelRequest(req(), { donationId: ID }, h.deps as never);

    expect(res.status).toBe(429);
    expect(h.cancels).toEqual([]);
  });

  test("503 when the limiter is unavailable, because a write must not run unthrottled", async () => {
    const options: unknown[] = [];
    const h = deps(
      { kind: "ok", body: { status: "cancelled" } },
      {
        enforce: async (_ip: string, opts: unknown) => {
          options.push(opts);
          return { ok: false, unavailable: true } as never;
        },
      },
    );
    const res = await handlePayCodeCancelRequest(req(), { donationId: ID }, h.deps as never);

    expect(res.status).toBe(503);
    expect(options[0]).toMatchObject({ prefix: "donation-cancel", requireAvailability: true });
    expect(h.cancels).toEqual([]);
  });

  test("404 for an id that is not a UUID, without touching PayMe", async () => {
    const h = deps({ kind: "ok", body: { status: "cancelled" } });
    for (const donationId of [undefined, "", "not-a-uuid"]) {
      const res = await handlePayCodeCancelRequest(req(), { donationId }, h.deps as never);
      expect(res.status).toBe(404);
    }
    expect(h.cancels).toEqual([]);
  });

  test("404 for a donation with no PayMe payment", async () => {
    const h = deps({ kind: "not_found" });
    const res = await handlePayCodeCancelRequest(req(), { donationId: ID }, h.deps as never);
    expect(res.status).toBe(404);
  });

  test("502 when PayMe cannot be asked, so the donor is never told a live PayCode is cancelled", async () => {
    const h = deps(new Error("PayMe cancel payment request failed with 500"));
    const res = await handlePayCodeCancelRequest(req(), { donationId: ID }, h.deps as never);

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("500");
  });
});
