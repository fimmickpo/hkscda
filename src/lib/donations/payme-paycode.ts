// Shared by the PayCode page and its two API routes: the response shapes, the countdown, and the
// rules that decide which screen the donor sees. Nothing here touches the server or a secret.

export type PayCodeLanguage = "zh-HK" | "en";
export type PayCodeStatus = "pending" | "succeeded" | "failed" | "refunded";

export type PayCodeResponse =
  | {
      status: "pending";
      webLink: string;
      amountCents: number;
      currency: "HKD";
      /** When PayMe stops accepting the PayCode (ISO 8601). */
      expiresAt: string;
      /** The server clock when this was answered, so the countdown ignores the browser's skew. */
      serverNow: string;
      language: PayCodeLanguage;
    }
  | { status: "succeeded" | "failed" | "refunded"; language: PayCodeLanguage };

export type CancelResponse = { status: "cancelled" | "paid" | "in_progress" };

/** The page asks our own status route this often. PayMe is only asked after 60 seconds. */
export const PAYCODE_POLL_INTERVAL_MS = 10_000;
/** After the countdown ends, how long to keep waiting for the expiry to be confirmed. */
export const PAYCODE_EXPIRY_GRACE_MS = 30_000;
/** How long the "paid" screen stays up before the page moves on to the confirmation. */
export const PAYCODE_SUCCESS_REDIRECT_DELAY_MS = 2_000;
/** A page left on "could not confirm" keeps listening this long past expiry, then stops asking. */
export const PAYCODE_UNCONFIRMED_POLL_WINDOW_MS = 30 * 60_000;

export function payCodePagePath(donationId: string): string {
  return `/donate/payme/${encodeURIComponent(donationId)}`;
}

/** The donation page confirms the payment and clears the saved checkout. */
export function payCodeSuccessUrl(donationId: string): string {
  return `/donate?status=success&donation=${encodeURIComponent(donationId)}`;
}

/** The donation form again, with the "payment is not complete" notice and a fresh checkout. */
export function payCodeReturnUrl(donationId: string): string {
  return `/donate?status=cancelled&donation=${encodeURIComponent(donationId)}`;
}

export function payCodeRemainingMs(expiresAtMs: number, nowMs: number, skewMs: number): number {
  return Math.max(0, expiresAtMs - (nowMs + skewMs));
}

/** mm:ss, rounded up so the display reads 00:00 only once the PayCode has really expired. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export type PayCodeLoad =
  | { kind: "loading" }
  | { kind: "error" }
  /** `expiresAtMs` is null when the payment had already settled by the time the page loaded. */
  | { kind: "ready"; expiresAtMs: number | null; skewMs: number };

export type PayCodeScreen =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "scan"; remainingMs: number }
  | { kind: "processing" }
  | { kind: "confirming" }
  | { kind: "paid" }
  | { kind: "ended" }
  | { kind: "expired" }
  | { kind: "unconfirmed" }
  | { kind: "cancelled" };

/**
 * Which screen to show. The server decides what happened (status); the clock only decides how long
 * we keep waiting for it to say so.
 *
 * - A payment that succeeded wins over everything, even after the countdown: someone may have paid
 *   in the last seconds, and the confirmation can arrive late.
 * - When the countdown ends the PayCode is hidden at once, but the donor is not told it failed until
 *   the server says so. If it still has not said so after the grace period, the honest answer is
 *   "we could not confirm" — never "try again", because a payment may have gone through.
 */
export function resolvePayCodeScreen(input: {
  load: PayCodeLoad;
  status: PayCodeStatus;
  nowMs: number;
  cancelled?: boolean;
  processing?: boolean;
  graceMs?: number;
}): PayCodeScreen {
  const { load, status, nowMs, cancelled = false, processing = false } = input;
  const graceMs = input.graceMs ?? PAYCODE_EXPIRY_GRACE_MS;

  if (status === "succeeded") return { kind: "paid" };
  if (cancelled) return { kind: "cancelled" };
  if (load.kind === "loading") return { kind: "loading" };
  if (load.kind === "error") return { kind: "unavailable" };

  const { expiresAtMs, skewMs } = load;
  const serverNowMs = nowMs + skewMs;
  const expired = expiresAtMs !== null && serverNowMs >= expiresAtMs;

  if (status === "failed" || status === "refunded") {
    return { kind: expired ? "expired" : "ended" };
  }
  if (expiresAtMs === null) return { kind: "ended" };
  if (expired) {
    return serverNowMs >= expiresAtMs + graceMs ? { kind: "unconfirmed" } : { kind: "confirming" };
  }
  if (processing) return { kind: "processing" };
  return { kind: "scan", remainingMs: payCodeRemainingMs(expiresAtMs, nowMs, skewMs) };
}

/**
 * Whether the page still has something to learn, and so keeps its clock ticking and keeps asking the
 * server. "Could not confirm" is not final: a payment confirmed late should still turn the page into
 * "paid". It only stops listening after PAYCODE_UNCONFIRMED_POLL_WINDOW_MS past expiry.
 */
export function payCodeIsLive(screen: PayCodeScreen, load: PayCodeLoad, nowMs: number): boolean {
  switch (screen.kind) {
    case "loading":
    case "scan":
    case "processing":
    case "confirming":
      return true;
    case "unconfirmed":
      return (
        load.kind === "ready" &&
        load.expiresAtMs !== null &&
        nowMs + load.skewMs < load.expiresAtMs + PAYCODE_UNCONFIRMED_POLL_WINDOW_MS
      );
    default:
      return false;
  }
}

export class PayCodeRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "PayCodeRequestError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new PayCodeRequestError(`PayCode request failed: ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export async function loadPayCode(
  donationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PayCodeResponse> {
  const response = await fetchImpl(`/api/donations/${encodeURIComponent(donationId)}/paycode`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return readJson<PayCodeResponse>(response);
}

export async function cancelPayCode(
  donationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelResponse> {
  const response = await fetchImpl(`/api/donations/${encodeURIComponent(donationId)}/cancel`, {
    method: "POST",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  return readJson<CancelResponse>(response);
}
