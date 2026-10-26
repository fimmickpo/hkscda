import process from "node:process";

import {
  decodeBase64Strict,
  getCodCipherSuite,
  parseRsaPrivateKey,
  parseRsaPublicKey,
  type CodCipherSuite,
} from "./cod-crypto.server";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// The receipt bucket name is not a secret. Keep it separate so callers that
// only need the bucket (PDF upload/remove) don't have to load the service-role
// key — which keeps that code path testable without production secrets.
export function getReceiptBucket() {
  return process.env.SUPABASE_RECEIPT_BUCKET ?? "receipts";
}

export function getSupabaseServerConfig() {
  return {
    url: process.env.SUPABASE_URL ?? required("VITE_SUPABASE_URL"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    receiptBucket: getReceiptBucket(),
  };
}

export function getStripeConfig() {
  return {
    secretKey: required("STRIPE_SECRET_KEY"),
    webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
  };
}

export function getPayPalConfig() {
  return {
    clientId: required("PAYPAL_CLIENT_ID"),
    clientSecret: required("PAYPAL_CLIENT_SECRET"),
    apiBase: process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com",
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
  };
}

export interface CodConfig {
  environment: "sandbox" | "production";
  merchantId: string;
  segmentId: string;
  aesKey: Buffer;
  privateKey: ReturnType<typeof parseRsaPrivateKey>;
  notificationPublicKey: ReturnType<typeof parseRsaPublicKey>;
  apiBase: "https://aqs-api.sandbox-codpayment.com" | "https://aqs-api.codpayment.com";
  cipherSuite: CodCipherSuite;
}

export function getCodConfig(): CodConfig {
  const environment = required("COD_ENV");
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error("COD_ENV must be sandbox or production");
  }

  const aesKey = decodeBase64Strict(required("COD_AES_SECRET_BASE64"), "COD AES secret");
  const privateKeyPem = decodeBase64Strict(
    required("COD_PRIVATE_KEY_BASE64"),
    "COD private key",
  ).toString("utf8");
  const notificationPublicKeyPem = decodeBase64Strict(
    required("COD_NOTIFICATION_PUBLIC_KEY_BASE64"),
    "COD notification public key",
  ).toString("utf8");

  return {
    environment,
    merchantId: required("COD_MERCHANT_ID"),
    segmentId: required("COD_SEGMENT_ID"),
    aesKey,
    privateKey: parseRsaPrivateKey(privateKeyPem),
    notificationPublicKey: parseRsaPublicKey(notificationPublicKeyPem),
    apiBase:
      environment === "sandbox"
        ? "https://aqs-api.sandbox-codpayment.com"
        : "https://aqs-api.codpayment.com",
    cipherSuite: getCodCipherSuite(aesKey),
  };
}

export function getEmailConfig() {
  return {
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.DONATION_EMAIL_FROM ?? "HKSCDA <noreply@hkscda.com>",
    replyTo: process.env.DONATION_REPLY_TO ?? "info@hkscda.com",
    notificationEmail: process.env.NOTIFICATION_EMAIL ?? "info@hkscda.com",
  };
}

export function getReceiptConfig() {
  return {
    charityName: process.env.RECEIPT_CHARITY_NAME ?? "香港拯救貓狗協會有限公司",
    fileNo: process.env.RECEIPT_FILE_NO ?? "91/14493",
    signatoryName: process.env.RECEIPT_SIGNATORY_NAME ?? "HKSCDA",
  };
}

/** Only allowlisted field names may leave a failed configuration check. */
export function getCodConfigurationErrorField(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  const fields = [
    "COD_ENV",
    "COD_MERCHANT_ID",
    "COD_SEGMENT_ID",
    "COD_AES_SECRET_BASE64",
    "COD_PRIVATE_KEY_BASE64",
    "COD_NOTIFICATION_PUBLIC_KEY_BASE64",
  ];
  for (const field of fields) {
    if (message === `Missing required environment variable: ${field}`) return field;
  }
  if (message === "COD_ENV must be sandbox or production") return "COD_ENV";
  const knownErrors: Record<string, string[]> = {
    COD_AES_SECRET_BASE64: [
      "COD AES secret must be valid base64",
      "COD AES secret must be canonical base64",
      "COD AES key must be exactly 16 or 32 bytes",
    ],
    COD_PRIVATE_KEY_BASE64: [
      "COD private key must be valid base64",
      "COD private key must be canonical base64",
      "COD private key must be a valid RSA PEM",
    ],
    COD_NOTIFICATION_PUBLIC_KEY_BASE64: [
      "COD notification public key must be valid base64",
      "COD notification public key must be canonical base64",
      "COD notification public key must be a valid RSA PEM",
    ],
  };
  return (
    Object.entries(knownErrors).find(([, messages]) => messages.includes(message))?.[0] ?? null
  );
}

export interface PayMeConfig {
  apiBase: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  signingKeyId: string;
  signingKeyBase64: string;
  effectiveDuration: number;
}

export function getPayMeConfig(): PayMeConfig {
  const rawDuration = process.env.PAYME_EFFECTIVE_DURATION;
  const effectiveDuration = rawDuration ? Number(rawDuration) : 600;
  if (!Number.isInteger(effectiveDuration) || effectiveDuration < 15) {
    throw new Error("PAYME_EFFECTIVE_DURATION must be an integer >= 15");
  }
  return {
    apiBase: (process.env.PAYME_API_BASE ?? "https://sandbox.api.payme.hsbc.com.hk").replace(
      /\/+$/,
      "",
    ),
    apiVersion: process.env.PAYME_API_VERSION ?? "0.12",
    clientId: required("PAYME_CLIENT_ID"),
    clientSecret: required("PAYME_CLIENT_SECRET"),
    signingKeyId: required("PAYME_SIGNING_KEY_ID"),
    signingKeyBase64: required("PAYME_SIGNING_KEY"),
    effectiveDuration,
  };
}

/** Only allowlisted field names may leave a failed configuration check. */
export function getPayMeConfigurationErrorField(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const fields = [
    "PAYME_CLIENT_ID",
    "PAYME_CLIENT_SECRET",
    "PAYME_SIGNING_KEY_ID",
    "PAYME_SIGNING_KEY",
  ];
  for (const field of fields) {
    if (error.message === `Missing required environment variable: ${field}`) return field;
  }
  if (error.message === "PAYME_EFFECTIVE_DURATION must be an integer >= 15") {
    return "PAYME_EFFECTIVE_DURATION";
  }
  return null;
}
