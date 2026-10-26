import { getAppUrl } from "../appUrl.server";
import { getPayMeConfig, type PayMeConfig } from "./config.server";
import { createPayMeClient, type PayMeClient } from "./payme-client.server";
import type { CheckoutProviderInput } from "./service";

const purposeLabels: Record<string, string> = {
  general: "一般捐款 General donation",
  medical: "醫療基金 Medical fund",
  sponsor: "助養動物 Sponsor a pet",
};

export type PayMeCheckoutResult = { providerRef: string; webLink: string; appLink: string };

export async function createPayMeCheckout(
  input: CheckoutProviderInput,
  deps: { client?: PayMeClient; config?: PayMeConfig; appUrl?: string } = {},
): Promise<PayMeCheckoutResult> {
  const config = deps.config ?? getPayMeConfig();
  const client = deps.client ?? createPayMeClient({ config });
  const appUrl = deps.appUrl ?? getAppUrl();

  const response = await client.createPaymentRequest({
    totalAmount: Number((input.amountCents / 100).toFixed(2)),
    currencyCode: "HKD",
    effectiveDuration: config.effectiveDuration,
    notificationUri: `${appUrl}/api/webhooks/payme`,
    appSuccessCallback: `${appUrl}/donate?status=success&donation=${input.donationId}`,
    appFailCallback: `${appUrl}/donate?status=cancelled&donation=${input.donationId}`,
    merchantData: {
      orderId: input.donationId,
      orderDescription: `HKSCDA donation — ${purposeLabels[input.purpose] ?? "donation"}`,
    },
  });

  return {
    providerRef: response.paymentRequestId,
    webLink: response.webLink,
    appLink: response.appLink,
  };
}
