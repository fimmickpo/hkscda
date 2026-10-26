import { describe, expect, test } from "bun:test";
import { createPayMeCheckout } from "./payme-provider.server";
import type { PayMeClient, PayMeCreateBody } from "./payme-client.server";
import type { PayMeConfig } from "./config.server";

const config: PayMeConfig = {
  apiBase: "https://sandbox.api.payme.hsbc.com.hk",
  apiVersion: "0.12",
  clientId: "c",
  clientSecret: "s",
  signingKeyId: "k",
  signingKeyBase64: Buffer.from("key").toString("base64"),
  effectiveDuration: 600,
};

function fakeClient(capture: (b: PayMeCreateBody) => void): PayMeClient {
  return {
    getAccessToken: async () => "tok",
    createPaymentRequest: async (body) => {
      capture(body);
      return { paymentRequestId: "pr1", webLink: "https://web", appLink: "https://app" };
    },
    getPaymentRequestStatus: async () => ({ statusCode: "PR001" }),
  };
}

describe("createPayMeCheckout", () => {
  test("builds callbacks + amount + duration and returns links", async () => {
    let captured: PayMeCreateBody | null = null;
    const result = await createPayMeCheckout(
      {
        donationId: "d1",
        paymentId: "p1",
        amountCents: 30000,
        donorEmail: "a@b.com",
        purpose: "general",
        checkoutExperience: "desktop_qr",
      },
      { client: fakeClient((b) => (captured = b)), config, appUrl: "https://app.test" },
    );
    expect(result).toEqual({ providerRef: "pr1", webLink: "https://web", appLink: "https://app" });
    expect(captured!.totalAmount).toBe(300);
    expect(captured!.currencyCode).toBe("HKD");
    expect(captured!.effectiveDuration).toBe(600);
    expect(captured!.notificationUri).toBe("https://app.test/api/webhooks/payme");
    expect(captured!.appSuccessCallback).toBe("https://app.test/donate?status=success&donation=d1");
    expect(captured!.appFailCallback).toBe("https://app.test/donate?status=cancelled&donation=d1");
    expect(captured!.merchantData.orderId).toBe("d1");
  });

  test("formats non-whole amounts to 2 decimals", async () => {
    let captured: PayMeCreateBody | null = null;
    await createPayMeCheckout(
      {
        donationId: "d2",
        paymentId: "p2",
        amountCents: 30081,
        donorEmail: "a@b.com",
        purpose: "medical",
        checkoutExperience: "wap",
      },
      { client: fakeClient((b) => (captured = b)), config, appUrl: "https://app.test" },
    );
    expect(captured!.totalAmount).toBe(300.81);
  });
});
