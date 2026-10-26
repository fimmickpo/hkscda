import { ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useRef } from "react";

type PayMeModalStatus = "waiting" | "success" | "failed";

export function PayMePayCodeModal({
  webLink,
  amountLabel,
  status,
  language,
  onClose,
}: {
  webLink: string;
  amountLabel: string;
  status: PayMeModalStatus;
  language: "zh-HK" | "en";
  onClose: () => void;
}) {
  const openRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    openRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const t =
    language === "en"
      ? {
          title: "Pay with PayMe",
          // PayMe's hosted PayCode page cannot be framed, so it opens in a new tab.
          instruction:
            "We've opened PayMe in a new tab. Complete your payment there, then return to this page — it updates automatically.",
          openTab: "Open PayMe to pay",
          waiting: "Waiting for payment confirmation…",
          success: "Payment confirmed. Thank you!",
          failed: "Payment was not completed. Please try again.",
          close: "Close",
        }
      : {
          title: "以 PayMe 付款",
          instruction:
            "我們已在新分頁開啟 PayMe，請在該分頁完成付款，然後返回本頁，狀態會自動更新。",
          openTab: "開啟 PayMe 付款",
          waiting: "正在等待付款確認…",
          success: "付款已確認，多謝支持！",
          failed: "付款未完成，請再試一次。",
          close: "關閉",
        };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--public-scrim)] p-4"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-soft">
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="absolute right-3 top-3 rounded-full p-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="mb-1 font-display text-lg font-bold text-[var(--color-panel)]">{t.title}</h2>
        <p className="mb-3 text-sm font-semibold text-[var(--color-primary)]">{amountLabel}</p>
        <p className="mb-4 text-sm leading-6 text-[var(--color-text-muted)]">{t.instruction}</p>
        <a
          ref={openRef}
          href={webLink}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary inline-flex w-full items-center justify-center gap-2"
        >
          <ExternalLink className="h-4 w-4" />
          {t.openTab}
        </a>
        <div className="mt-4 flex items-center gap-2 text-sm" role="status" aria-live="polite">
          {status === "waiting" && (
            <>
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none text-[var(--color-primary)]" />
              <span className="text-[var(--color-text-muted)]">{t.waiting}</span>
            </>
          )}
          {status === "success" && (
            <span className="font-bold text-[var(--color-success)]">{t.success}</span>
          )}
          {status === "failed" && (
            <span className="font-bold text-[var(--color-error)]">{t.failed}</span>
          )}
        </div>
      </div>
    </div>
  );
}
