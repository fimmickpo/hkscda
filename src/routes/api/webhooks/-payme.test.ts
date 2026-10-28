import { describe, expect, test } from "bun:test";
import { handlePayMeWebhookRequest } from "./payme";
import { PayMeNotificationError } from "../../../lib/donations/payme-webhook.server";

const okLimit = async () => ({ ok: true }) as never;

function req(body: string) {
  return new Request("https://app.test/api/webhooks/payme", { method: "POST", body });
}

describe("handlePayMeWebhookRequest", () => {
  test("429 when rate limited", async () => {
    const res = await handlePayMeWebhookRequest(req("{}"), {
      enforce: async () => ({ ok: false, reset: Date.now() + 1000 }) as never,
      process: async () => ({}),
    });
    expect(res.status).toBe(429);
  });

  test("200 on a processed event", async () => {
    const res = await handlePayMeWebhookRequest(req(JSON.stringify({ paymentRequestId: "pr1" })), {
      enforce: okLimit,
      process: async () => ({ kind: "applied" }),
    });
    expect(res.status).toBe(200);
  });

  test("400 on a PayMeNotificationError", async () => {
    const res = await handlePayMeWebhookRequest(req("{}"), {
      enforce: okLimit,
      process: async () => {
        throw new PayMeNotificationError("bad signature");
      },
    });
    expect(res.status).toBe(400);
  });

  test("500 on an unexpected error", async () => {
    const res = await handlePayMeWebhookRequest(req("{}"), {
      enforce: okLimit,
      process: async () => {
        throw new Error("db down");
      },
    });
    expect(res.status).toBe(500);
  });
});
