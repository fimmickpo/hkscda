import { createHash } from "node:crypto";

import {
  buildConsentRows,
  createManualPaymentReference,
  donationRequestSchema,
  type DonationMethod,
  type DonationRequest,
  type OnlinePaymentProvider,
  type PaymentProvider,
} from "./domain";
import { checkoutPurpose } from "./checkoutPolicy";
import type { PayMeCheckoutResult } from "./payme-provider.server";
import { resolvePaymentInstructions } from "../paymentPublicConfig/instructions";
import type { CheckoutInstructionAdmission } from "../paymentPublicConfig/types";
import type { CheckoutPurpose } from "./checkoutPolicy";
import type { IdentityResolution, PublicContact } from "../supporters/publicIdentity.server";

type DonationRow = {
  id: string;
  supporter_id: string;
  created_at: string;
  amount_cents: number;
  idempotency_fingerprint: string;
};

type PaymentInsert = {
  donation_id: string;
  idempotency_key: string;
  provider: PaymentProvider;
  provider_ref: string | null;
  amount_cents: number;
  status: "pending";
};

type PaymentRow = Omit<PaymentInsert, "status"> & {
  id: string;
  checkout_url?: string | null;
  checkout_attempted_at?: string | null;
  provider_order_ref?: string | null;
  status: "pending" | "succeeded" | "failed" | "refunded";
};

export type DonationRepository = {
  admitNewCheckout(input: {
    idempotencyKey: string;
    fingerprint: string;
    method: DonationMethod;
    purpose: CheckoutPurpose;
    expectedConfigVersion: number;
  }): Promise<CheckoutInstructionAdmission>;
  resolvePublicIdentity(contact: PublicContact): Promise<IdentityResolution>;
  ensureSupporterRole(input: { supporterId: string; role: "donor" }): Promise<void>;
  replaceConsents(rows: ReturnType<typeof buildConsentRows>): Promise<void>;
  findDonationByIdempotencyKey(key: string): Promise<DonationRow | null>;
  createDonation(input: {
    idempotency_key: string;
    idempotency_fingerprint: string;
    supporter_id: string;
    amount_cents: number;
    currency: "HKD";
    purpose: DonationRequest["purpose"];
    custom_purpose: string | null;
    type: "one_time";
    status: "pending";
    method: DonationMethod;
    receipt_requested: boolean;
    acquisition_source: NonNullable<DonationRequest["attribution"]>["source"] | null;
    acquisition_context: NonNullable<DonationRequest["attribution"]>["context"] | null;
    acquisition_placement: NonNullable<DonationRequest["attribution"]>["placement"] | null;
    acquisition_trigger: NonNullable<DonationRequest["attribution"]>["trigger"] | null;
    contact_name: string;
    contact_email: string;
    contact_phone: string | null;
    contact_language: "zh-HK" | "en";
    consent_email_requested: boolean;
    consent_whatsapp_requested: boolean;
  }): Promise<DonationRow>;
  findPaymentByIdempotencyKey(key: string): Promise<PaymentRow | null>;
  createPayment(input: PaymentInsert): Promise<PaymentRow>;
  beginCheckoutAttempt(
    paymentId: string,
    timestamp: string,
  ): Promise<{ attemptedAt: string; claimed: boolean }>;
  updatePaymentProviderRef(
    paymentId: string,
    providerRef: string,
    checkoutUrl: string,
    providerOrderRef?: string,
  ): Promise<void>;
};

export type PaymentProviders = {
  createStripeCheckout(input: CheckoutProviderInput): Promise<CheckoutProviderResult>;
  createPayPalOrder(input: CheckoutProviderInput): Promise<CheckoutProviderResult>;
  createCodAlipayHkCheckout(input: CheckoutProviderInput): Promise<CheckoutProviderResult>;
  createPayMeCheckout(input: CheckoutProviderInput): Promise<PayMeCheckoutResult>;
};

export type CheckoutProviderInput = {
  donationId: string;
  paymentId: string;
  amountCents: number;
  donorEmail: string;
  purpose: DonationRequest["purpose"];
  checkoutExperience: DonationRequest["checkoutExperience"];
};

export type CheckoutProviderResult = {
  providerRef: string;
  providerOrderRef?: string;
  url: string;
};

type CreateDonationArgs = {
  input: unknown;
  repository: DonationRepository;
  providers: PaymentProviders;
  now?: () => Date;
};

export type CreateDonationResult =
  | {
      kind: "redirect";
      donationId: string;
      provider: OnlinePaymentProvider;
      url: string;
    }
  | {
      kind: "manual";
      donationId: string;
      reference: string;
      instructions: {
        method: "fps";
        label: string;
        payableTo: string;
        identifier: string;
        amountCents: number;
      } | null;
    }
  | {
      kind: "payme";
      donationId: string;
      paymentRequestId: string;
      webLink: string;
      appLink: string;
    };

export class DonationIdempotencyConflictError extends Error {
  constructor() {
    super("Donation intent conflicts with an existing request");
    this.name = "DonationIdempotencyConflictError";
  }
}

export class DonationCheckoutRecoveryRequiredError extends Error {
  constructor(public readonly donationId: string) {
    super("Checkout outcome is uncertain; contact support before another attempt");
    this.name = "DonationCheckoutRecoveryRequiredError";
  }
}

const PROVIDER_RETRY_WINDOW_MS = 60 * 60 * 1000;
function fingerprintRequest(input: DonationRequest) {
  const { idempotencyKey: _key, ...request } = input;
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function assertDonationMatches(donation: DonationRow, fingerprint: string) {
  if (donation.idempotency_fingerprint !== fingerprint) {
    throw new DonationIdempotencyConflictError();
  }
}

function assertPaymentMatches(
  payment: PaymentRow,
  donationId: string,
  provider: PaymentProvider,
  amountCents: number,
) {
  if (
    payment.donation_id !== donationId ||
    payment.provider !== provider ||
    payment.amount_cents !== amountCents
  ) {
    throw new DonationIdempotencyConflictError();
  }
}

export async function createDonation({
  input,
  repository,
  providers,
  now = () => new Date(),
}: CreateDonationArgs): Promise<CreateDonationResult> {
  const donationInput = donationRequestSchema.parse(input);
  const requestKey = donationInput.idempotencyKey;
  const fingerprint = fingerprintRequest(donationInput);

  const admission = await repository.admitNewCheckout({
    idempotencyKey: requestKey,
    fingerprint,
    method: donationInput.method,
    purpose: checkoutPurpose(donationInput.purpose),
    expectedConfigVersion: donationInput.expectedConfigVersion,
  });

  let donation = await repository.findDonationByIdempotencyKey(requestKey);
  if (!donation) {
    const supporter = await repository.resolvePublicIdentity({
      ...donationInput.donor,
      phone: donationInput.donor.phone ?? null,
      source: "donation_form",
    });
    await repository.ensureSupporterRole({ supporterId: supporter.supporterId, role: "donor" });
    try {
      donation = await repository.createDonation({
        idempotency_key: requestKey,
        idempotency_fingerprint: fingerprint,
        supporter_id: supporter.supporterId,
        amount_cents: donationInput.amountCents,
        currency: donationInput.currency,
        purpose: donationInput.purpose,
        custom_purpose: donationInput.customPurpose ?? null,
        type: "one_time",
        status: "pending",
        method: donationInput.method,
        receipt_requested: donationInput.receiptRequested,
        acquisition_source: donationInput.attribution?.source ?? null,
        acquisition_context: donationInput.attribution?.context ?? null,
        acquisition_placement: donationInput.attribution?.placement ?? null,
        acquisition_trigger: donationInput.attribution?.trigger ?? null,
        contact_name: donationInput.donor.name,
        contact_email: donationInput.donor.email,
        contact_phone: donationInput.donor.phone ?? null,
        contact_language: donationInput.donor.language,
        consent_email_requested: donationInput.consents.email,
        consent_whatsapp_requested: donationInput.consents.whatsapp,
      });
    } catch (error) {
      // A concurrent request may have won the unique key. Only recover if its
      // committed row exists; otherwise preserve the original database error.
      donation = await repository.findDonationByIdempotencyKey(requestKey);
      if (!donation) throw error;
    }
  }
  assertDonationMatches(donation, fingerprint);
  await repository.replaceConsents(
    buildConsentRows({
      supporterId: donation.supporter_id,
      source: "donation_form",
      timestamp: donation.created_at,
      consents: donationInput.consents,
    }).filter((row) => row.status === "opt_out"),
  );

  const paymentProvider: PaymentProvider =
    donationInput.method === "alipayhk" ? "cod" : donationInput.method;
  let payment = await repository.findPaymentByIdempotencyKey(requestKey);
  if (!payment) {
    const paymentInput: PaymentInsert = {
      donation_id: donation.id,
      idempotency_key: requestKey,
      provider: paymentProvider,
      provider_ref:
        donationInput.method === "fps" ? createManualPaymentReference(donation.id) : null,
      amount_cents: donationInput.amountCents,
      status: "pending",
    };
    try {
      payment = await repository.createPayment(paymentInput);
    } catch (error) {
      payment = await repository.findPaymentByIdempotencyKey(requestKey);
      if (!payment) throw error;
    }
  }
  assertPaymentMatches(payment, donation.id, paymentProvider, donationInput.amountCents);

  if (donationInput.method === "fps") {
    const reference = createManualPaymentReference(donation.id);
    const approved = resolvePaymentInstructions(admission, {
      method: donationInput.method,
      purpose: checkoutPurpose(donationInput.purpose),
    });
    return {
      kind: "manual",
      donationId: donation.id,
      reference,
      instructions: approved
        ? {
            method: donationInput.method,
            ...approved,
            amountCents: donationInput.amountCents,
          }
        : null,
    };
  }

  const onlineProvider = paymentProvider as OnlinePaymentProvider;
  if (payment.status === "succeeded") {
    return {
      kind: "redirect",
      donationId: donation.id,
      provider: onlineProvider,
      url: "/donate?status=success&donation=" + encodeURIComponent(donation.id),
    };
  }
  if (payment.status !== "pending") throw new DonationIdempotencyConflictError();
  if (payment.checkout_url) {
    return {
      kind: "redirect",
      donationId: donation.id,
      provider: onlineProvider,
      url: payment.checkout_url,
    };
  }

  const attempt = await repository.beginCheckoutAttempt(payment.id, now().toISOString());
  if (
    (onlineProvider === "cod" && !attempt.claimed) ||
    now().getTime() - Date.parse(attempt.attemptedAt) > PROVIDER_RETRY_WINDOW_MS
  ) {
    throw new DonationCheckoutRecoveryRequiredError(donation.id);
  }
  const checkoutInput: CheckoutProviderInput = {
    donationId: donation.id,
    paymentId: payment.id,
    amountCents: donationInput.amountCents,
    donorEmail: donationInput.donor.email,
    purpose: donationInput.purpose,
    checkoutExperience: donationInput.checkoutExperience,
  };
  // PayMe is an online provider whose result carries two links: a hosted
  // PayCode page for desktop and an app deep link for mobile. The hosted page
  // is stored as checkout_url so an idempotent resubmit returns the same
  // payment request instead of minting a second PayCode.
  if (donationInput.method === "payme") {
    const paymeCheckout = await providers.createPayMeCheckout(checkoutInput);
    await repository.updatePaymentProviderRef(
      payment.id,
      paymeCheckout.providerRef,
      paymeCheckout.webLink,
    );
    return {
      kind: "payme",
      donationId: donation.id,
      paymentRequestId: paymeCheckout.providerRef,
      webLink: paymeCheckout.webLink,
      appLink: paymeCheckout.appLink,
    };
  }

  // The provider call may have succeeded even if its response or our database
  // write fails. Keep the intent/payment and retry using the same provider key.
  let checkout: CheckoutProviderResult;
  if (donationInput.method === "stripe") {
    checkout = await providers.createStripeCheckout(checkoutInput);
  } else if (donationInput.method === "paypal") {
    checkout = await providers.createPayPalOrder(checkoutInput);
  } else if (donationInput.method === "alipayhk") {
    try {
      checkout = await providers.createCodAlipayHkCheckout(checkoutInput);
    } catch (error) {
      console.error("COD checkout outcome is uncertain", error);
      throw new DonationCheckoutRecoveryRequiredError(donation.id);
    }
  } else {
    throw new Error("Unsupported online donation method: " + donationInput.method);
  }

  await repository.updatePaymentProviderRef(
    payment.id,
    checkout.providerRef,
    checkout.url,
    checkout.providerOrderRef,
  );

  return {
    kind: "redirect",
    donationId: donation.id,
    provider: onlineProvider,
    url: checkout.url,
  };
}
