import type { CheckoutPolicyErrorCode } from "./checkoutPolicy";

/**
 * What the donation form can tell a donor about a refused submission. "unknown" keeps the
 * generic message, which is right for a server error or a request the form should never send.
 */
export type DonationSubmitFailure =
  | "verification"
  | "rate_limited"
  | "busy"
  | "checkout_unavailable"
  | "unknown";

// Every code the checkout gate answers with (CheckoutPolicyError). A Record, so a new code fails
// to compile here until it is placed.
const checkoutGateCodes: Record<CheckoutPolicyErrorCode, true> = {
  disabled: true,
  method_unavailable: true,
  stale_config: true,
  unavailable: true,
};

/**
 * Sorts a refused POST /api/donations by its status and, for the checkout gate, its code.
 *
 * - 403: Turnstile did not pass, or is not set up in production.
 * - 429: too many requests from this address.
 * - 503 without a code: the rate limiter could not count the request.
 * - any checkout gate code (409, 422 or 503): the payment method is off or was just changed.
 */
export function classifyDonationSubmitFailure(
  status: number,
  code?: string | null,
): DonationSubmitFailure {
  if (code && Object.hasOwn(checkoutGateCodes, code)) return "checkout_unavailable";
  if (status === 403) return "verification";
  if (status === 429) return "rate_limited";
  if (status === 503) return "busy";
  return "unknown";
}
