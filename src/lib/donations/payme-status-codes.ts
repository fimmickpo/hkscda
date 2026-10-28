// PayMe payment request status codes (HSBC PayMe API v0.12): PR001 initiated and still payable,
// PR004 rejected or aborted, PR005 payment success, PR007 expired.
export const PAYME_SUCCESS_STATUS_CODES: ReadonlySet<string> = new Set(["PR005"]);

// Only these end a request for good. HSBC's sample payment.failure notification carries PR001 plus
// a reasonCode (EW2035): one payer's attempt failed while the PayCode is still payable, and a later
// attempt can succeed. A failed payment is terminal, so the webhook and the status poll must both
// fail a payment on these two codes alone.
export const PAYME_TERMINAL_FAILURE_STATUS_CODES: ReadonlySet<string> = new Set(["PR004", "PR007"]);
