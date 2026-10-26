import type { DonationMethod } from "./contracts";

const STORAGE_KEY = "hkscda-donation-checkout-intent";

export type CheckoutIntent = { fingerprint: string; key: string; method: DonationMethod };
export type CheckoutIntentRef = { current: CheckoutIntent | null };
export type CheckoutIntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Session storage can be missing or throw (private windows, blocked site data). The in-memory
// ref still covers retries within one page view, so callers pass null and carry on.
export function browserCheckoutIntentStorage(): CheckoutIntentStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readSavedIntent(storage: CheckoutIntentStorage | null): Partial<CheckoutIntent> | null {
  try {
    return JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as Partial<CheckoutIntent> | null;
  } catch {
    return null;
  }
}

// One idempotency key per distinct form: an identical resubmit (lost response, reload) reuses
// it, so the server hands back the same donation instead of creating another.
export function selectCheckoutIntent({
  fingerprint,
  method,
  ref,
  storage,
  newKey = () => globalThis.crypto.randomUUID(),
}: {
  fingerprint: string;
  method: DonationMethod;
  ref: CheckoutIntentRef;
  storage: CheckoutIntentStorage | null;
  newKey?: () => string;
}): CheckoutIntent {
  let intent = ref.current;
  const saved = readSavedIntent(storage);
  if (saved?.fingerprint === fingerprint && saved.key) {
    intent = { fingerprint, key: saved.key, method };
  }
  if (!intent || intent.fingerprint !== fingerprint) {
    intent = { fingerprint, key: newKey(), method };
  }
  ref.current = intent;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Keep the in-memory key when storage is unavailable.
  }
  return intent;
}

// Forget the intent so the next submit mints a new idempotency key. A late callback passes its
// own `onlyKey`, so it cannot drop a newer intent that has replaced the one it belongs to.
export function discardCheckoutIntent(
  ref: CheckoutIntentRef,
  storage: CheckoutIntentStorage | null,
  onlyKey?: string,
) {
  if (onlyKey !== undefined && ref.current?.key !== onlyKey) return;
  ref.current = null;
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

// A PayMe PayCode is single-use and short-lived: the server fails a rejected, aborted or
// expired request for good, and the same key then only ever returns a 409. Coming back from a
// cancelled PayMe checkout must therefore not leave its intent behind. Other providers keep
// theirs, because a resubmit reuses their stored checkout URL.
export function discardCancelledPayMeIntent(
  ref: CheckoutIntentRef,
  storage: CheckoutIntentStorage | null,
): boolean {
  if (ref.current?.method !== "payme" && readSavedIntent(storage)?.method !== "payme") {
    return false;
  }
  discardCheckoutIntent(ref, storage);
  return true;
}
