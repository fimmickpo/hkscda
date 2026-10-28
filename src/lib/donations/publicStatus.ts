export const publicDonationStatuses = ["pending", "succeeded", "failed", "refunded"] as const;

export type PublicDonationStatus = (typeof publicDonationStatuses)[number];

export type PublicDonationStatusResponse = {
  status: PublicDonationStatus;
};

type StatusLoadOptions = { signal?: AbortSignal };

export type PublicDonationStatusLoader = (
  donationId: string,
  options?: StatusLoadOptions,
) => Promise<PublicDonationStatusResponse>;

export type PollDonationSucceededOptions = {
  attempts?: number;
  delayMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  load?: PublicDonationStatusLoader;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

const maxAttempts = 90;
const defaultDelayMs = 10_000;
const maxDeadlineMs = 15 * 60 * 1000;

export const pollDonationDefaults = {
  attempts: maxAttempts,
  delayMs: defaultDelayMs,
  deadlineMs: maxDeadlineMs,
} as const;

function isPublicDonationStatus(value: unknown): value is PublicDonationStatus {
  return (
    typeof value === "string" && publicDonationStatuses.includes(value as PublicDonationStatus)
  );
}

export async function loadDonationStatus(
  donationId: string,
  { signal }: StatusLoadOptions = {},
): Promise<PublicDonationStatusResponse> {
  const response = await fetch(`/api/donations/${encodeURIComponent(donationId)}/status`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`Donation status request failed: ${response.status}`);

  const body = (await response.json()) as { status?: unknown };
  if (!isPublicDonationStatus(body.status)) throw new Error("Invalid donation status response");
  return { status: body.status };
}

function abortableSleep(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function loadWithDeadline(
  load: PublicDonationStatusLoader,
  donationId: string,
  signal: AbortSignal | undefined,
  remainingMs: number,
) {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal?.reason);
  if (signal?.aborted) {
    abortRequest();
  } else {
    signal?.addEventListener("abort", abortRequest, { once: true });
  }

  const timeout = setTimeout(() => requestController.abort(), remainingMs);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    requestController.signal.addEventListener("abort", onAbort, { once: true });
    if (requestController.signal.aborted) onAbort();
  });
  try {
    const loading = Promise.resolve().then(() =>
      load(donationId, { signal: requestController.signal }),
    );
    return await Promise.race([loading, aborted]);
  } finally {
    clearTimeout(timeout);
    if (onAbort) requestController.signal.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", abortRequest);
  }
}

export async function pollDonationSucceeded(
  donationId: string,
  options: PollDonationSucceededOptions = {},
): Promise<boolean> {
  const attempts = Math.min(maxAttempts, Math.max(1, Math.floor(options.attempts ?? maxAttempts)));
  const delayMs = Math.max(0, options.delayMs ?? defaultDelayMs);
  const deadlineMs = Math.min(maxDeadlineMs, Math.max(0, options.deadlineMs ?? maxDeadlineMs));
  const load = options.load ?? loadDonationStatus;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadlineAt = now() + deadlineMs;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted || now() >= deadlineAt) return false;

    try {
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) return false;
      const result = await loadWithDeadline(load, donationId, options.signal, remainingMs);
      if (result.status === "succeeded") return true;
      if (result.status === "failed" || result.status === "refunded") return false;
    } catch {
      if (options.signal?.aborted) return false;
      // Network and transient server failures are retried within the same
      // absolute deadline. They are not payment outcomes.
    }

    if (attempt >= attempts - 1) break;
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    if (delayMs > 0) {
      try {
        await sleep(Math.min(delayMs, remainingMs), options.signal);
      } catch {
        return false;
      }
    }
  }

  return false;
}
