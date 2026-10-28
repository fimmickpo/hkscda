import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/pageHead";
import {
  BadgeCheck,
  Building,
  Check,
  CreditCard,
  Download,
  Globe,
  Heart,
  Loader2,
  ReceiptText,
  Smartphone,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { brand } from "../lib/brand/brand";
import {
  extractDonationAttribution,
  donateSearchSchema,
  type DonateSearch,
} from "../lib/donations/donateSearch";
import { loadDonationDocumentSlots } from "../lib/documents/donation.server";
import { asContextFreeRouteLoader } from "../lib/documents/routeLoaders.server";
import type { DocumentSlot } from "../lib/documents/types";
import { getPublicCheckoutState } from "../lib/donations/checkoutPolicy.functions";
import { checkoutPurpose } from "../lib/donations/checkoutPolicy";
import type { PublicCheckoutState } from "../lib/donations/checkoutPolicy.server";
import type { PublicPaymentMethod } from "../lib/paymentPublicConfig/types";
import {
  markDonationEventOnce,
  readCheckoutSnapshot,
  saveCheckoutSnapshot,
  trackDonationEvent,
  type DonationCheckoutSnapshot,
} from "../lib/donations/analytics";
import { checkoutDestination } from "../lib/donations/checkoutDestination";
import { pollDonationSucceeded } from "../lib/donations/publicStatus";
import { checkoutExperienceFromViewport } from "../lib/donations/checkoutExperience";
import { customAmountStep } from "../lib/donations/customAmount";
import {
  browserCheckoutIntentStorage,
  discardCancelledPayMeIntent,
  discardCheckoutIntent,
  selectCheckoutIntent,
  type CheckoutIntent,
} from "../lib/donations/checkoutIntent";
import {
  centsToHkd,
  type CheckoutExperience,
  type DonationMethod,
  type DonationPurpose,
} from "../lib/donations/domain";
import { BrandLogo } from "../components/site/BrandLogo";
import { donationSubmitFailureMessage } from "../components/site/donationSubmitFailureCopy";
import { TurnstileWidget, turnstileEnabled } from "../components/site/TurnstileWidget";

export const Route = createFileRoute("/donate")({
  validateSearch: donateSearchSchema,
  loader: asContextFreeRouteLoader(async () => {
    const [slots, checkoutState] = await Promise.all([
      loadDonationDocumentSlots(),
      getPublicCheckoutState().catch(() => ({ state: "unavailable" as const, methods: [] as [] })),
    ]);
    return { slots, checkoutState };
  }),
  head: () =>
    pageHead({
      title: "捐助我們",
      description: "了解香港拯救貓狗協會的善款用途、收條安排，以及經職員確認的捐款下一步。",
      shareDescription: "了解善款用途、收條安排及經職員確認的捐款下一步。",
      path: "/donate",
    }),
  component: DonateRoute,
});

type Language = "zh-HK" | "en";

type ManualResult = {
  kind: "manual";
  donationId: string;
  reference: string;
  instructions: {
    method: "fps";
    label: string;
    payableTo: string;
    identifier: string;
    amountCents: number;
  } | null;
};

type RedirectResult = {
  kind: "redirect";
  donationId: string;
  provider: "stripe" | "paypal" | "cod" | "payme";
  url: string;
};

type PayMeResult = {
  kind: "payme";
  donationId: string;
  paymentRequestId: string;
  webLink: string;
  appLink: string;
};

type DonationReturnState = "pending" | "confirmed" | "unavailable";

export type DonationRequestPayload = {
  idempotencyKey: string;
  amountCents: number;
  currency: "HKD";
  purpose: DonationPurpose;
  customPurpose: string;
  method: DonationMethod;
  expectedConfigVersion: number;
  checkoutExperience: CheckoutExperience;
  receiptRequested: boolean;
  donor: { name: string; email: string; phone: string; language: Language };
  consents: { email: boolean; whatsapp: boolean };
  turnstileToken: string | null;
  attribution?: ReturnType<typeof extractDonationAttribution>;
};

const copy = {
  "zh-HK": {
    eyebrow: "捐助我們",
    title: "您的每一份善意，都是生命的希望",
    intro: "本會為政府認可慈善機構（91/14493），善款用於流浪貓狗糧食、醫療、絕育及領養工作。",
    receiptBadge: "HK$100 或以上可申請 IRD §88 退稅收條",
    amount: "捐款金額",
    customAmount: "自訂金額",
    purpose: "捐款用途",
    customPurpose: "其他捐款用途（婚宴／活動／粉絲籌款 等）",
    details: "捐款人資料",
    method: "付款方式",
    receipt: "我需要退稅收條",
    emailConsent: "我同意以電郵接收捐款確認及收條通知",
    pics: "個人資料只會用於處理捐款、收條、查詢及法例要求的紀錄保存。您可要求查閱、更正或撤回通訊同意。",
    consentLegend: "收據及通訊同意",
    donate: "繼續捐款",
    processing: "處理中",
    success: "多謝您的支持。付款確認後，系統會發出確認電郵及合資格收條。",
    paymentWaiting: "正在等待付款確認。付款狀態以本會系統為準，請勿重複付款。",
    paymentConfirmed: "付款已確認。合資格收條及電郵會分開處理；尚未收到不代表付款失敗。",
    paymentUnavailable: "暫時未能確認付款狀態。請稍後再試或聯絡我們，請勿重複付款。",
    cancelled: "付款尚未完成，您可以重新選擇付款方式。",
    paypalApproved: "PayPal 已授權，確認完成後會發出收據通知。",
    manualTitle: "請使用以下資料完成付款",
    manualVerification:
      "原付款指示已撤回或暫時未能核實。請聯絡職員，並提供以下參考編號；請勿沿用舊付款資料。",
    reference: "付款參考編號",
    submitError: "暫時未能建立捐款，請稍後再試，或選擇其他付款方式。",
    checkoutRecoveryRequired: "付款建立結果未能確認。請聯絡職員核實，暫時不要重複付款。",
    recoveryReference: "查詢編號",
    donorName: "姓名",
    email: "電郵",
    phone: "電話（選填）",
    verifyRequired: "請先完成人機驗證",
    checkoutUnavailable:
      "網上捐款尚未完成正式啟用審批。現時請先聯絡職員核實可用捐款安排；請勿使用測試或未經確認的付款資料。",
    checkoutUnavailableButton: "網上捐款尚未啟用",
    checkoutTemporarilyUnavailable: "付款資料暫時未能確認，請稍後再試或聯絡職員。",
    checkoutNotConfigured: "目前沒有已核准的付款方式，請聯絡職員核實安排。",
    methodNotice: "付款服務完成正式審批後，系統才會在這裡顯示可用方式。",
  },
  en: {
    eyebrow: "Donate",
    title: "Every gift gives rescued animals another chance",
    intro:
      "HKSCDA is an approved charitable institution (91/14493). Donations support food, medical care, desexing, and adoption work.",
    receiptBadge: "HK$100+ gifts can request an IRD Section 88 receipt",
    amount: "Donation amount",
    customAmount: "Custom amount",
    purpose: "Purpose",
    customPurpose: "Other donation purpose (wedding, event, fan fundraiser, etc.)",
    details: "Donor details",
    method: "Payment method",
    receipt: "I need a tax receipt",
    emailConsent: "I agree to receive donation confirmation and receipt updates by email",
    pics: "Personal data is used only for donation processing, receipts, enquiries, and legally required record keeping. You may request access, correction, or consent withdrawal.",
    consentLegend: "Receipts and communication consent",
    donate: "Continue donation",
    processing: "Processing",
    success:
      "Thank you for your support. A confirmation email and eligible receipt will be sent after payment is confirmed.",
    paymentWaiting:
      "Waiting for payment confirmation. Our donation system is the source of truth; please do not pay again.",
    paymentConfirmed:
      "Payment confirmed. Eligible receipts and email updates are processed separately; a delay does not mean payment failed.",
    paymentUnavailable:
      "We cannot confirm the payment status yet. Please try again later or contact us; do not pay again.",
    cancelled: "Payment is not complete. You can choose a payment method again.",
    paypalApproved: "PayPal approval received. We will notify you after confirmation.",
    manualTitle: "Complete payment with these details",
    manualVerification:
      "The payment instructions were withdrawn or cannot be verified. Contact our team with the reference below; do not reuse old payment details.",
    reference: "Payment reference",
    submitError:
      "Donation could not be created. Please try again later or choose another payment method.",
    checkoutRecoveryRequired:
      "We cannot confirm the checkout outcome. Please contact our team before trying to pay again.",
    recoveryReference: "Reference",
    donorName: "Name",
    email: "Email",
    phone: "Phone (optional)",
    verifyRequired: "Please complete the verification first.",
    checkoutUnavailable:
      "Online donations have not completed production activation approval. Please contact staff to verify an approved donation arrangement; do not use test or unconfirmed payment details.",
    checkoutUnavailableButton: "Online donations are not active",
    checkoutTemporarilyUnavailable:
      "Payment details cannot be verified right now. Please try later or contact our team.",
    checkoutNotConfigured:
      "No payment method is approved yet. Please contact our team to verify arrangements.",
    methodNotice: "Approved payment methods will appear here only after production activation.",
  },
} satisfies Record<Language, Record<string, string>>;

const amounts = [100, 300, 500, 1000];

const purposes: { value: DonationPurpose; zh: string; en: string }[] = [
  { value: "general", zh: "一般營運", en: "General" },
  { value: "medical", zh: "醫療基金", en: "Medical" },
  { value: "sponsor", zh: "助養動物", en: "Sponsor" },
];

const METHOD_ICONS: Record<DonationMethod, typeof CreditCard> = {
  stripe: CreditCard,
  alipayhk: Smartphone,
  fps: Zap,
  payme: Smartphone,
  paypal: Globe,
};

export function reconcileDonationMethod(
  selected: DonationMethod | null,
  configured: PublicPaymentMethod[],
): DonationMethod | null {
  if (selected && configured.some((entry) => entry.method === selected)) return selected;
  return configured[0]?.method ?? null;
}

export function isDonationMethodAvailable(
  selected: DonationMethod | null,
  configured: PublicPaymentMethod[],
): selected is DonationMethod {
  return selected !== null && configured.some((entry) => entry.method === selected);
}

function methodsFromConfig(configured: PublicPaymentMethod[]) {
  return configured.map((entry) => ({
    value: entry.method,
    zh: entry.displayLabelZh,
    en: entry.displayLabelEn,
    Icon: METHOD_ICONS[entry.method],
  }));
}

export function createDonationRequest(
  input: Omit<DonationRequestPayload, "currency">,
): DonationRequestPayload {
  return { ...input, consents: { ...input.consents, whatsapp: false }, currency: "HKD" };
}

export function donationStatusMessage(state: DonationReturnState, language: Language) {
  const messages = copy[language];
  if (state === "confirmed") return messages.paymentConfirmed;
  if (state === "unavailable") return messages.paymentUnavailable;
  return messages.paymentWaiting;
}

function isPendingCheckoutReturn(status: DonateSearch["status"] | undefined) {
  return status === "pending" || status === "success" || status === "paypal-approved";
}

type DonationReturnDependencies = {
  pollDonationStatus?: typeof pollDonationSucceeded;
  markDonationEvent?: typeof markDonationEventOnce;
  trackDonationEvent?: typeof trackDonationEvent;
  signal?: AbortSignal;
};

export async function resolveDonationReturn(
  donationId: string,
  snapshot: DonationCheckoutSnapshot | undefined,
  dependencies: DonationReturnDependencies = {},
): Promise<DonationReturnState> {
  const confirmed = await (dependencies.pollDonationStatus ?? pollDonationSucceeded)(donationId, {
    signal: dependencies.signal,
  });
  if (!confirmed) return "unavailable";

  const markEvent = dependencies.markDonationEvent ?? markDonationEventOnce;
  const trackEvent = dependencies.trackDonationEvent ?? trackDonationEvent;
  if (snapshot && markEvent("donation_success", donationId)) {
    trackEvent("donation_success", {
      context: snapshot.context,
      purpose: snapshot.purpose,
      method: snapshot.method,
      value: snapshot.value,
      currency: snapshot.currency,
    });
  }

  return "confirmed";
}

function DonateRoute() {
  const loaderData = Route.useLoaderData();
  return (
    <DonatePage
      initialSlots={loaderData.slots}
      initialMethods={loaderData.checkoutState.methods}
      checkoutState={loaderData.checkoutState}
      initialSearch={Route.useSearch()}
    />
  );
}

export function DonatePage({
  initialSlots,
  initialMethods,
  initialSearch,
  checkoutState,
  checkoutEnabled = checkoutState?.state === "ready",
}: {
  initialSlots: DocumentSlot[];
  initialMethods: PublicPaymentMethod[];
  initialSearch: DonateSearch;
  checkoutState?: PublicCheckoutState;
  checkoutEnabled?: boolean;
}) {
  const search = initialSearch;
  const attribution = extractDonationAttribution(search);
  const [language, setLanguage] = useState<Language>("zh-HK");
  const t = copy[language];
  const [selectedAmount, setSelectedAmount] = useState(300);
  const [customAmount, setCustomAmount] = useState("");
  const [purpose, setPurpose] = useState<DonationPurpose>(search.purpose ?? "general");
  const [customPurpose, setCustomPurpose] = useState("");
  const [method, setMethod] = useState<DonationMethod | null>(() =>
    reconcileDonationMethod(null, initialMethods),
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [receiptRequested, setReceiptRequested] = useState(true);
  const [emailConsent, setEmailConsent] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<ManualResult | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [returnState, setReturnState] = useState<DonationReturnState | null>(null);
  const checkoutIntentRef = useRef<CheckoutIntent | null>(null);
  const availableMethods = useMemo(
    () =>
      initialMethods.filter(
        (entry) => !entry.purposes || entry.purposes.includes(checkoutPurpose(purpose)),
      ),
    [initialMethods, purpose],
  );
  const methods = useMemo(() => methodsFromConfig(availableMethods), [availableMethods]);

  useEffect(() => {
    setMethod((selected) => reconcileDonationMethod(selected, availableMethods));
  }, [availableMethods]);

  useEffect(() => {
    if (!attribution) return;

    if (markDonationEventOnce("donation_form_view", JSON.stringify(attribution))) {
      trackDonationEvent("donation_form_view", { attribution });
    }
  }, [attribution]);

  useEffect(() => {
    if (!search.donation || returnState !== "confirmed") return;
    discardCheckoutIntent(checkoutIntentRef, browserCheckoutIntentStorage());
  }, [search.donation, returnState]);
  useEffect(() => {
    if (!search.donation || search.status !== "cancelled") return;
    discardCancelledPayMeIntent(checkoutIntentRef, browserCheckoutIntentStorage());
  }, [search.donation, search.status]);
  useEffect(() => {
    const donationId = search.donation;
    if (!donationId || !isPendingCheckoutReturn(search.status)) {
      return;
    }

    setReturnState("pending");
    const snapshot = readCheckoutSnapshot(donationId);
    const controller = new AbortController();

    let active = true;
    void resolveDonationReturn(donationId, snapshot, { signal: controller.signal }).then(
      (state) => {
        if (!active) return;
        setReturnState(state);
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
  }, [search.donation, search.status]);

  const amountHkd = useMemo(() => {
    const parsedCustom = Number(customAmount);
    return Number.isFinite(parsedCustom) && parsedCustom > 0 ? parsedCustom : selectedAmount;
  }, [customAmount, selectedAmount]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setManualResult(null);

    if (!checkoutEnabled) {
      setError(t.checkoutUnavailable);
      return;
    }

    if (!isDonationMethodAvailable(method, availableMethods)) {
      setError(t.methodNotice);
      return;
    }

    if (turnstileEnabled && !turnstileToken) {
      setError(t.verifyRequired);
      return;
    }

    setLoading(true);
    setTurnstileToken(null);

    try {
      const checkoutExperience = checkoutExperienceFromViewport(window.innerWidth);
      const selectedConfig = availableMethods.find((entry) => entry.method === method);
      const intentDetails = {
        expectedConfigVersion: selectedConfig?.configVersion ?? 0,
        amountCents: Math.round(amountHkd * 100),
        purpose,
        customPurpose,
        method,
        checkoutExperience,
        receiptRequested,
        donor: { name, email, phone, language },
        consents: { email: emailConsent, whatsapp: false },
        ...(attribution ? { attribution } : {}),
      };
      const fingerprintBytes = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(intentDetails)),
      );
      const fingerprint = Array.from(new Uint8Array(fingerprintBytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const intent = selectCheckoutIntent({
        fingerprint,
        method,
        ref: checkoutIntentRef,
        storage: browserCheckoutIntentStorage(),
      });

      const response = await fetch("/api/donations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createDonationRequest({
            ...intentDetails,
            idempotencyKey: intent.key,
            turnstileToken,
          }),
        ),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as {
          code?: string;
          donationId?: string;
        } | null;
        if (failure?.code === "checkout_recovery_required") {
          setError(
            failure.donationId
              ? t.checkoutRecoveryRequired + " " + t.recoveryReference + ": " + failure.donationId
              : t.checkoutRecoveryRequired,
          );
          return;
        }
        const refusal = donationSubmitFailureMessage(language, response.status, failure?.code);
        if (refusal) {
          // The server has used up the verification token; the widget gets a fresh one.
          if (turnstileEnabled) setTurnstileResetKey((key) => key + 1);
          setError(refusal);
          return;
        }
        throw new Error("Donation request failed");
      }
      const data = (await response.json()) as ManualResult | RedirectResult | PayMeResult;

      if (attribution) {
        saveCheckoutSnapshot(data.donationId, {
          context: attribution.context,
          purpose,
          method,
          value: amountHkd,
          currency: "HKD",
        });
        if (markDonationEventOnce("begin_checkout", data.donationId)) {
          trackDonationEvent("begin_checkout", {
            attribution,
            method,
            value: amountHkd,
            currency: "HKD",
          });
        }
      }

      if (data.kind === "manual") {
        discardCheckoutIntent(checkoutIntentRef, browserCheckoutIntentStorage());
        setManualResult(data);
        return;
      }
      // A PayMe desktop checkout leaves for the PayCode page, which keeps the saved checkout until
      // it learns how the payment ended.
      window.location.href = checkoutDestination(data, checkoutExperience);
    } catch {
      if (turnstileEnabled) setTurnstileResetKey((key) => key + 1);
      setError(t.submitError);
    } finally {
      setLoading(false);
    }
  }

  const statusMessage =
    search.status === "cancelled"
      ? t.cancelled
      : returnState
        ? donationStatusMessage(returnState, language)
        : isPendingCheckoutReturn(search.status)
          ? donationStatusMessage("pending", language)
          : null;

  const availableWeddingSlots = initialSlots.filter(
    (slot) => slot.slotKey === "wedding_gift_return_plan" && slot.document.fileUrl,
  );
  const primaryWedding =
    availableWeddingSlots.find((slot) => slot.language === language) ?? availableWeddingSlots[0];
  const alternateWedding = availableWeddingSlots.find((slot) => slot.id !== primaryWedding?.id);

  return (
    <main className="bg-[var(--color-background)]">
      <section className="bg-[var(--color-surface-offset)]">
        <div className="public-container grid grid-cols-1 gap-8 py-10 lg:grid-cols-[0.9fr_1.1fr] lg:py-14">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--color-primary-highlight)] px-3 py-1 text-xs font-bold uppercase tracking-widest text-[var(--color-primary)]">
              <Heart className="h-3.5 w-3.5" /> {t.eyebrow}
            </div>
            <div className="space-y-4">
              <h1 className="font-display text-4xl font-extrabold leading-tight text-[var(--color-panel)] lg:text-6xl">
                {t.title}
              </h1>
              <p className="max-w-[52ch] text-sm leading-7 text-[var(--color-text-muted)] lg:text-base">
                {t.intro}
              </p>
              <div className="flex min-w-0 items-start gap-3 border-l-4 border-[var(--color-secondary)] pl-4">
                <BrandLogo className="h-16 w-16 shrink-0" eager />
                <div className="min-w-0 space-y-1 break-words text-sm text-[var(--color-text-muted)]">
                  <p className="font-bold text-[var(--color-panel)]">{brand.nameZh}</p>
                  <p>{brand.nameEn}</p>
                  <p>
                    香港註冊慈善機構 {brand.org.charityFileNumber}
                    。捐款用於糧食、醫療、絕育及領養工作。
                  </p>
                  <a
                    className="inline-flex min-h-11 items-center font-semibold text-[var(--color-primary)] hover:underline"
                    href={`mailto:${brand.org.donationEmail}`}
                  >
                    {brand.org.donationEmail}
                  </a>
                </div>
              </div>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[var(--color-success-highlight)] px-4 py-2 text-xs font-bold text-[var(--color-success)]">
              <BadgeCheck className="h-4 w-4" /> {t.receiptBadge}
            </div>
            {statusMessage && (
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm font-medium text-[var(--color-panel)]"
              >
                {statusMessage}
              </div>
            )}
          </div>

          <form
            onSubmit={handleSubmit}
            lang={language === "en" ? "en" : "zh-Hant"}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-soft lg:p-6"
          >
            <div className="mb-5 flex justify-end">
              <div className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface-offset)] p-1 text-xs font-bold">
                {(["zh-HK", "en"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    aria-pressed={language === lang}
                    onClick={() => setLanguage(lang)}
                    className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 transition-colors ${
                      language === lang
                        ? "bg-[var(--color-primary)] text-white"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    {lang === "zh-HK" ? "繁" : "EN"}
                  </button>
                ))}
              </div>
            </div>

            {!checkoutEnabled && (
              <div className="mb-5 rounded-md border border-[var(--color-secondary)] bg-[var(--color-secondary-highlight)] p-4">
                <p className="text-sm font-semibold leading-6 text-[var(--color-panel)]">
                  {checkoutState?.state === "unavailable"
                    ? t.checkoutTemporarilyUnavailable
                    : checkoutState?.state === "not_configured"
                      ? t.checkoutNotConfigured
                      : t.checkoutUnavailable}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={`mailto:${brand.org.donationEmail}`} className="btn-secondary min-h-11">
                    {brand.org.donationEmail}
                  </a>
                </div>
              </div>
            )}

            <fieldset
              disabled={!checkoutEnabled}
              className="space-y-6 border-0 p-0 disabled:opacity-75"
            >
              <fieldset className="space-y-3">
                <legend className="text-sm font-bold text-[var(--color-panel)]">{t.amount}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {amounts.map((amount) => (
                    <button
                      key={amount}
                      type="button"
                      aria-pressed={amountHkd === amount && !customAmount}
                      onClick={() => {
                        setSelectedAmount(amount);
                        setCustomAmount("");
                      }}
                      className={`min-h-11 rounded-md border px-4 py-3 text-sm font-bold transition-colors ${
                        amountHkd === amount && !customAmount
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                          : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-primary)]"
                      }`}
                    >
                      HK${amount}
                    </button>
                  ))}
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--color-text-muted)]">
                    {t.customAmount}
                  </span>
                  <input
                    id="donation-custom-amount"
                    aria-invalid={false}
                    aria-describedby={undefined}
                    type="number"
                    min="10"
                    step={customAmountStep({
                      development: import.meta.env.DEV,
                      allowCentsFlag: import.meta.env.VITE_PUBLIC_ALLOW_CENT_AMOUNTS,
                    })}
                    value={customAmount}
                    onChange={(event) => setCustomAmount(event.target.value)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 text-sm focus:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                    placeholder="HK$"
                  />
                </label>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-sm font-bold text-[var(--color-panel)]">{t.purpose}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {purposes.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={purpose === item.value}
                      onClick={() => setPurpose(item.value)}
                      className={`min-h-11 rounded-md border px-3 py-3 text-sm font-bold transition-colors ${
                        purpose === item.value
                          ? "border-[var(--color-panel)] bg-[var(--color-panel)] text-white"
                          : "border-[var(--color-border)] bg-white text-[var(--color-text)] hover:border-[var(--color-panel)]"
                      }`}
                    >
                      {language === "zh-HK" ? item.zh : item.en}
                    </button>
                  ))}
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--color-text-muted)]">
                    {t.customPurpose}
                  </span>
                  <input
                    name="customPurpose"
                    value={customPurpose}
                    onChange={(event) => setCustomPurpose(event.target.value)}
                    maxLength={200}
                    autoComplete="off"
                    className="w-full rounded-md border border-[var(--color-border)] bg-white px-4 py-3 text-sm focus:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                  />
                </label>
              </fieldset>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="col-span-full text-sm font-bold text-[var(--color-panel)]">
                  {t.details}
                </legend>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--color-text-muted)]">
                    {t.donorName}
                  </span>
                  <input
                    id="donor-name"
                    aria-invalid={false}
                    aria-describedby={undefined}
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 text-sm focus:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-[var(--color-text-muted)]">
                    {t.email}
                  </span>
                  <input
                    id="donor-email"
                    aria-invalid={false}
                    aria-describedby={undefined}
                    required
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 text-sm focus:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs font-bold text-[var(--color-text-muted)]">
                    {t.phone}
                  </span>
                  <input
                    id="donor-phone"
                    aria-invalid={false}
                    aria-describedby={undefined}
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-white px-4 py-3 text-sm focus:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                  />
                </label>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-sm font-bold text-[var(--color-panel)]">{t.method}</legend>
                {checkoutEnabled && methods.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {methods.map(({ value, zh, en, Icon }) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={method === value}
                        onClick={() => setMethod(value)}
                        className={`flex min-h-11 items-center gap-3 rounded-md border px-4 py-3 text-left text-sm font-bold transition-colors ${
                          method === value
                            ? "border-[var(--color-primary)] bg-[var(--color-primary-highlight)] text-[var(--color-primary)]"
                            : "border-[var(--color-border)] bg-white text-[var(--color-text)] hover:border-[var(--color-primary)]"
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {language === "zh-HK" ? zh : en}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-md bg-[var(--color-surface-offset)] p-3 text-sm text-[var(--color-text-muted)]">
                    {t.methodNotice}
                  </p>
                )}
              </fieldset>

              <fieldset className="space-y-3 rounded-md bg-[var(--color-surface-offset)] p-4">
                <legend className="text-sm font-bold text-[var(--color-panel)]">
                  {t.consentLegend}
                </legend>
                {[
                  {
                    id: "donation-receipt",
                    checked: receiptRequested,
                    setChecked: setReceiptRequested,
                    label: t.receipt,
                  },
                  {
                    id: "donation-email-consent",
                    checked: emailConsent,
                    setChecked: setEmailConsent,
                    label: t.emailConsent,
                  },
                ].map(({ id, checked, setChecked, label }) => (
                  <label key={id} htmlFor={id} className="flex items-start gap-3 text-sm">
                    <input
                      id={id}
                      type="checkbox"
                      aria-invalid={false}
                      aria-describedby={undefined}
                      checked={checked}
                      onChange={(event) =>
                        (setChecked as React.Dispatch<React.SetStateAction<boolean>>)(
                          event.target.checked,
                        )
                      }
                      className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
                    />
                    <span>{label}</span>
                  </label>
                ))}
                <p className="text-xs leading-6 text-[var(--color-text-muted)]">{t.pics}</p>
              </fieldset>

              {checkoutEnabled && (
                <TurnstileWidget
                  resetKey={turnstileResetKey}
                  onVerify={setTurnstileToken}
                  onExpire={() => setTurnstileToken(null)}
                  language={language === "en" ? "en" : "zh-tw"}
                />
              )}

              {error && (
                <p role="alert" className="text-sm font-bold text-[var(--color-error)]">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={
                  !checkoutEnabled ||
                  !isDonationMethodAvailable(method, initialMethods) ||
                  loading ||
                  (turnstileEnabled && !turnstileToken)
                }
                className="btn-primary w-full disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Heart className="h-4 w-4" />
                )}
                {!checkoutEnabled
                  ? t.checkoutUnavailableButton
                  : loading
                    ? t.processing
                    : `${t.donate} · ${centsToHkd(Math.round(amountHkd * 100))}`}
              </button>
            </fieldset>

            {manualResult && (
              <div className="mt-6 rounded-2xl border border-dashed border-[var(--color-primary)] bg-[var(--color-primary-highlight)] p-4 text-sm">
                <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-bold text-[var(--color-panel)]">
                  <ReceiptText className="h-5 w-5 text-[var(--color-primary)]" />{" "}
                  {manualResult.instructions ? t.manualTitle : t.manualVerification}
                </h2>
                <div className="space-y-2 text-[var(--color-text)]">
                  {manualResult.instructions && (
                    <>
                      <div className="flex items-center gap-2">
                        <Building className="h-4 w-4 text-[var(--color-primary)]" />
                        {manualResult.instructions.payableTo}
                      </div>
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-[var(--color-primary)]" />
                        {manualResult.instructions.identifier}
                      </div>
                    </>
                  )}
                  {!manualResult.instructions && (
                    <a
                      href={`mailto:${brand.org.donationEmail}`}
                      className="font-semibold underline"
                    >
                      {brand.org.donationEmail}
                    </a>
                  )}
                  <div className="flex items-center gap-2 font-bold">
                    <Check className="h-4 w-4 text-[var(--color-success)]" />
                    {t.reference}: {manualResult.reference}
                  </div>
                </div>
              </div>
            )}
          </form>
        </div>
      </section>

      <section className="bg-[var(--color-surface)]">
        <div className="public-container py-10 lg:py-14">
          <div className="max-w-3xl">
            <h2 className="font-display text-2xl font-bold text-[var(--color-panel)] lg:text-3xl">
              💍 Share the Love – 婚宴回禮計劃
            </h2>
            <p className="mt-3 max-w-[60ch] text-sm leading-7 text-[var(--color-text-muted)]">
              以婚禮分享愛心，賓客祝福化作救援能量。填寫表格，我們會與您聯絡安排感謝證書及小卡。
            </p>
            {primaryWedding?.document.fileUrl ? (
              <div className="mt-6 flex flex-wrap items-center gap-4">
                <a
                  href={primaryWedding.document.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary min-h-11"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  下載表格 / Download Form
                </a>
                {alternateWedding?.document.fileUrl ? (
                  <a
                    href={alternateWedding.document.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-[var(--color-primary)] underline underline-offset-4"
                  >
                    {alternateWedding.language === "en" ? "English form" : "中文表格"}
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="mt-5 text-sm text-[var(--color-text-muted)]">表格暫時未能提供。</p>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
