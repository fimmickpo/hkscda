import { describe, expect, test } from "bun:test";

import { createDonation, DonationIdempotencyConflictError } from "./service";
import type { DonationRepository, PaymentProviders } from "./service";

function createFakeRepository(): DonationRepository & {
  supporterConsents: unknown[];
  donations: unknown[];
  payments: unknown[];
  resolvedContacts: unknown[];
} {
  const supporter = { id: "supporter-1", email: "donor@example.com" };
  const donations: unknown[] = [];
  const payments: unknown[] = [];
  const supporterConsents: unknown[] = [];
  const resolvedContacts: unknown[] = [];
  const donationRows = new Map<
    string,
    {
      id: string;
      supporter_id: string;
      created_at: string;
      amount_cents: number;
      idempotency_fingerprint: string;
    }
  >();
  type Payment = Parameters<DonationRepository["createPayment"]>[0] & {
    id: string;
    checkout_url: string | null;
    checkout_attempted_at: string | null;
    provider_order_ref?: string | null;
  };
  const paymentRows = new Map<string, Payment>();

  return {
    supporterConsents,
    donations,
    payments,
    resolvedContacts,
    async admitNewCheckout(input) {
      return {
        snapshot: {
          configId: "9a78c87c-1e3a-4c02-b551-71a9b69a5412",
          configVersion: input.expectedConfigVersion,
          purpose: input.purpose,
          method: input.method,
          displayLabelZh: input.method === "fps" ? "轉數快 FPS" : "PayMe Business",
          displayLabelEn: input.method,
          details: {
            payableTo: "Synthetic default charity",
            identifier: input.method === "fps" ? "FPS TEST-123" : "PayMe TEST-123",
          },
          capturedAt: "2026-09-27T00:00:00Z",
        },
        instructionsActive: true,
      };
    },
    async resolvePublicIdentity(contact) {
      resolvedContacts.push(contact);
      return { supporterId: supporter.id, kind: "existing" };
    },
    async ensureSupporterRole() {},
    async replaceConsents(rows) {
      for (const row of rows) {
        if (
          !supporterConsents.some((existing) => JSON.stringify(existing) === JSON.stringify(row))
        ) {
          supporterConsents.push(row);
        }
      }
    },
    async findDonationByIdempotencyKey(key) {
      return donationRows.get(key) ?? null;
    },
    async createDonation(input) {
      donations.push(input);
      const row = {
        id: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
        supporter_id: supporter.id,
        created_at: "2026-06-24T10:00:00.000Z",
        amount_cents: input.amount_cents,
        idempotency_fingerprint: input.idempotency_fingerprint,
      };
      donationRows.set(input.idempotency_key, row);
      return row;
    },
    async findPaymentByIdempotencyKey(key) {
      return paymentRows.get(key) ?? null;
    },
    async createPayment(payment) {
      payments.push(payment);
      const row: Payment = {
        id: "payment-1",
        ...payment,
        checkout_url: null,
        checkout_attempted_at: null,
      };
      paymentRows.set(payment.idempotency_key, row);
      return row;
    },
    async beginCheckoutAttempt(paymentId, timestamp) {
      const row = [...paymentRows.values()].find((payment) => payment.id === paymentId);
      if (!row) throw new Error("payment missing");
      if (row.checkout_attempted_at) {
        return { attemptedAt: row.checkout_attempted_at, claimed: false };
      }
      row.checkout_attempted_at = timestamp;
      return { attemptedAt: timestamp, claimed: true };
    },
    async updatePaymentProviderRef(paymentId, providerRef, checkoutUrl, providerOrderRef) {
      const row = [...paymentRows.values()].find((payment) => payment.id === paymentId);
      if (!row) throw new Error("payment missing");
      row.provider_ref = providerRef;
      row.checkout_url = checkoutUrl;
      row.provider_order_ref = providerOrderRef ?? null;
      payments.push({
        id: paymentId,
        provider_ref: providerRef,
        ...(providerOrderRef ? { provider_order_ref: providerOrderRef } : {}),
      });
    },
  };
}
const providers: PaymentProviders = {
  async createStripeCheckout() {
    return { providerRef: "cs_test_123", url: "https://checkout.stripe.test/session" };
  },
  async createPayPalOrder() {
    return { providerRef: "paypal_order_123", url: "https://paypal.test/checkout" };
  },
  async createCodAlipayHkCheckout() {
    return {
      providerRef: "cod_order_123",
      providerOrderRef: "hkscda-order-123",
      url: "https://cod.test/checkout",
    };
  },
  async createPayMeCheckout() {
    return { providerRef: "pr_stub", webLink: "https://web.stub", appLink: "https://app.stub" };
  },
};

const baseInput = {
  idempotencyKey: "e15e9832-469b-4710-b2ea-244d8a39aa12",
  amountCents: 30000,
  expectedConfigVersion: 1,
  currency: "HKD" as const,
  purpose: "medical" as const,
  receiptRequested: true,
  donor: {
    name: "Ada",
    email: "DONOR@example.com",
    phone: "9123 4567",
    language: "zh-HK" as const,
  },
  consents: { email: true, whatsapp: false },
};

describe("createDonation", () => {
  test("disabled_policy_has_zero_side_effects", async () => {
    const repository = Object.assign(createFakeRepository(), {
      admitNewCheckout: async () => {
        throw new Error("checkout disabled");
      },
    });
    let providerCalls = 0;
    await expect(
      createDonation({
        input: { ...baseInput, method: "stripe" as const, expectedConfigVersion: 1 },
        repository,
        providers: {
          ...providers,
          async createStripeCheckout(input) {
            providerCalls += 1;
            return providers.createStripeCheckout(input);
          },
        },
      }),
    ).rejects.toThrow("checkout disabled");
    expect(repository.resolvedContacts).toHaveLength(0);
    expect(repository.donations).toHaveLength(0);
    expect(repository.payments).toHaveLength(0);
    expect(providerCalls).toBe(0);
  });

  test("replays the same checkout intent without a second donation, payment, or provider call", async () => {
    const repository = createFakeRepository();
    let checkoutCalls = 0;
    const countingProviders: PaymentProviders = {
      ...providers,
      async createStripeCheckout(input) {
        checkoutCalls += 1;
        return providers.createStripeCheckout(input);
      },
    };

    const args = {
      input: { ...baseInput, method: "stripe" as const },
      repository,
      providers: countingProviders,
    };
    const first = await createDonation(args);
    const replay = await createDonation(args);

    expect(replay).toEqual(first);
    expect(repository.donations).toHaveLength(1);
    expect(
      repository.payments.filter((payment) => "donation_id" in (payment as object)),
    ).toHaveLength(1);
    expect(checkoutCalls).toBe(1);
    expect(repository.supporterConsents).toHaveLength(1);
  });

  test("keeps the same payment for retry after provider reference persistence fails", async () => {
    const repository = createFakeRepository();
    let updateCalls = 0;
    let checkoutCalls = 0;
    repository.updatePaymentProviderRef = async () => {
      updateCalls += 1;
      if (updateCalls === 1) throw new Error("temporary database outage");
    };
    const countingProviders: PaymentProviders = {
      ...providers,
      async createStripeCheckout(input) {
        checkoutCalls += 1;
        expect(input.paymentId).toBe("payment-1");
        return providers.createStripeCheckout(input);
      },
    };
    const args = {
      input: { ...baseInput, method: "stripe" as const },
      repository,
      providers: countingProviders,
    };

    await expect(createDonation(args)).rejects.toThrow("temporary database outage");
    const replay = await createDonation(args);

    expect(replay.kind).toBe("redirect");
    expect(repository.donations).toHaveLength(1);
    expect(
      repository.payments.filter((payment) => "donation_id" in (payment as object)),
    ).toHaveLength(1);
    expect(checkoutCalls).toBe(2);
  });

  test("rejects a changed request that reuses an existing key", async () => {
    const repository = createFakeRepository();
    const input = { ...baseInput, method: "stripe" as const };
    await createDonation({ input, repository, providers });

    await expect(
      createDonation({
        input: { ...input, amountCents: 40000 },
        repository,
        providers,
      }),
    ).rejects.toThrow("Donation intent conflicts");
    expect(repository.donations).toHaveLength(1);
  });

  test("stops an uncertain Stripe checkout after the provider retry window", async () => {
    const repository = createFakeRepository();
    let checkoutCalls = 0;
    const flakyProviders: PaymentProviders = {
      ...providers,
      async createStripeCheckout() {
        checkoutCalls += 1;
        throw new Error("provider response lost");
      },
    };
    const input = { ...baseInput, method: "stripe" as const };
    await expect(
      createDonation({
        input,
        repository,
        providers: flakyProviders,
        now: () => new Date("2026-09-25T00:00:00Z"),
      }),
    ).rejects.toThrow("provider response lost");

    await expect(
      createDonation({
        input,
        repository,
        providers: flakyProviders,
        now: () => new Date("2026-09-25T01:01:00Z"),
      }),
    ).rejects.toThrow("Checkout outcome is uncertain");
    expect(checkoutCalls).toBe(1);
  });

  test("never retries an uncertain COD order creation", async () => {
    const repository = createFakeRepository();
    let checkoutCalls = 0;
    const flakyProviders: PaymentProviders = {
      ...providers,
      async createCodAlipayHkCheckout() {
        checkoutCalls += 1;
        throw new Error("provider response lost");
      },
    };
    const args = {
      input: { ...baseInput, method: "alipayhk" as const },
      repository,
      providers: flakyProviders,
    };

    await expect(createDonation(args)).rejects.toThrow("Checkout outcome is uncertain");
    await expect(createDonation(args)).rejects.toThrow("Checkout outcome is uncertain");
    expect(checkoutCalls).toBe(1);
    expect(repository.donations).toHaveLength(1);
  });
  test("manual instructions come from an admitted config snapshot, never a hard-coded account", async () => {
    const repository = Object.assign(createFakeRepository(), {
      admitNewCheckout: async () => ({
        configId: "9a78c87c-1e3a-4c02-b551-71a9b69a5412",
        configVersion: 1,
        snapshot: {
          configId: "9a78c87c-1e3a-4c02-b551-71a9b69a5412",
          configVersion: 1,
          purpose: "donation" as const,
          method: "fps" as const,
          displayLabelZh: "轉數快 FPS",
          displayLabelEn: "FPS",
          details: { payableTo: "Synthetic charity", identifier: "FPS ID SANDBOX-321" },
          capturedAt: "2026-09-27T00:00:00Z",
        },
        instructionsActive: true,
      }),
    });
    const result = await createDonation({
      input: { ...baseInput, method: "fps" as const },
      repository,
      providers,
    });
    expect(result.kind).toBe("manual");
    if (result.kind !== "manual") throw new Error("expected manual instructions");
    expect(result.instructions).toMatchObject({
      payableTo: "Synthetic charity",
      identifier: "FPS ID SANDBOX-321",
    });
    expect(JSON.stringify(result)).not.toContain("8727588");
  });

  test("withdrawn manual config keeps the admitted reference but hides old payment details", async () => {
    const repository = createFakeRepository();
    const originalAdmission = repository.admitNewCheckout;
    repository.admitNewCheckout = async (input) => ({
      ...(await originalAdmission(input)),
      instructionsActive: false,
    });
    const result = await createDonation({
      input: { ...baseInput, method: "fps" as const },
      repository,
      providers,
    });
    expect(result).toMatchObject({
      kind: "manual",
      reference: "HKSCDA-F8DCE8FA",
      instructions: null,
    });
    expect(JSON.stringify(result)).not.toContain("FPS TEST-123");
  });

  test("creates pending manual FPS donations with a unique reference", async () => {
    const repository = createFakeRepository();

    const result = await createDonation({
      input: { ...baseInput, method: "fps" as const },
      repository,
      providers,
      now: () => new Date("2026-06-24T10:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "manual",
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      reference: "HKSCDA-F8DCE8FA",
      instructions: {
        method: "fps",
        label: "轉數快 FPS",
        payableTo: "Synthetic default charity",
        identifier: "FPS TEST-123",
        amountCents: 30000,
      },
    });
    expect(repository.payments[0]).toMatchObject({
      donation_id: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      provider: "fps",
      provider_ref: "HKSCDA-F8DCE8FA",
      amount_cents: 30000,
      status: "pending",
    });
    expect(repository.resolvedContacts).toEqual([
      {
        name: "Ada",
        email: "donor@example.com",
        phone: "9123 4567",
        language: "zh-HK",
        source: "donation_form",
      },
    ]);
    expect(repository.supporterConsents).toEqual([
      expect.objectContaining({ channel: "whatsapp", status: "opt_out" }),
    ]);
    expect(repository.donations[0]).toMatchObject({
      contact_name: "Ada",
      contact_email: "donor@example.com",
      contact_phone: "9123 4567",
      contact_language: "zh-HK",
      consent_email_requested: true,
      consent_whatsapp_requested: false,
      acquisition_source: null,
      acquisition_context: null,
      acquisition_placement: null,
      acquisition_trigger: null,
    });
  });
  test("stores a custom purpose without exposing it to checkout providers", async () => {
    const repository = createFakeRepository();
    let checkoutInput: Parameters<PaymentProviders["createStripeCheckout"]>[0] | undefined;
    const capturingProviders: PaymentProviders = {
      async createStripeCheckout(input) {
        checkoutInput = input;
        return { providerRef: "cs_test_123", url: "https://checkout.stripe.test/session" };
      },
      async createPayPalOrder() {
        return { providerRef: "paypal_order_123", url: "https://paypal.test/checkout" };
      },
      async createCodAlipayHkCheckout() {
        return { providerRef: "cod_order_123", url: "https://cod.test/checkout" };
      },
      async createPayMeCheckout() {
        return { providerRef: "pr_stub", webLink: "https://web.stub", appLink: "https://app.stub" };
      },
    };

    await createDonation({
      input: {
        ...baseInput,
        method: "stripe" as const,
        customPurpose: "  個案 A  ",
      },
      repository,
      providers: capturingProviders,
      now: () => new Date("2026-06-24T10:00:00.000Z"),
    });

    expect(repository.donations[0]).toMatchObject({
      purpose: "medical",
      custom_purpose: "個案 A",
    });
    expect(checkoutInput).toMatchObject({ purpose: "medical" });
    expect(checkoutInput).not.toHaveProperty("customPurpose");
  });

  test("keeps the intent and payment when a checkout response is uncertain", async () => {
    const repository = createFakeRepository();
    let calls = 0;
    const flakyProviders: PaymentProviders = {
      ...providers,
      async createStripeCheckout(input) {
        calls += 1;
        if (calls === 1) throw new Error("provider response lost");
        expect(input.paymentId).toBe("payment-1");
        return providers.createStripeCheckout(input);
      },
      async createPayMeCheckout() {
        throw new Error("payme unavailable");
      },
    };
    const args = {
      input: { ...baseInput, method: "stripe" as const },
      repository,
      providers: flakyProviders,
    };

    await expect(createDonation(args)).rejects.toThrow("provider response lost");
    const replay = await createDonation(args);
    expect(replay.kind).toBe("redirect");
    expect(repository.donations).toHaveLength(1);
    expect(
      repository.payments.filter((payment) => "donation_id" in (payment as object)),
    ).toHaveLength(1);
    expect(calls).toBe(2);
  });
  test("creates Stripe checkout donations and stores the checkout session id", async () => {
    const repository = createFakeRepository();

    const result = await createDonation({
      input: {
        ...baseInput,
        method: "stripe" as const,
        attribution: {
          source: "contextual-cta" as const,
          context: "animal" as const,
          purpose: "medical" as const,
          placement: "mobile-bottom" as const,
          trigger: "scroll" as const,
        },
      },
      repository,
      providers,
      now: () => new Date("2026-06-24T10:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "redirect",
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      provider: "stripe",
      url: "https://checkout.stripe.test/session",
    });
    expect(repository.payments).toContainEqual({ id: "payment-1", provider_ref: "cs_test_123" });
    expect(repository.donations[0]).toMatchObject({
      acquisition_source: "contextual-cta",
      acquisition_context: "animal",
      acquisition_placement: "mobile-bottom",
      acquisition_trigger: "scroll",
    });
  });

  test("payme method creates a payment request and returns kind payme", async () => {
    const repository = createFakeRepository();
    const paymeProviders: PaymentProviders = {
      createStripeCheckout: async () => ({ providerRef: "s", url: "https://s" }),
      createPayPalOrder: async () => ({ providerRef: "p", url: "https://p" }),
      createCodAlipayHkCheckout: async () => ({ providerRef: "c", url: "https://c" }),
      createPayMeCheckout: async () => ({
        providerRef: "pr1",
        webLink: "https://web",
        appLink: "https://app",
      }),
    };
    const result = await createDonation({
      input: { ...baseInput, method: "payme" as const },
      repository,
      providers: paymeProviders,
    });
    expect(result.kind).toBe("payme");
    if (result.kind === "payme") {
      expect(result.paymentRequestId).toBe("pr1");
      expect(result.webLink).toBe("https://web");
      expect(result.appLink).toBe("https://app");
      expect(result.donationId).toBeTruthy();
    }
  });

  test("a payme checkout failure keeps the intent so a retry reuses the same donation", async () => {
    const repository = createFakeRepository();
    let attempts = 0;
    const flakyProviders: PaymentProviders = {
      createStripeCheckout: async () => ({ providerRef: "s", url: "https://s" }),
      createPayPalOrder: async () => ({ providerRef: "p", url: "https://p" }),
      createCodAlipayHkCheckout: async () => ({ providerRef: "c", url: "https://c" }),
      createPayMeCheckout: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("payme down");
        return { providerRef: "pr2", webLink: "https://web", appLink: "https://app" };
      },
    };

    await expect(
      createDonation({
        input: { ...baseInput, method: "payme" as const },
        repository,
        providers: flakyProviders,
      }),
    ).rejects.toThrow("payme down");

    // The provider may have accepted the request even though our call failed, so the
    // donation and pending payment stay in place and the retry keeps the same intent.
    const retry = await createDonation({
      input: { ...baseInput, method: "payme" as const },
      repository,
      providers: flakyProviders,
    });
    expect(attempts).toBe(2);
    expect(repository.donations).toHaveLength(1);
    expect(retry.kind).toBe("payme");
    if (retry.kind === "payme") {
      expect(retry.paymentRequestId).toBe("pr2");
      expect(retry.donationId).toBe("f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a");
    }
  });

  test("a payme resubmit while pending returns the stored PayCode link instead of minting another", async () => {
    const repository = createFakeRepository();
    let requests = 0;
    const countingProviders: PaymentProviders = {
      ...providers,
      createPayMeCheckout: async () => {
        requests += 1;
        return { providerRef: "pr1", webLink: "https://web", appLink: "https://app" };
      },
    };
    const input = { ...baseInput, method: "payme" as const };

    await createDonation({ input, repository, providers: countingProviders });
    const resubmit = await createDonation({ input, repository, providers: countingProviders });

    expect(requests).toBe(1);
    expect(resubmit).toMatchObject({ kind: "redirect", provider: "payme", url: "https://web" });
  });

  test("a failed payme payment closes its intent, so only a new idempotency key can retry", async () => {
    const repository = createFakeRepository();
    const input = { ...baseInput, method: "payme" as const };
    await createDonation({ input, repository, providers });

    // PayMe rejected, aborted or expired the request: the payment is failed for good. The
    // donor's "try again" has to arrive under a fresh key (see checkoutIntent.ts).
    const payment = await repository.findPaymentByIdempotencyKey(baseInput.idempotencyKey);
    payment!.status = "failed";

    await expect(createDonation({ input, repository, providers })).rejects.toThrow(
      DonationIdempotencyConflictError,
    );
    const freshKey = "0b0b0b0b-1111-4222-8333-444444444444";
    await expect(
      createDonation({
        input: { ...input, idempotencyKey: freshKey },
        repository,
        providers,
      }),
    ).resolves.toMatchObject({ kind: "payme" });
  });

  test("fps method still returns a manual result", async () => {
    const result = await createDonation({
      input: { ...baseInput, method: "fps" as const },
      repository: createFakeRepository(),
      providers: {
        createStripeCheckout: async () => ({ providerRef: "s", url: "https://s" }),
        createPayPalOrder: async () => ({ providerRef: "p", url: "https://p" }),
        createCodAlipayHkCheckout: async () => ({ providerRef: "c", url: "https://c" }),
        createPayMeCheckout: async () => ({
          providerRef: "pr1",
          webLink: "https://web",
          appLink: "https://app",
        }),
      },
    });
    expect(result.kind).toBe("manual");
  });

  test("maps AlipayHK to COD and passes the validated checkout experience only to COD", async () => {
    const repository = createFakeRepository();
    const calls = { stripe: 0, paypal: 0, cod: [] as unknown[] };
    const instrumentedProviders = {
      async createStripeCheckout() {
        calls.stripe += 1;
        return { providerRef: "cs_test_123", url: "https://checkout.stripe.test/session" };
      },
      async createPayPalOrder() {
        calls.paypal += 1;
        return { providerRef: "paypal_order_123", url: "https://paypal.test/checkout" };
      },
      async createCodAlipayHkCheckout(input: unknown) {
        calls.cod.push(input);
        return {
          providerRef: "cod_order_123",
          providerOrderRef: "hkscda-order-123",
          url: "https://cod.test/checkout",
        };
      },
      async createPayMeCheckout() {
        return { providerRef: "pr_stub", webLink: "https://web.stub", appLink: "https://app.stub" };
      },
    } satisfies PaymentProviders;

    const result = await createDonation({
      input: { ...baseInput, method: "alipayhk", checkoutExperience: "wap" },
      repository,
      providers: instrumentedProviders,
      now: () => new Date("2026-06-24T10:00:00.000Z"),
    });

    expect(repository.payments[0]).toMatchObject({
      donation_id: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      provider: "cod",
      provider_ref: null,
      amount_cents: 30000,
      status: "pending",
    });
    expect(calls).toEqual({
      stripe: 0,
      paypal: 0,
      cod: [
        {
          donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
          paymentId: "payment-1",
          amountCents: 30000,
          donorEmail: "donor@example.com",
          purpose: "medical",
          checkoutExperience: "wap",
        },
      ],
    });
    expect(result).toEqual({
      kind: "redirect",
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      provider: "cod",
      url: "https://cod.test/checkout",
    });
    expect(repository.payments).toContainEqual({
      id: "payment-1",
      provider_ref: "cod_order_123",
      provider_order_ref: "hkscda-order-123",
    });
  });
});
