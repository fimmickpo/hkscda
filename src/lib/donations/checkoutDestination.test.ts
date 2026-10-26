import { describe, expect, test } from "bun:test";

import { checkoutDestination } from "./checkoutDestination";

const ID = "11111111-1111-4111-8111-111111111111";
const payme = { kind: "payme", donationId: ID, appLink: "payme://pay/pr1" } as const;

describe("checkoutDestination", () => {
  test("a PayMe checkout on a desktop goes to the PayCode page, which draws the QR code", () => {
    expect(checkoutDestination(payme, "desktop_qr")).toBe(`/donate/payme/${ID}`);
  });

  test("a PayMe checkout on a phone opens the PayMe app through the app link", () => {
    expect(checkoutDestination(payme, "wap")).toBe("payme://pay/pr1");
  });

  test("a PayMe checkout resubmitted while its PayCode is payable returns to the PayCode page on a desktop", () => {
    const resubmitted = {
      kind: "redirect",
      donationId: ID,
      provider: "payme",
      url: "https://payme.example/pay/pr1",
    } as const;

    expect(checkoutDestination(resubmitted, "desktop_qr")).toBe(`/donate/payme/${ID}`);
    // On a phone the stored web link is still the best way into the app.
    expect(checkoutDestination(resubmitted, "wap")).toBe("https://payme.example/pay/pr1");
  });

  test("other providers redirect to their own checkout on every device", () => {
    for (const provider of ["stripe", "paypal", "cod"]) {
      const redirect = {
        kind: "redirect",
        donationId: ID,
        provider,
        url: `https://${provider}.example/checkout`,
      } as const;

      expect(checkoutDestination(redirect, "desktop_qr")).toBe(redirect.url);
      expect(checkoutDestination(redirect, "wap")).toBe(redirect.url);
    }
  });

  test("encodes the donation id into the PayCode page address", () => {
    expect(checkoutDestination({ ...payme, donationId: "a b/c" }, "desktop_qr")).toBe(
      "/donate/payme/a%20b%2Fc",
    );
  });
});
