import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentSlot } from "@/lib/documents/types";
import type { PublicPaymentMethod } from "@/lib/paymentPublicConfig/types";

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

test("desktop payme response opens the PayCode modal with an open-in-new-tab link", async () => {
  // Render the PayMePayCodeModal directly — this is exactly what DonatePage renders when it
  // receives a kind:"payme" response on a desktop viewport (checkoutExperience !== "wap").
  // PayMe's hosted PayCode page cannot be framed, so the modal opens webLink in a NEW TAB
  // (an anchor with target="_blank") instead of embedding an <iframe>.
  const { PayMePayCodeModal } = await import("../components/site/PayMePayCodeModal");

  const html = renderToStaticMarkup(
    <PayMePayCodeModal
      webLink="https://web"
      amountLabel="HK$300"
      status="waiting"
      language="zh-HK"
      onClose={() => {}}
    />,
  );

  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  // No iframe — the blocked-in-frame page is opened in a new tab instead.
  expect(html).not.toContain("<iframe");
  // The primary CTA is an open-in-new-tab link pointing at the webLink from the API response.
  expect(html).toContain('href="https://web"');
  expect(html).toContain('target="_blank"');
  // Status line is present and live so polling can surface success/failure.
  expect(html).toContain('role="status"');
});

test("mobile payme response redirects to appLink (checkoutExperience is wap below 768px)", async () => {
  // checkoutExperienceFromViewport drives the mobile/desktop branch in handleSubmit:
  // when innerWidth < 768 the experience is "wap" and the code does
  //   window.location.href = data.appLink; return;
  // instead of opening the modal. Verify the viewport threshold matches the spec.
  const { checkoutExperienceFromViewport } = await import("../lib/donations/checkoutExperience");

  // Any width below 768 must produce "wap" (the branch that sets location.href = appLink).
  expect(checkoutExperienceFromViewport(375)).toBe("wap");
  expect(checkoutExperienceFromViewport(767)).toBe("wap");

  // Any width at or above 768 must produce "desktop_qr" (the modal branch).
  expect(checkoutExperienceFromViewport(768)).toBe("desktop_qr");
  expect(checkoutExperienceFromViewport(1440)).toBe("desktop_qr");
});
