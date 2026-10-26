import { createFileRoute } from "@tanstack/react-router";

import {
  getPayMeConfig,
  getPayMeConfigurationErrorField,
} from "../../../lib/donations/config.server";
import {
  PayMeNotificationError,
  processPayMeNotification,
} from "../../../lib/donations/payme-webhook.server";
import { createSupabaseServiceClient } from "../../../lib/donations/supabase.server";
import { readPaymentWebhookBody } from "../../../lib/donations/webhookBody.server";
import {
  enforceRateLimit,
  getClientIp,
  retryAfterSeconds,
} from "../../../lib/security/rate-limit.server";

type HandlerDependencies = {
  enforce?: typeof enforceRateLimit;
  process?: (rawBody: string, headers: Headers) => Promise<unknown>;
  getConfig?: typeof getPayMeConfig;
  createClient?: typeof createSupabaseServiceClient;
};

const REQUEST_TARGET = "post /api/webhooks/payme";

export async function handlePayMeWebhookRequest(
  request: Request,
  {
    enforce = enforceRateLimit,
    process,
    getConfig = getPayMeConfig,
    createClient = createSupabaseServiceClient,
  }: HandlerDependencies = {},
) {
  const limit = await enforce(getClientIp(request), {
    prefix: "wh-payme",
    max: 100,
    window: "1 m",
  });
  if (!limit.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "retry-after": String(retryAfterSeconds(limit)) },
    });
  }

  const rawBody = await readPaymentWebhookBody(request);
  if (rawBody === null) return new Response("PayMe notification too large", { status: 413 });
  const headers = request.headers;

  try {
    const processNotification =
      process ??
      ((body: string, hdrs: Headers) =>
        processPayMeNotification({
          rawBody: body,
          headers: hdrs,
          requestTarget: REQUEST_TARGET,
          client: createClient(),
          config: getConfig(),
        }));
    await processNotification(rawBody, headers);
    return new Response("success");
  } catch (error) {
    if (error instanceof PayMeNotificationError) {
      return new Response("Invalid PayMe notification", { status: 400 });
    }
    console.error("PayMe notification processing failed", {
      configurationField: getPayMeConfigurationErrorField(error),
    });
    return new Response("PayMe notification processing failed", { status: 500 });
  }
}

export const Route = createFileRoute("/api/webhooks/payme")({
  server: {
    handlers: {
      POST: ({ request }) => handlePayMeWebhookRequest(request),
    },
  },
});
