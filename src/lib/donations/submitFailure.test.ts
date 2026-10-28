import { describe, expect, test } from "bun:test";

import { classifyDonationSubmitFailure } from "./submitFailure";

describe("classifyDonationSubmitFailure", () => {
  test("a refused verification is a verification failure", () => {
    expect(classifyDonationSubmitFailure(403)).toBe("verification");
    expect(classifyDonationSubmitFailure(403, undefined)).toBe("verification");
  });

  test("too many requests is rate limited", () => {
    expect(classifyDonationSubmitFailure(429)).toBe("rate_limited");
  });

  test("a 503 without a code is the service being busy", () => {
    expect(classifyDonationSubmitFailure(503)).toBe("busy");
    expect(classifyDonationSubmitFailure(503, null)).toBe("busy");
    expect(classifyDonationSubmitFailure(503, "")).toBe("busy");
  });

  // The statuses CheckoutPolicyError is answered with in routes/api/donations.ts.
  test.each([
    [409, "stale_config"],
    [422, "method_unavailable"],
    [503, "disabled"],
    [503, "unavailable"],
  ])("the checkout gate's %i %s means the payment method is not available", (status, code) => {
    expect(classifyDonationSubmitFailure(status, code)).toBe("checkout_unavailable");
  });

  test("the gate's code wins over the status, so a 503 from the gate is not 'busy'", () => {
    expect(classifyDonationSubmitFailure(503, "disabled")).not.toBe("busy");
    expect(classifyDonationSubmitFailure(403, "stale_config")).toBe("checkout_unavailable");
  });

  test("anything else keeps the generic message", () => {
    for (const status of [400, 401, 404, 409, 413, 422, 500, 502, 504]) {
      expect(classifyDonationSubmitFailure(status)).toBe("unknown");
    }
    // A code the gate does not use, and one that only looks like an inherited property.
    expect(classifyDonationSubmitFailure(409, "something_else")).toBe("unknown");
    expect(classifyDonationSubmitFailure(500, "toString")).toBe("unknown");
    expect(classifyDonationSubmitFailure(500, "__proto__")).toBe("unknown");
  });
});
