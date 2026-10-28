import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { brand } from "../../lib/brand/brand";
import type { PayCodeLanguage, PayCodeScreen } from "../../lib/donations/payme-paycode";
import { PayMePayCodeView } from "./PayMePayCodePage";
import { payCodeCopy } from "./payMePayCodeCopy";

const ID = "11111111-1111-4111-8111-111111111111";
const WEB_LINK = "https://payme.example/pay/pr1";

function render(
  screen: PayCodeScreen,
  extra: Partial<Parameters<typeof PayMePayCodeView>[0]> = {},
  language: PayCodeLanguage = "zh-HK",
) {
  return renderToStaticMarkup(
    <PayMePayCodeView
      screen={screen}
      language={language}
      donationId={ID}
      webLink={WEB_LINK}
      amountCents={30000}
      cancel="idle"
      onCancel={() => {}}
      {...extra}
    />,
  );
}

const SCREENS: PayCodeScreen[] = [
  { kind: "loading" },
  { kind: "unavailable" },
  { kind: "scan", remainingMs: 581_000 },
  { kind: "processing" },
  { kind: "confirming" },
  { kind: "paid" },
  { kind: "ended" },
  { kind: "expired" },
  { kind: "unconfirmed" },
  { kind: "cancelled" },
];

describe("PayMePayCodeView scan screen", () => {
  test("shows the QR code, the amount and the time left, with a way to cancel", () => {
    const html = render({ kind: "scan", remainingMs: 581_000 });

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="PayMe PayCode QR 碼"');
    expect(html).toContain("HK$300");
    expect(html).toContain("PayCode 有效時間");
    expect(html).toContain("<time>09:41</time>");
    expect(html).toContain("正在等待付款確認");
    expect(html).toContain(">取消付款<");
    expect(html).toContain("此為私人付款頁面，請勿轉發。");
  });

  test("speaks English when the donor used English", () => {
    const html = render({ kind: "scan", remainingMs: 581_000 }, {}, "en");

    expect(html).toContain("Pay with PayMe");
    expect(html).toContain("Donation amount");
    expect(html).toContain("PayCode valid for");
    expect(html).toContain(">Cancel payment<");
    expect(html).toContain("PayMe PayCode QR code");
  });

  test("the QR code encodes the PayCode link the server gave, and only that", () => {
    const a = render({ kind: "scan", remainingMs: 1_000 });
    const b = render({ kind: "scan", remainingMs: 1_000 }, { webLink: WEB_LINK + "2" });

    expect(a).not.toBe(b);
    // The link itself is data inside the drawing, never printed or linked as text.
    expect(a).not.toContain(WEB_LINK);
  });

  test("says so, rather than showing an empty box, when the link cannot be drawn", () => {
    const html = render({ kind: "scan", remainingMs: 1_000 }, { webLink: "x".repeat(5000) });

    expect(html).not.toContain('role="img"');
    expect(html).toContain(payCodeCopy["zh-HK"].qrUnavailable);
  });

  test("draws no code before the link has arrived", () => {
    expect(render({ kind: "scan", remainingMs: 1_000 }, { webLink: null })).not.toContain(
      'role="img"',
    );
  });

  test("while cancelling, the button is disabled and says so", () => {
    const html = render({ kind: "scan", remainingMs: 1_000 }, { cancel: "cancelling" });

    expect(html).toContain("disabled");
    expect(html).toContain("正在取消");
  });

  test("a failed cancel tells the donor the PayCode is still live", () => {
    const html = render({ kind: "scan", remainingMs: 1_000 }, { cancel: "failed" });

    expect(html).toContain(payCodeCopy["zh-HK"].cancelFailed);
    expect(html).toContain('role="alert"');
  });

  test("fits a narrow window and keeps the private-page note off the cancel button's line", () => {
    const html = render({ kind: "scan", remainingMs: 581_000 });

    // A fixed 16rem box overflowed the card on a 320px window.
    expect(html).toContain("aspect-square w-full max-w-64");
    expect(html).not.toMatch(/\sw-64\s/);
    // The note is an inline pill: without a block of its own it sat beside the button and read as a
    // second button.
    expect(html).toMatch(/<\/button><div><p class="trust-cue[^"]*">此為私人付款頁面/);
  });
});

describe("PayMePayCodeView other screens", () => {
  test("only the scan screen shows the code or a cancel button", () => {
    for (const screen of SCREENS.filter((s) => s.kind !== "scan")) {
      const html = render(screen);
      expect(html).not.toContain('role="img"');
      expect(html).not.toContain(">取消付款<");
    }
  });

  test("a payment in progress asks the donor to wait and not to pay again", () => {
    const html = render({ kind: "processing" });
    expect(html).toContain("付款正在處理中");
    expect(html).toContain("請勿重複付款");
  });

  test("an expired PayCode is hidden while the page checks whether a payment came in", () => {
    const html = render({ kind: "confirming" });
    expect(html).toContain("PayCode 已過期");
    expect(html).toContain("正在核對是否已收到付款");
  });

  test("a confirmed payment moves on to the donation page's confirmation", () => {
    const html = render({ kind: "paid" });
    expect(html).toContain("付款已確認，多謝支持！");
    expect(html).toContain(`href="/donate?status=success&amp;donation=${ID}"`);
  });

  test("an expired or declined payment goes back to the form with a fresh start", () => {
    for (const kind of ["expired", "ended"] as const) {
      const html = render({ kind });
      expect(html).toContain(`href="/donate?status=cancelled&amp;donation=${ID}"`);
      expect(html).toContain("返回捐款表格");
    }
    expect(render({ kind: "expired" })).toContain("這個 PayCode 已不能掃描");
    expect(render({ kind: "ended" })).toContain("付款未完成");
  });

  test("when the status cannot be confirmed it says so, and never invites another payment", () => {
    const html = render({ kind: "unconfirmed" });

    expect(html).toContain("暫時未能確認付款狀態");
    expect(html).toContain("請勿重複付款");
    expect(html).toContain(ID);
    expect(html).toContain(`href="mailto:${brand.org.donationEmail}"`);
    // Back to the plain form: the saved checkout is kept, so the same details cannot start a second payment.
    expect(html).toContain('href="/donate"');
    expect(html).not.toContain("status=cancelled");
  });

  test("a cancelled payment heads back to the form", () => {
    const html = render({ kind: "cancelled" });
    expect(html).toContain("已取消付款");
    expect(html).toContain(`href="/donate?status=cancelled&amp;donation=${ID}"`);
  });

  test("a PayCode that could not be loaded points back to the form", () => {
    const html = render({ kind: "unavailable" });
    expect(html).toContain("暫時未能載入付款頁面");
    expect(html).toContain('href="/donate"');
  });
});

describe("PayMePayCodeView every screen", () => {
  test("has exactly one h1, in both languages", () => {
    for (const language of ["zh-HK", "en"] as const) {
      for (const screen of SCREENS) {
        const html = render(screen, {}, language);
        expect(html.match(/<h1/g)).toHaveLength(1);
      }
    }
  });

  test("uses theme tokens only, no hard-coded colours", () => {
    for (const screen of SCREENS) {
      expect(render(screen)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  test("never leaks the PayCode link as readable text or into a link", () => {
    for (const screen of SCREENS) {
      expect(render(screen)).not.toContain("payme.example");
    }
  });
});

describe("payCodeCopy", () => {
  test("has the same wording slots in both languages, none empty", () => {
    expect(Object.keys(payCodeCopy.en).sort()).toEqual(Object.keys(payCodeCopy["zh-HK"]).sort());
    for (const language of ["zh-HK", "en"] as const) {
      for (const text of Object.values(payCodeCopy[language])) {
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
