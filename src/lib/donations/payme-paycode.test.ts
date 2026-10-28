import { describe, expect, test } from "bun:test";

import {
  PAYCODE_EXPIRY_GRACE_MS,
  PAYCODE_UNCONFIRMED_POLL_WINDOW_MS,
  PayCodeRequestError,
  cancelPayCode,
  formatCountdown,
  loadPayCode,
  payCodeIsLive,
  payCodePagePath,
  payCodeRemainingMs,
  payCodeReturnUrl,
  payCodeSuccessUrl,
  resolvePayCodeScreen,
  type PayCodeLoad,
  type PayCodeStatus,
} from "./payme-paycode";

const EXPIRES = Date.parse("2026-10-26T12:10:00.000Z");
const ready = (skewMs = 0): PayCodeLoad => ({ kind: "ready", expiresAtMs: EXPIRES, skewMs });
const at = (msFromExpiry: number) => EXPIRES + msFromExpiry;

function screen(
  status: PayCodeStatus,
  nowMs: number,
  extra: Partial<Parameters<typeof resolvePayCodeScreen>[0]> = {},
) {
  return resolvePayCodeScreen({ load: ready(), status, nowMs, ...extra });
}

describe("formatCountdown", () => {
  test("shows mm:ss and only reaches 00:00 once the time is really up", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(599_001)).toBe("10:00");
    expect(formatCountdown(599_000)).toBe("09:59");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(1)).toBe("00:01");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5_000)).toBe("00:00");
  });
});

describe("payCodeRemainingMs", () => {
  test("counts down on the server's clock", () => {
    expect(payCodeRemainingMs(EXPIRES, at(-90_000), 0)).toBe(90_000);
    // The browser is 5 seconds behind the server, so 5 seconds less remain.
    expect(payCodeRemainingMs(EXPIRES, at(-90_000), 5_000)).toBe(85_000);
    expect(payCodeRemainingMs(EXPIRES, at(10_000), 0)).toBe(0);
  });
});

describe("resolvePayCodeScreen", () => {
  test("loading and load failures", () => {
    expect(
      resolvePayCodeScreen({ load: { kind: "loading" }, status: "pending", nowMs: 0 }),
    ).toEqual({
      kind: "loading",
    });
    expect(resolvePayCodeScreen({ load: { kind: "error" }, status: "pending", nowMs: 0 })).toEqual({
      kind: "unavailable",
    });
  });

  test("a payable PayCode shows the code with the time left", () => {
    expect(screen("pending", at(-540_000))).toEqual({ kind: "scan", remainingMs: 540_000 });
    expect(screen("pending", at(-1))).toEqual({ kind: "scan", remainingMs: 1 });
  });

  test("the code is hidden the moment the countdown ends, but the donor is not told it failed", () => {
    expect(screen("pending", at(0))).toEqual({ kind: "confirming" });
    expect(screen("pending", at(PAYCODE_EXPIRY_GRACE_MS - 1))).toEqual({ kind: "confirming" });
  });

  test("still pending after the grace period is reported as unconfirmed, never as failed", () => {
    expect(screen("pending", at(PAYCODE_EXPIRY_GRACE_MS))).toEqual({ kind: "unconfirmed" });
    expect(screen("pending", at(10 * 60_000))).toEqual({ kind: "unconfirmed" });
  });

  test("a payment that succeeded wins at any time, including after the countdown and a cancel", () => {
    for (const nowMs of [at(-500_000), at(0), at(PAYCODE_EXPIRY_GRACE_MS), at(3_600_000)]) {
      expect(screen("succeeded", nowMs)).toEqual({ kind: "paid" });
    }
    expect(screen("succeeded", at(-1), { cancelled: true })).toEqual({ kind: "paid" });
    expect(
      resolvePayCodeScreen({ load: { kind: "loading" }, status: "succeeded", nowMs: 0 }),
    ).toEqual({ kind: "paid" });
  });

  test("a failure before the countdown ended means it was declined or cancelled in the PayMe app", () => {
    expect(screen("failed", at(-200_000))).toEqual({ kind: "ended" });
    expect(screen("refunded", at(-200_000))).toEqual({ kind: "ended" });
  });

  test("a failure at or after the countdown means the PayCode expired", () => {
    expect(screen("failed", at(0))).toEqual({ kind: "expired" });
    expect(screen("failed", at(120_000))).toEqual({ kind: "expired" });
  });

  test("a cancel by the donor", () => {
    expect(screen("pending", at(-100_000), { cancelled: true })).toEqual({ kind: "cancelled" });
  });

  test("a payment being processed while the PayCode is still valid", () => {
    expect(screen("pending", at(-100_000), { processing: true })).toEqual({ kind: "processing" });
    // Expiry takes over: the page then waits to hear what became of that payment.
    expect(screen("pending", at(1_000), { processing: true })).toEqual({ kind: "confirming" });
  });

  test("uses the server's clock rather than the browser's", () => {
    // The browser says 4 seconds before expiry; the server is 5 seconds ahead, so it has expired.
    const load = ready(5_000);
    expect(resolvePayCodeScreen({ load, status: "pending", nowMs: at(-4_000) })).toEqual({
      kind: "confirming",
    });
    expect(resolvePayCodeScreen({ load, status: "pending", nowMs: at(-6_000) })).toEqual({
      kind: "scan",
      remainingMs: 1_000,
    });
  });

  test("a payment that had already settled when the page opened has no countdown to wait out", () => {
    const load: PayCodeLoad = { kind: "ready", expiresAtMs: null, skewMs: 0 };
    expect(resolvePayCodeScreen({ load, status: "failed", nowMs: at(0) })).toEqual({
      kind: "ended",
    });
    expect(resolvePayCodeScreen({ load, status: "pending", nowMs: at(0) })).toEqual({
      kind: "ended",
    });
    expect(resolvePayCodeScreen({ load, status: "succeeded", nowMs: at(0) })).toEqual({
      kind: "paid",
    });
  });
});

describe("payCodeIsLive", () => {
  const isLive = (kind: string, nowMs = at(0), load: PayCodeLoad = ready()) =>
    payCodeIsLive({ kind } as never, load, nowMs);

  test("the clock and the polling run while the donor is waiting for an answer", () => {
    for (const kind of ["loading", "scan", "processing", "confirming"]) {
      expect(isLive(kind)).toBe(true);
    }
  });

  test("and stop once the outcome is known", () => {
    for (const kind of ["paid", "ended", "expired", "cancelled", "unavailable"]) {
      expect(isLive(kind)).toBe(false);
    }
  });

  test("a page left on 'could not confirm' keeps listening for a while, then gives up", () => {
    expect(isLive("unconfirmed", at(PAYCODE_UNCONFIRMED_POLL_WINDOW_MS - 1))).toBe(true);
    expect(isLive("unconfirmed", at(PAYCODE_UNCONFIRMED_POLL_WINDOW_MS))).toBe(false);
    expect(isLive("unconfirmed", at(PAYCODE_UNCONFIRMED_POLL_WINDOW_MS), ready(60_000))).toBe(
      false,
    );
    expect(isLive("unconfirmed", at(PAYCODE_UNCONFIRMED_POLL_WINDOW_MS - 1), ready(-60_000))).toBe(
      true,
    );
  });

  test("without an expiry to measure from, 'could not confirm' does not poll", () => {
    const settled: PayCodeLoad = { kind: "ready", expiresAtMs: null, skewMs: 0 };
    expect(isLive("unconfirmed", at(0), settled)).toBe(false);
    expect(isLive("unconfirmed", at(0), { kind: "error" })).toBe(false);
  });
});

describe("page addresses", () => {
  test("encode the donation id", () => {
    expect(payCodePagePath("a b")).toBe("/donate/payme/a%20b");
    expect(payCodeSuccessUrl("d1")).toBe("/donate?status=success&donation=d1");
    expect(payCodeReturnUrl("d1")).toBe("/donate?status=cancelled&donation=d1");
  });
});

describe("loadPayCode and cancelPayCode", () => {
  function fakeFetch(response: Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response;
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  test("loadPayCode reads the PayCode without caching", async () => {
    const body = { status: "succeeded", language: "en" };
    const { calls, impl } = fakeFetch(Response.json(body));
    expect(await loadPayCode("d/1", impl)).toEqual(body as never);
    expect(calls[0].url).toBe("/api/donations/d%2F1/paycode");
    expect(calls[0].init?.cache).toBe("no-store");
  });

  test("cancelPayCode posts to the cancel route", async () => {
    const { calls, impl } = fakeFetch(Response.json({ status: "cancelled" }));
    expect(await cancelPayCode("d1", impl)).toEqual({ status: "cancelled" });
    expect(calls[0].url).toBe("/api/donations/d1/cancel");
    expect(calls[0].init?.method).toBe("POST");
  });

  test("a failed request carries its HTTP status", async () => {
    const { impl } = fakeFetch(Response.json({ error: "nope" }, { status: 404 }));
    const error = await loadPayCode("d1", impl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayCodeRequestError);
    expect((error as PayCodeRequestError).statusCode).toBe(404);
  });
});
