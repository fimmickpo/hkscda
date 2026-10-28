import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { DocumentSlot } from "@/lib/documents/types";
import type { PublicPaymentMethod } from "@/lib/paymentPublicConfig/types";
import { donationSubmitFailureMessage } from "../components/site/donationSubmitFailureCopy";
import { discardCheckoutIntent, selectCheckoutIntent } from "../lib/donations/checkoutIntent";

const ALL_METHODS: PublicPaymentMethod[] = [
  { method: "stripe", displayLabelZh: "信用卡", displayLabelEn: "Card", details: {} },
  { method: "alipayhk", displayLabelZh: "AlipayHK", displayLabelEn: "AlipayHK", details: {} },
  { method: "fps", displayLabelZh: "轉數快 FPS", displayLabelEn: "FPS", details: {} },
  { method: "payme", displayLabelZh: "PayMe", displayLabelEn: "PayMe", details: {} },
  { method: "paypal", displayLabelZh: "PayPal", displayLabelEn: "PayPal", details: {} },
];

function weddingSlot(language: "zh-HK" | "en", fileUrl: string): DocumentSlot {
  return {
    id:
      language === "zh-HK"
        ? "11111111-1111-4111-8111-111111111111"
        : "22222222-2222-4222-8222-222222222222",
    slotKey: "wedding_gift_return_plan",
    language,
    isPublished: true,
    document: {
      id:
        language === "zh-HK"
          ? "33333333-3333-4333-8333-333333333333"
          : "44444444-4444-4444-8444-444444444444",
      kind: "wedding_form",
      title: language === "zh-HK" ? "婚宴回禮計劃表格" : "Wedding donation form",
      language,
      bucketName: "site-documents",
      objectPath: `wedding-forms/${language}.pdf`,
      fileUrl,
      mimeType: "application/pdf",
      byteSize: 1000,
      checksumSha256: null,
      isPublished: true,
      sortOrder: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  };
}

test("renders the optional purpose note and language-aware wedding forms", async () => {
  const { DonatePage } = await import("./donate");
  const zhWedding = weddingSlot("zh-HK", "https://documents.example/wedding-zh.pdf");
  const enWedding = weddingSlot("en", "https://documents.example/wedding-en.pdf");

  const html = renderToStaticMarkup(
    <DonatePage
      initialSlots={[zhWedding, enWedding]}
      initialMethods={ALL_METHODS}
      initialSearch={{ purpose: "medical" }}
    />,
  );

  expect(html).toContain("其他捐款用途（婚宴／活動／粉絲籌款 等）");
  expect(html).toContain('name="customPurpose"');
  expect(html).toMatch(/aria-pressed="true"[^>]*>醫療基金/);
  expect(html).toContain("💍 Share the Love – 婚宴回禮計劃");
  expect(html).toContain(
    "以婚禮分享愛心，賓客祝福化作救援能量。填寫表格，我們會與您聯絡安排感謝證書及小卡。",
  );
  expect(html).toContain('href="https://documents.example/wedding-zh.pdf"');
  expect(html).toContain("下載表格 / Download Form");
  expect(html).toContain('href="https://documents.example/wedding-en.pdf"');
  expect(html).toContain("English form");
  const externalLinks = html.match(/target="_blank"/g) ?? [];
  for (const href of [
    "https://documents.example/wedding-zh.pdf",
    "https://documents.example/wedding-en.pdf",
  ]) {
    expect(html).toContain(`href="${href}"`);
  }
  // Every new-tab link must carry the opener guard.
  expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(externalLinks.length);

  const singleLanguageHtml = renderToStaticMarkup(
    <DonatePage initialSlots={[enWedding]} initialMethods={ALL_METHODS} initialSearch={{}} />,
  );
  expect(singleLanguageHtml).toContain('href="https://documents.example/wedding-en.pdf"');
  expect(singleLanguageHtml).not.toContain("表格暫時未能提供。");
});

test("keeps the donation page available when optional documents fail to load", async () => {
  const { loadDonationDocumentSlots } = await import("../lib/documents/donation.server");
  let requestedSlotKeys: string[] = [];

  const slots = await loadDonationDocumentSlots(async (slotKeys) => {
    requestedSlotKeys = slotKeys;
    throw new Error("document store unavailable");
  });

  expect(requestedSlotKeys).toEqual(["wedding_gift_return_plan"]);
  expect(slots).toEqual([]);
});

describe("AlipayHK donation checkout", () => {
  test("reconciles checkout selection to the first published payment method", async () => {
    const { isDonationMethodAvailable, reconcileDonationMethod } = await import("./donate");
    const paypalOnly = ALL_METHODS.filter((entry) => entry.method === "paypal");

    expect(reconcileDonationMethod("stripe", paypalOnly)).toBe("paypal");
    expect(reconcileDonationMethod("paypal", paypalOnly)).toBe("paypal");
    expect(reconcileDonationMethod("stripe", [])).toBeNull();
    expect(isDonationMethodAvailable("stripe", paypalOnly)).toBe(false);
    expect(isDonationMethodAvailable("paypal", paypalOnly)).toBe(true);
    expect(isDonationMethodAvailable(null, paypalOnly)).toBe(false);
  });

  test("keeps every provider hidden until the production activation gate is approved", async () => {
    const { DonatePage } = await import("./donate");

    const html = renderToStaticMarkup(
      <DonatePage initialSlots={[]} initialMethods={ALL_METHODS} initialSearch={{}} />,
    );

    expect(html).toContain("網上捐款尚未啟用");
    expect(html).toContain("付款服務完成正式審批後");
    expect(html).not.toContain(">信用卡<");
    expect(html).not.toContain(">PayPal<");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  test("selects PayPal when it is the only published method", async () => {
    const { DonatePage } = await import("./donate");
    const html = renderToStaticMarkup(
      <DonatePage
        initialSlots={[]}
        initialMethods={ALL_METHODS.filter((entry) => entry.method === "paypal")}
        initialSearch={{}}
        checkoutEnabled
      />,
    );

    expect(html).toMatch(/aria-pressed="true"[^>]*>.*PayPal/s);
    expect(html).not.toContain(">信用卡<");
  });

  test("renders Card and AlipayHK as separate payment methods", async () => {
    const { DonatePage } = await import("./donate");

    const html = renderToStaticMarkup(
      <DonatePage
        initialSlots={[]}
        initialMethods={ALL_METHODS}
        initialSearch={{}}
        checkoutEnabled
      />,
    );

    expect(html).toContain(">信用卡<");
    expect(html).not.toContain("信用卡 / Alipay");
    expect(html).toContain("AlipayHK");
    expect(html).toContain("轉數快 FPS");
    expect(html).toContain("PayMe");
    expect(html).toContain("PayPal");
  });

  test("renders no method buttons when the config-driven list is empty", async () => {
    const { DonatePage } = await import("./donate");

    // checkoutEnabled is true here so this exercises the "checkout is on but
    // no methods are published yet" branch, not the checkout-disabled notice.
    const html = renderToStaticMarkup(
      <DonatePage initialSlots={[]} initialMethods={[]} initialSearch={{}} checkoutEnabled />,
    );

    expect(html).toContain("付款服務完成正式審批後");
    expect(html).not.toContain(">信用卡<");
    expect(html).not.toContain(">AlipayHK<");
    expect(html).not.toContain(">轉數快 FPS<");
    expect(html).not.toContain(">PayMe<");
    expect(html).not.toContain(">PayPal<");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  test("renders a method button per configured method, in the given order", async () => {
    const { DonatePage } = await import("./donate");

    const html = renderToStaticMarkup(
      <DonatePage
        initialSlots={[]}
        initialMethods={[
          { method: "fps", displayLabelZh: "轉數快 FPS", displayLabelEn: "FPS", details: {} },
          { method: "stripe", displayLabelZh: "信用卡", displayLabelEn: "Card", details: {} },
        ]}
        initialSearch={{}}
        checkoutEnabled
      />,
    );

    expect(html).toContain(">轉數快 FPS<");
    expect(html).toContain(">信用卡<");
    expect(html.indexOf("轉數快 FPS")).toBeLessThan(html.indexOf("信用卡"));
    expect(html).not.toContain("AlipayHK");
    expect(html).not.toContain("PayMe");
    expect(html).not.toContain("PayPal");
  });

  test("builds an AlipayHK request with the checkout experience", async () => {
    const { createDonationRequest } = await import("./donate");

    expect(
      createDonationRequest({
        idempotencyKey: "e15e9832-469b-4710-b2ea-244d8a39aa12",
        amountCents: 30_000,
        expectedConfigVersion: 1,
        purpose: "general",
        customPurpose: "",
        method: "alipayhk",
        checkoutExperience: "wap",
        receiptRequested: true,
        donor: {
          name: "Test Donor",
          email: "donor@example.com",
          phone: "",
          language: "zh-HK",
        },
        consents: { email: true, whatsapp: false },
        turnstileToken: null,
      }),
    ).toMatchObject({ method: "alipayhk", checkoutExperience: "wap" });
  });

  test("treats a COD pending return as waiting, not as a confirmed donation", async () => {
    const { DonatePage, donationStatusMessage } = await import("./donate");

    expect(donationStatusMessage("pending", "zh-HK")).toContain("確認");
    expect(donationStatusMessage("pending", "zh-HK")).not.toContain("多謝您的支持");

    const html = renderToStaticMarkup(
      <DonatePage
        initialSlots={[]}
        initialMethods={ALL_METHODS}
        initialSearch={{ donation: "11111111-1111-4111-8111-111111111111", status: "pending" }}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("正在等待付款確認");
  });

  test("records success only after a COD pending return is confirmed by the status poll", async () => {
    const { resolveDonationReturn } = await import("./donate");
    const trackedEvents: unknown[][] = [];
    let pollCalls = 0;

    const state = await resolveDonationReturn(
      "11111111-1111-4111-8111-111111111111",
      {
        context: "general",
        purpose: "general",
        method: "alipayhk",
        value: 300,
        currency: "HKD",
      },
      {
        pollDonationStatus: async () => {
          pollCalls += 1;
          return true;
        },
        markDonationEvent: () => true,
        trackDonationEvent: (...args) => trackedEvents.push(args),
      },
    );

    expect(state).toBe("confirmed");
    expect(pollCalls).toBe(1);
    expect(trackedEvents).toEqual([
      [
        "donation_success",
        {
          context: "general",
          purpose: "general",
          method: "alipayhk",
          value: 300,
          currency: "HKD",
        },
      ],
    ]);
  });

  test("forwards cancellation to the donation status poll", async () => {
    const { resolveDonationReturn } = await import("./donate");
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await resolveDonationReturn("11111111-1111-4111-8111-111111111111", undefined, {
      signal: controller.signal,
      pollDonationStatus: async (_donationId, options) => {
        receivedSignal = options?.signal;
        return false;
      },
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("does not record success when a COD pending return remains pending after polling", async () => {
    const { resolveDonationReturn } = await import("./donate");
    const trackedEvents: unknown[][] = [];

    const state = await resolveDonationReturn(
      "11111111-1111-4111-8111-111111111111",
      {
        context: "general",
        purpose: "general",
        method: "alipayhk",
        value: 300,
        currency: "HKD",
      },
      {
        pollDonationStatus: async () => false,
        markDonationEvent: () => true,
        trackDonationEvent: (...args) => trackedEvents.push(args),
      },
    );

    expect(state).toBe("unavailable");
    expect(trackedEvents).toEqual([]);
  });
});

test("uses the shared public-container class, not the pre-port container-wide utility", async () => {
  const { DonatePage } = await import("./donate");

  const html = renderToStaticMarkup(
    <DonatePage initialSlots={[]} initialMethods={ALL_METHODS} initialSearch={{}} />,
  );

  expect(html).toContain("public-container");
  expect(html).not.toContain("container-wide");
});

test("donation contacts use the donation inbox without WhatsApp options", async () => {
  const { DonatePage, createDonationRequest } = await import("./donate");
  for (const checkoutEnabled of [false, true]) {
    const html = renderToStaticMarkup(
      <DonatePage
        initialSlots={[]}
        initialMethods={ALL_METHODS}
        initialSearch={{}}
        checkoutEnabled={checkoutEnabled}
      />,
    );
    expect(html).toContain('href="mailto:donation@hkscda.com"');
    expect(html).toContain("HK SAVING CAT AND DOG ASSOCIATION LIMITED");
    expect(html).not.toContain("info@hkscda.com");
    expect(html).not.toContain("WhatsApp");
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("donation-whatsapp-consent");
  }
  const payload = createDonationRequest({
    idempotencyKey: "9d6b79b5-5a2b-4b76-8a93-c2e6cf1a7d0a",
    amountCents: 30000,
    expectedConfigVersion: 1,
    purpose: "general",
    customPurpose: "",
    method: "stripe",
    checkoutExperience: "desktop_qr",
    receiptRequested: true,
    donor: { name: "Test", email: "test@example.com", phone: "", language: "zh-HK" },
    consents: { email: true, whatsapp: true },
    turnstileToken: null,
  });
  expect(payload.consents).toEqual({ email: true, whatsapp: false });
});

test("the consent legend follows the page language", async () => {
  const { DonatePage } = await import("./donate");

  const html = renderToStaticMarkup(
    <DonatePage initialSlots={[]} initialMethods={[]} initialSearch={{}} />,
  );

  expect(html).toContain("收據及通訊同意");
  expect(html).not.toContain("Receipts and communication consent");
});

// bun test is not a development build. The flag is set or cleared here, so what the developer has in
// .env.local cannot change the result.
async function renderCustomAmountField(allowCentsFlag?: string) {
  const { DonatePage } = await import("./donate");
  const previous = process.env.VITE_PUBLIC_ALLOW_CENT_AMOUNTS;
  if (allowCentsFlag === undefined) delete process.env.VITE_PUBLIC_ALLOW_CENT_AMOUNTS;
  else process.env.VITE_PUBLIC_ALLOW_CENT_AMOUNTS = allowCentsFlag;
  try {
    const html = renderToStaticMarkup(
      <DonatePage
        initialSlots={[]}
        initialMethods={ALL_METHODS}
        initialSearch={{}}
        checkoutEnabled
      />,
    );
    return html.match(/<input[^>]*id="donation-custom-amount"[^>]*>/)?.[0] ?? "";
  } finally {
    if (previous === undefined) delete process.env.VITE_PUBLIC_ALLOW_CENT_AMOUNTS;
    else process.env.VITE_PUBLIC_ALLOW_CENT_AMOUNTS = previous;
  }
}

describe("the custom amount field", () => {
  test("takes whole dollars from HK$10 unless the build allows cents", async () => {
    const field = await renderCustomAmountField();

    expect(field).toContain('type="number"');
    expect(field).toContain('min="10"');
    expect(field).toContain('step="1"');
  });

  test("takes cents in a build that sets VITE_PUBLIC_ALLOW_CENT_AMOUNTS to true", async () => {
    const field = await renderCustomAmountField("true");

    expect(field).toContain('min="10"');
    expect(field).toContain('step="0.01"');
  });

  test("keeps whole dollars when the flag is anything but true", async () => {
    expect(await renderCustomAmountField("false")).toContain('step="1"');
  });
});

describe("a refused donation submission", () => {
  type Answer = { status: number; body?: { error?: string; code?: string; donationId?: string } };

  // Runs the production handleSubmit with the answer the server gives and records every state
  // setter it calls. Reading the function out of donate.tsx keeps this on the real code, as
  // turnstileCallerRecovery.test.ts does for the path where the request throws.
  async function submitAnswered(answer: Answer, language: "zh-HK" | "en" = "zh-HK") {
    const path = fileURLToPath(new URL("./donate.tsx", import.meta.url));
    const ast = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let callback = "";
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "handleSubmit")
        callback = node.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(callback).not.toBe("");
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(callback);
    const calls: Array<[string, unknown]> = [];
    const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const scope: Record<string, unknown> = {
      checkoutEnabled: true,
      turnstileEnabled: true,
      turnstileToken: "synthetic-token",
      amountHkd: 100,
      language,
      method: "stripe",
      availableMethods: [{ method: "stripe", configVersion: 1 }],
      isDonationMethodAvailable: () => true,
      checkoutExperienceFromViewport: () => "desktop_qr",
      createDonationRequest: (value: unknown) => value,
      donationSubmitFailureMessage,
      fetch: async () => new Response(JSON.stringify(answer.body ?? {}), { status: answer.status }),
      t: {
        submitError: "generic",
        checkoutRecoveryRequired: "recovery",
        recoveryReference: "reference",
      },
      window: {
        innerWidth: 1024,
        crypto: {
          randomUUID: () => "11111111-2222-4333-8444-555555555555",
          subtle: { digest: async () => new Uint8Array(32).buffer },
        },
        sessionStorage,
      },
      checkoutIntentRef: { current: null },
      selectCheckoutIntent,
      discardCheckoutIntent,
      browserCheckoutIntentStorage: () => sessionStorage,
      TextEncoder,
      Uint8Array,
      Array,
      console: { error: () => {} },
      Number,
      JSON,
      Error,
      Math,
    };
    const context = new Proxy(scope, {
      has: () => true,
      get(target, key) {
        if (key === Symbol.unscopables) return undefined;
        if (typeof key === "string" && key.startsWith("set"))
          return (value: unknown) =>
            calls.push([key, typeof value === "function" ? value(0) : value]);
        return target[key as string];
      },
    });
    const run = new Function("scope", `with(scope) { ${compiled}; return handleSubmit; }`)(context);
    await run({ preventDefault() {} });
    return {
      calls,
      shown: calls.filter(([setter]) => setter === "setError").at(-1)?.[1] as string | null,
    };
  }

  const refusals: Array<[string, Answer]> = [
    ["a verification that did not pass", { status: 403, body: { error: "Verification failed" } }],
    ["too many requests", { status: 429, body: { error: "Too many requests." } }],
    ["a service that cannot count requests", { status: 503, body: { error: "Unavailable" } }],
    [
      "a payment method that is off",
      { status: 422, body: { error: "Checkout is not available.", code: "method_unavailable" } },
    ],
  ];

  test.each(refusals)(
    "tells the donor about %s, in the language they use",
    async (_name, answer) => {
      for (const language of ["zh-HK", "en"] as const) {
        const { shown } = await submitAnswered(answer, language);

        expect(shown).toBe(
          donationSubmitFailureMessage(language, answer.status, answer.body?.code),
        );
        expect(shown).not.toBe("generic");
        expect(/[一-鿿]/.test(shown ?? "")).toBe(language === "zh-HK");
      }
    },
  );

  test("tells the four refusals apart", async () => {
    const shown = new Set<string | null>();
    for (const [, answer] of refusals) shown.add((await submitAnswered(answer)).shown);

    expect(shown.size).toBe(refusals.length);
  });

  test.each(refusals)(
    "gets the verification widget a fresh token after %s",
    async (_name, answer) => {
      const { calls } = await submitAnswered(answer);

      expect(calls).toContainEqual(["setTurnstileToken", null]);
      expect(calls).toContainEqual(["setTurnstileResetKey", 1]);
      expect(calls).toContainEqual(["setLoading", false]);
    },
  );

  test("keeps the generic message for an error the donor cannot act on", async () => {
    for (const answer of [
      { status: 500, body: { error: "Donation could not be created" } },
      { status: 400, body: { error: "Invalid donation request" } },
      { status: 409, body: { error: "Donation request conflicts with an existing intent" } },
    ] satisfies Answer[]) {
      const { calls, shown } = await submitAnswered(answer);

      expect(shown).toBe("generic");
      expect(calls).toContainEqual(["setTurnstileResetKey", 1]);
    }
  });

  test("still answers a checkout it cannot confirm with the recovery message", async () => {
    const { shown } = await submitAnswered({
      status: 409,
      body: { code: "checkout_recovery_required", donationId: "donation-1" },
    });

    expect(shown).toBe("recovery reference: donation-1");
  });
});

test("mobile payme response redirects to appLink (checkoutExperience is wap below 768px)", async () => {
  // checkoutExperienceFromViewport drives the mobile/desktop branch in handleSubmit
  // (see checkoutDestination): when innerWidth < 768 the experience is "wap" and PayMe opens
  // through the app link; otherwise the donor goes to the PayCode page. Verify the viewport
  // threshold matches the spec.
  const { checkoutExperienceFromViewport } = await import("../lib/donations/checkoutExperience");

  // Any width below 768 must produce "wap" (the branch that sets location.href = appLink).
  expect(checkoutExperienceFromViewport(375)).toBe("wap");
  expect(checkoutExperienceFromViewport(767)).toBe("wap");

  // Any width at or above 768 must produce "desktop_qr" (the PayCode page branch).
  expect(checkoutExperienceFromViewport(768)).toBe("desktop_qr");
  expect(checkoutExperienceFromViewport(1440)).toBe("desktop_qr");
});
