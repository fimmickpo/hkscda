import {
  classifyDonationSubmitFailure,
  type DonationSubmitFailure,
} from "../../lib/donations/submitFailure";

type Language = "zh-HK" | "en";

// One Record per language, so a message added to one language and not the other fails to compile.
// "unknown" has none: the form keeps its generic submitError for it.
export const donationSubmitFailureCopy = {
  "zh-HK": {
    verification: "人機驗證未通過。請重新完成驗證後再試。",
    rate_limited: "短時間內提交次數過多。請稍候一分鐘後再試。",
    busy: "系統暫時繁忙，未能接收這次提交。請稍後再試。",
    checkout_unavailable:
      "這個付款方式暫時未能使用，或剛剛有更新。請重新整理頁面後再試，或聯絡職員。",
  },
  en: {
    verification: "The verification did not pass. Please complete it again and try once more.",
    rate_limited: "Too many attempts in a short time. Please wait a minute and try again.",
    busy: "The service is busy and could not take this submission. Please try again later.",
    checkout_unavailable:
      "This payment method is not available right now, or it was just updated. Please refresh the page and try again, or contact our team.",
  },
} satisfies Record<Language, Record<Exclude<DonationSubmitFailure, "unknown">, string>>;

/**
 * The message for a refused submission, or null when the generic submitError fits: a server
 * error says nothing a donor can act on.
 */
export function donationSubmitFailureMessage(
  language: Language,
  status: number,
  code?: string | null,
): string | null {
  const failure = classifyDonationSubmitFailure(status, code);
  return failure === "unknown" ? null : donationSubmitFailureCopy[language][failure];
}
