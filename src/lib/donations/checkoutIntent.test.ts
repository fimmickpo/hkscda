import { describe, expect, test } from "bun:test";

import {
  discardCancelledPayMeIntent,
  discardCheckoutIntent,
  selectCheckoutIntent,
  type CheckoutIntentRef,
  type CheckoutIntentStorage,
} from "./checkoutIntent";

const STORAGE_KEY = "hkscda-donation-checkout-intent";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
  } satisfies CheckoutIntentStorage & { data: Record<string, string> };
}

function failingStorage(): CheckoutIntentStorage {
  const fail = () => {
    throw new Error("storage blocked");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function keySequence() {
  let issued = 0;
  return () => `key-${++issued}`;
}

describe("selectCheckoutIntent", () => {
  test("mints one key and reuses it for an identical resubmit", () => {
    const ref: CheckoutIntentRef = { current: null };
    const storage = memoryStorage();
    const newKey = keySequence();

    const first = selectCheckoutIntent({
      fingerprint: "fp",
      method: "payme",
      ref,
      storage,
      newKey,
    });
    const again = selectCheckoutIntent({
      fingerprint: "fp",
      method: "payme",
      ref,
      storage,
      newKey,
    });

    expect(first.key).toBe("key-1");
    expect(again.key).toBe("key-1");
  });

  test("reuses the saved key after a reload, when only session storage survives", () => {
    const storage = memoryStorage();
    selectCheckoutIntent({
      fingerprint: "fp",
      method: "stripe",
      ref: { current: null },
      storage,
      newKey: () => "saved-key",
    });

    const afterReload = selectCheckoutIntent({
      fingerprint: "fp",
      method: "stripe",
      ref: { current: null },
      storage,
      newKey: () => "should-not-be-used",
    });

    expect(afterReload.key).toBe("saved-key");
  });

  test("mints a new key when the form changes", () => {
    const ref: CheckoutIntentRef = { current: null };
    const storage = memoryStorage();
    const newKey = keySequence();

    selectCheckoutIntent({ fingerprint: "fp-a", method: "payme", ref, storage, newKey });
    const changed = selectCheckoutIntent({
      fingerprint: "fp-b",
      method: "payme",
      ref,
      storage,
      newKey,
    });

    expect(changed.key).toBe("key-2");
  });

  test("stores the method with the intent", () => {
    const storage = memoryStorage();

    selectCheckoutIntent({
      fingerprint: "fp",
      method: "payme",
      ref: { current: null },
      storage,
      newKey: () => "k",
    });

    expect(JSON.parse(storage.data[STORAGE_KEY])).toEqual({
      fingerprint: "fp",
      key: "k",
      method: "payme",
    });
  });

  test("ignores corrupt saved data", () => {
    const storage = memoryStorage({ [STORAGE_KEY]: "{not json" });

    const intent = selectCheckoutIntent({
      fingerprint: "fp",
      method: "fps",
      ref: { current: null },
      storage,
      newKey: () => "fresh",
    });

    expect(intent.key).toBe("fresh");
  });

  test("keeps the in-memory key when storage is missing or throws", () => {
    for (const storage of [null, failingStorage()]) {
      const ref: CheckoutIntentRef = { current: null };
      const newKey = keySequence();

      const first = selectCheckoutIntent({
        fingerprint: "fp",
        method: "payme",
        ref,
        storage,
        newKey,
      });
      const again = selectCheckoutIntent({
        fingerprint: "fp",
        method: "payme",
        ref,
        storage,
        newKey,
      });

      expect(first.key).toBe("key-1");
      expect(again.key).toBe("key-1");
    }
  });
});

describe("discardCheckoutIntent", () => {
  test("a discarded intent makes the next identical submit mint a fresh key", () => {
    // After a PayMe request is rejected or expires, the server answers an identical resubmit
    // under the same key with a 409. Discarding is what lets "try again" actually succeed.
    const ref: CheckoutIntentRef = { current: null };
    const storage = memoryStorage();
    const newKey = keySequence();

    const failedAttempt = selectCheckoutIntent({
      fingerprint: "fp",
      method: "payme",
      ref,
      storage,
      newKey,
    });
    discardCheckoutIntent(ref, storage);
    const retry = selectCheckoutIntent({
      fingerprint: "fp",
      method: "payme",
      ref,
      storage,
      newKey,
    });

    expect(failedAttempt.key).toBe("key-1");
    expect(retry.key).toBe("key-2");
    expect(JSON.parse(storage.data[STORAGE_KEY]).key).toBe("key-2");
  });

  test("a late callback cannot drop a newer intent", () => {
    // A PayMe poll can outlive its modal: the donor may submit a changed form before it ends.
    const ref: CheckoutIntentRef = { current: null };
    const storage = memoryStorage();
    const newKey = keySequence();
    const first = selectCheckoutIntent({
      fingerprint: "fp-a",
      method: "payme",
      ref,
      storage,
      newKey,
    });
    const second = selectCheckoutIntent({
      fingerprint: "fp-b",
      method: "payme",
      ref,
      storage,
      newKey,
    });

    discardCheckoutIntent(ref, storage, first.key);

    expect(ref.current?.key).toBe(second.key);
    expect(JSON.parse(storage.data[STORAGE_KEY]).key).toBe(second.key);

    discardCheckoutIntent(ref, storage, second.key);

    expect(ref.current).toBeNull();
    expect(storage.data[STORAGE_KEY]).toBeUndefined();
  });

  test("clears the ref even when storage throws or is missing", () => {
    for (const storage of [null, failingStorage()]) {
      const ref: CheckoutIntentRef = {
        current: { fingerprint: "fp", key: "k", method: "payme" },
      };

      discardCheckoutIntent(ref, storage);

      expect(ref.current).toBeNull();
    }
  });
});

describe("discardCancelledPayMeIntent", () => {
  test("discards a PayMe intent held in memory", () => {
    const storage = memoryStorage();
    const ref: CheckoutIntentRef = { current: null };
    selectCheckoutIntent({ fingerprint: "fp", method: "payme", ref, storage, newKey: () => "k" });

    expect(discardCancelledPayMeIntent(ref, storage)).toBe(true);
    expect(ref.current).toBeNull();
    expect(storage.data[STORAGE_KEY]).toBeUndefined();
  });

  test("discards a PayMe intent that only survives in session storage", () => {
    // The mobile flow leaves the page for the PayMe app, so the ref is empty on return.
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ fingerprint: "fp", key: "k", method: "payme" }),
    });
    const ref: CheckoutIntentRef = { current: null };

    expect(discardCancelledPayMeIntent(ref, storage)).toBe(true);
    expect(storage.data[STORAGE_KEY]).toBeUndefined();
  });

  test("keeps other providers' intents, which reuse their stored checkout URL", () => {
    const storage = memoryStorage();
    const ref: CheckoutIntentRef = { current: null };
    selectCheckoutIntent({ fingerprint: "fp", method: "stripe", ref, storage, newKey: () => "k" });

    expect(discardCancelledPayMeIntent(ref, storage)).toBe(false);
    expect(ref.current?.key).toBe("k");
    expect(JSON.parse(storage.data[STORAGE_KEY]).key).toBe("k");
  });

  test("keeps a saved intent that does not record its method", () => {
    const saved = JSON.stringify({ fingerprint: "fp", key: "k" });
    const storage = memoryStorage({ [STORAGE_KEY]: saved });

    expect(discardCancelledPayMeIntent({ current: null }, storage)).toBe(false);
    expect(storage.data[STORAGE_KEY]).toBe(saved);
  });

  test("does nothing when no intent exists", () => {
    expect(discardCancelledPayMeIntent({ current: null }, memoryStorage())).toBe(false);
    expect(discardCancelledPayMeIntent({ current: null }, null)).toBe(false);
  });
});
