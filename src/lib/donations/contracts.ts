export const donationPurposes = ["general", "medical", "sponsor"] as const;
export const donationMethods = ["stripe", "payme", "fps", "paypal", "alipayhk"] as const;
export const donationLanguages = ["zh-HK", "en"] as const;
export const donationContexts = [
  "general",
  "story",
  "animal",
  "sponsor",
  "transparency",
  "community",
] as const;
export const donationPlacements = ["mobile-bottom", "desktop-left"] as const;
export const donationTriggers = ["scroll", "timer"] as const;

export type DonationPurpose = (typeof donationPurposes)[number];
export type DonationMethod = (typeof donationMethods)[number];
export type CheckoutExperience = "wap" | "desktop_qr";
export type PaymentProvider = Exclude<DonationMethod, "alipayhk"> | "manual" | "cod";
export type OnlinePaymentProvider = "stripe" | "paypal" | "cod" | "payme";
export type DonationLanguage = (typeof donationLanguages)[number];
export type DonationContext = (typeof donationContexts)[number];
export type DonationPlacement = (typeof donationPlacements)[number];
export type DonationTrigger = (typeof donationTriggers)[number];
