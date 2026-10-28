import { AlertCircle, CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { brand } from "../../lib/brand/brand";
import { centsToHkd } from "../../lib/donations/domain";
import {
  PAYCODE_POLL_INTERVAL_MS,
  PAYCODE_SUCCESS_REDIRECT_DELAY_MS,
  cancelPayCode,
  formatCountdown,
  loadPayCode,
  payCodeIsLive,
  payCodeReturnUrl,
  payCodeSuccessUrl,
  resolvePayCodeScreen,
  type PayCodeLanguage,
  type PayCodeLoad,
  type PayCodeScreen,
  type PayCodeStatus,
} from "../../lib/donations/payme-paycode";
import { loadDonationStatus } from "../../lib/donations/publicStatus";
import { payCodeCopy } from "./payMePayCodeCopy";
import { PublicStateShell } from "./PublicStateShell";
import { QrCodeSvg } from "./QrCodeSvg";

type CancelButtonState = "idle" | "cancelling" | "failed";

const spinner = (
  <Loader2 className="h-7 w-7 animate-spin motion-reduce:animate-none" aria-hidden="true" />
);

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="bg-[var(--color-bg)] py-10">
      <section className="public-container">{children}</section>
    </main>
  );
}

/** Everything the donor sees, for one screen. All behaviour lives in PayMePayCodePage. */
export function PayMePayCodeView({
  screen,
  language,
  donationId,
  webLink,
  amountCents,
  cancel,
  onCancel,
}: {
  screen: PayCodeScreen;
  language: PayCodeLanguage;
  donationId: string;
  webLink: string | null;
  amountCents: number | null;
  cancel: CancelButtonState;
  onCancel: () => void;
}) {
  const copy = payCodeCopy[language];
  const backToForm = (href: string) => (
    <a href={href} className="btn-primary min-h-11">
      {copy.back}
    </a>
  );

  switch (screen.kind) {
    case "loading":
      return (
        <Page>
          <PublicStateShell
            icon={spinner}
            title={copy.loadingTitle}
            description={<p>{copy.loading}</p>}
          />
        </Page>
      );
    case "unavailable":
      return (
        <Page>
          <PublicStateShell
            role="alert"
            icon={<AlertCircle className="h-7 w-7" aria-hidden="true" />}
            title={copy.unavailableTitle}
            description={<p>{copy.unavailable}</p>}
            action={backToForm("/donate")}
          />
        </Page>
      );
    case "processing":
      return (
        <Page>
          <PublicStateShell
            icon={spinner}
            title={copy.processingTitle}
            description={<p>{copy.processing}</p>}
          />
        </Page>
      );
    case "confirming":
      return (
        <Page>
          <PublicStateShell
            icon={spinner}
            title={copy.confirmingTitle}
            description={<p>{copy.confirming}</p>}
          />
        </Page>
      );
    case "paid":
      return (
        <Page>
          <PublicStateShell
            icon={
              <CheckCircle2 className="h-7 w-7 text-[var(--color-success)]" aria-hidden="true" />
            }
            title={copy.paidTitle}
            description={<p>{copy.paid}</p>}
            action={
              <a href={payCodeSuccessUrl(donationId)} className="btn-primary min-h-11">
                {copy.paidAction}
              </a>
            }
          />
        </Page>
      );
    case "expired":
      return (
        <Page>
          <PublicStateShell
            icon={<Clock3 className="h-7 w-7" aria-hidden="true" />}
            title={copy.expiredTitle}
            description={<p>{copy.expired}</p>}
            action={backToForm(payCodeReturnUrl(donationId))}
          />
        </Page>
      );
    case "ended":
      return (
        <Page>
          <PublicStateShell
            icon={<XCircle className="h-7 w-7" aria-hidden="true" />}
            title={copy.endedTitle}
            description={<p>{copy.ended}</p>}
            action={backToForm(payCodeReturnUrl(donationId))}
          />
        </Page>
      );
    case "unconfirmed":
      return (
        <Page>
          <PublicStateShell
            role="alert"
            icon={<AlertCircle className="h-7 w-7" aria-hidden="true" />}
            title={copy.unconfirmedTitle}
            description={
              <>
                <p>{copy.unconfirmed}</p>
                <p className="mt-3">
                  {copy.reference}：<strong className="break-all">{donationId}</strong>
                </p>
                <p className="mt-3">
                  <a href={`mailto:${brand.org.donationEmail}`}>{brand.org.donationEmail}</a>
                </p>
              </>
            }
            action={backToForm("/donate")}
          />
        </Page>
      );
    case "cancelled":
      return (
        <Page>
          <PublicStateShell
            icon={spinner}
            title={copy.cancelledTitle}
            description={<p>{copy.cancelled}</p>}
            action={backToForm(payCodeReturnUrl(donationId))}
          />
        </Page>
      );
    case "scan":
      return (
        <Page>
          <div className="mx-auto max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-soft">
            <h1 className="text-2xl font-bold text-[var(--color-text)]">{copy.title}</h1>
            {amountCents !== null ? (
              <>
                <p className="mt-3 text-sm text-[var(--color-text-muted)]">{copy.amountLabel}</p>
                <p className="text-3xl font-bold text-[var(--color-primary)]">
                  {centsToHkd(amountCents)}
                </p>
              </>
            ) : null}
            <p className="mt-4 text-sm leading-6 text-[var(--color-text-muted)]">
              {copy.scanInstruction}
            </p>
            <div className="mx-auto mt-5 aspect-square w-full max-w-64 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              {webLink ? (
                <QrCodeSvg
                  value={webLink}
                  label={copy.scanLabel}
                  className="h-full w-full"
                  fallback={
                    <p role="alert" className="p-4 text-sm text-[var(--color-error)]">
                      {copy.qrUnavailable}
                    </p>
                  }
                />
              ) : null}
            </div>
            <p
              role="timer"
              className="mt-4 flex items-center justify-center gap-2 text-sm font-semibold text-[var(--color-text)]"
            >
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              <span>{copy.countdownLabel}</span>
              <time>{formatCountdown(screen.remainingMs)}</time>
            </p>
            <p
              role="status"
              aria-live="polite"
              className="mt-2 flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]"
            >
              <Loader2
                className="h-4 w-4 animate-spin text-[var(--color-primary)] motion-reduce:animate-none"
                aria-hidden="true"
              />
              {copy.waiting}
            </p>
            <button
              type="button"
              onClick={onCancel}
              disabled={cancel === "cancelling"}
              className="btn-outline mt-5 min-h-11"
            >
              {cancel === "cancelling" ? copy.cancelling : copy.cancel}
            </button>
            {cancel === "failed" ? (
              <p role="alert" className="mt-3 text-sm text-[var(--color-error)]">
                {copy.cancelFailed}
              </p>
            ) : null}
            {/* The cue is an inline pill: on its own line it reads as a note, not a second button. */}
            <div>
              <p className="trust-cue mt-5">{copy.privateNote}</p>
            </div>
          </div>
        </Page>
      );
    default: {
      const unreachable: never = screen;
      return unreachable;
    }
  }
}

type CancelState = CancelButtonState | "cancelled" | "busy";

/**
 * The desktop PayMe checkout. The donor scans a QR code made from the PayCode link with the PayMe
 * app; this page counts down the PayCode's life, asks our own status route every ten seconds (PayMe
 * itself is only asked after sixty, server side), and moves on when the payment settles. Cancel asks
 * PayMe to void the PayCode first, so a donor who leaves cannot pay it afterwards.
 */
export function PayMePayCodePage({ donationId }: { donationId: string }) {
  const [load, setLoad] = useState<PayCodeLoad>({ kind: "loading" });
  const [language, setLanguage] = useState<PayCodeLanguage>("zh-HK");
  const [payCode, setPayCode] = useState<{ webLink: string; amountCents: number } | null>(null);
  const [status, setStatus] = useState<PayCodeStatus>("pending");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [cancel, setCancel] = useState<CancelState>("idle");

  const screen = resolvePayCodeScreen({
    load,
    status,
    nowMs,
    cancelled: cancel === "cancelled",
    processing: cancel === "busy",
  });
  const live = payCodeIsLive(screen, load, nowMs);
  const loaded = load.kind === "ready";

  useEffect(() => {
    let active = true;
    loadPayCode(donationId)
      .then((response) => {
        if (!active) return;
        setLanguage(response.language);
        if (response.status === "pending") {
          setPayCode({ webLink: response.webLink, amountCents: response.amountCents });
          setLoad({
            kind: "ready",
            expiresAtMs: Date.parse(response.expiresAt),
            skewMs: Date.parse(response.serverNow) - Date.now(),
          });
        } else {
          setStatus(response.status);
          setLoad({ kind: "ready", expiresAtMs: null, skewMs: 0 });
        }
      })
      .catch(() => {
        if (active) setLoad({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [donationId]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (!live || !loaded) return;
    let active = true;
    async function poll() {
      try {
        const latest = await loadDonationStatus(donationId);
        if (active) setStatus(latest.status);
      } catch {
        // A missed check is not an outcome: keep what we know and ask again.
      }
    }
    void poll();
    const timer = setInterval(poll, PAYCODE_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [donationId, live, loaded]);

  const paid = screen.kind === "paid";
  useEffect(() => {
    if (!paid) return;
    const timer = setTimeout(() => {
      window.location.assign(payCodeSuccessUrl(donationId));
    }, PAYCODE_SUCCESS_REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [paid, donationId]);

  const cancelled = cancel === "cancelled";
  useEffect(() => {
    if (cancelled) window.location.assign(payCodeReturnUrl(donationId));
  }, [cancelled, donationId]);

  async function handleCancel() {
    setCancel("cancelling");
    try {
      const result = await cancelPayCode(donationId);
      // Anything but "cancelled" means PayMe says a payment got there first: keep waiting for it.
      setCancel(result.status === "cancelled" ? "cancelled" : "busy");
    } catch {
      setCancel("failed");
    }
  }

  return (
    <PayMePayCodeView
      screen={screen}
      language={language}
      donationId={donationId}
      webLink={payCode?.webLink ?? null}
      amountCents={payCode?.amountCents ?? null}
      cancel={cancel === "cancelling" || cancel === "failed" ? cancel : "idle"}
      onCancel={() => void handleCancel()}
    />
  );
}
