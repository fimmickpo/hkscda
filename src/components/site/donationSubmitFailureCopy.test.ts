import { describe, expect, test } from "bun:test";

import {
  donationSubmitFailureCopy,
  donationSubmitFailureMessage,
} from "./donationSubmitFailureCopy";

describe("donationSubmitFailureMessage", () => {
  test("has a message for each refusal in each language, and none for the rest", () => {
    for (const language of ["zh-HK", "en"] as const) {
      const messages = [
        donationSubmitFailureMessage(language, 403),
        donationSubmitFailureMessage(language, 429),
        donationSubmitFailureMessage(language, 503),
        donationSubmitFailureMessage(language, 422, "method_unavailable"),
      ];

      expect(messages.every((message) => typeof message === "string" && message.length > 0)).toBe(
        true,
      );
      expect(new Set(messages).size).toBe(messages.length);
      expect(donationSubmitFailureMessage(language, 500)).toBeNull();
      expect(donationSubmitFailureMessage(language, 400)).toBeNull();
    }
  });

  test("speaks the donor's language", () => {
    const hasChinese = (text: string) => /[一-鿿]/.test(text);

    for (const message of Object.values(donationSubmitFailureCopy["zh-HK"])) {
      expect(hasChinese(message)).toBe(true);
    }
    for (const message of Object.values(donationSubmitFailureCopy.en)) {
      expect(hasChinese(message)).toBe(false);
    }
  });

  test("the two languages explain the same refusals", () => {
    expect(Object.keys(donationSubmitFailureCopy["zh-HK"]).sort()).toEqual(
      Object.keys(donationSubmitFailureCopy.en).sort(),
    );
  });

  // The donation form's fixed copy ends its sentences with the language's own full stop.
  test("ends each message as a sentence", () => {
    for (const message of Object.values(donationSubmitFailureCopy["zh-HK"])) {
      expect(message.endsWith("。")).toBe(true);
    }
    for (const message of Object.values(donationSubmitFailureCopy.en)) {
      expect(message.endsWith(".")).toBe(true);
    }
  });
});
