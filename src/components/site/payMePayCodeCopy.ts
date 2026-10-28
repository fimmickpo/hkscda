import type { PayCodeLanguage } from "../../lib/donations/payme-paycode";

export type PayCodeCopy = {
  title: string;
  amountLabel: string;
  scanInstruction: string;
  scanLabel: string;
  qrUnavailable: string;
  countdownLabel: string;
  waiting: string;
  loadingTitle: string;
  loading: string;
  unavailableTitle: string;
  unavailable: string;
  processingTitle: string;
  processing: string;
  confirmingTitle: string;
  confirming: string;
  paidTitle: string;
  paid: string;
  paidAction: string;
  expiredTitle: string;
  expired: string;
  endedTitle: string;
  ended: string;
  unconfirmedTitle: string;
  unconfirmed: string;
  reference: string;
  cancelledTitle: string;
  cancelled: string;
  cancel: string;
  cancelling: string;
  cancelFailed: string;
  back: string;
  privateNote: string;
};

// One Record keyed by language, so a string added to one language and not the other fails to compile.
export const payCodeCopy: Record<PayCodeLanguage, PayCodeCopy> = {
  "zh-HK": {
    title: "以 PayMe 付款",
    amountLabel: "捐款金額",
    scanInstruction: "請用手機開啟 PayMe 應用程式，掃描下方 QR 碼完成付款。",
    scanLabel: "PayMe PayCode QR 碼",
    qrUnavailable: "暫時未能顯示 QR 碼。請返回捐款表格，稍後再試。",
    countdownLabel: "PayCode 有效時間",
    waiting: "正在等待付款確認…",
    loadingTitle: "正在準備付款",
    loading: "請稍候…",
    unavailableTitle: "暫時未能載入付款頁面",
    unavailable: "請返回捐款表格，稍後再試。",
    processingTitle: "付款正在處理中",
    processing: "請稍候，付款一確認，此頁會自動更新。如你已在 PayMe 完成付款，請勿重複付款。",
    confirmingTitle: "PayCode 已過期",
    confirming: "我們正在核對是否已收到付款，請勿關閉此頁。",
    paidTitle: "付款已確認，多謝支持！",
    paid: "正在前往確認頁面…",
    paidAction: "前往確認頁面",
    expiredTitle: "PayCode 已過期",
    expired: "這個 PayCode 已不能掃描。你可以返回捐款表格，重新開始付款。",
    endedTitle: "付款未完成",
    ended: "這次付款沒有完成。你可以返回捐款表格，重新選擇付款方式。",
    unconfirmedTitle: "暫時未能確認付款狀態",
    unconfirmed: "如你已在 PayMe 付款，請勿重複付款，並聯絡我們核實，請附上捐款編號。",
    reference: "捐款編號",
    cancelledTitle: "已取消付款",
    cancelled: "正在返回捐款表格…",
    cancel: "取消付款",
    cancelling: "正在取消…",
    cancelFailed: "未能取消付款。PayCode 在到期前仍然有效，請稍後再試。",
    back: "返回捐款表格",
    privateNote: "此為私人付款頁面，請勿轉發。",
  },
  en: {
    title: "Pay with PayMe",
    amountLabel: "Donation amount",
    scanInstruction: "Open the PayMe app on your phone and scan the code below to pay.",
    scanLabel: "PayMe PayCode QR code",
    qrUnavailable:
      "The QR code could not be shown. Please go back to the donation form and try again later.",
    countdownLabel: "PayCode valid for",
    waiting: "Waiting for payment confirmation…",
    loadingTitle: "Getting your payment ready",
    loading: "One moment…",
    unavailableTitle: "We could not load the payment page",
    unavailable: "Please go back to the donation form and try again later.",
    processingTitle: "Your payment is being processed",
    processing:
      "Please wait. This page updates as soon as the payment is confirmed. If you have already paid in PayMe, please do not pay again.",
    confirmingTitle: "The PayCode has expired",
    confirming: "We are checking whether a payment came in. Please keep this page open.",
    paidTitle: "Payment confirmed. Thank you!",
    paid: "Taking you to the confirmation…",
    paidAction: "Go to the confirmation",
    expiredTitle: "The PayCode has expired",
    expired:
      "This PayCode can no longer be scanned. You can go back to the donation form and start again.",
    endedTitle: "Payment not completed",
    ended:
      "This payment was not completed. You can go back to the donation form and choose a payment method again.",
    unconfirmedTitle: "We could not confirm your payment yet",
    unconfirmed:
      "If you have already paid in PayMe, please do not pay again. Contact us so we can check, and include your donation reference.",
    reference: "Donation reference",
    cancelledTitle: "Payment cancelled",
    cancelled: "Taking you back to the donation form…",
    cancel: "Cancel payment",
    cancelling: "Cancelling…",
    cancelFailed:
      "The payment could not be cancelled. The PayCode stays valid until it expires. Please try again.",
    back: "Back to the donation form",
    privateNote: "This is a private payment page. Please do not share it.",
  },
};
