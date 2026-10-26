import type { CheckoutExperience } from "./contracts";
import { payCodePagePath } from "./payme-paycode";

type RedirectingResult =
  | { kind: "payme"; donationId: string; appLink: string }
  | { kind: "redirect"; donationId: string; provider: string; url: string };

/**
 * Where the donor goes once the server has set up a checkout that happens off the donation form.
 * (A manual FPS checkout never leaves it: its payment instructions are shown there.)
 *
 * PayMe differs by device: a phone opens the PayMe app through the app link, while a desktop goes to
 * the PayCode page, which draws a QR code for the donor to scan with their phone.
 */
export function checkoutDestination(
  result: RedirectingResult,
  experience: CheckoutExperience,
): string {
  const onPhone = experience === "wap";
  if (result.kind === "payme") return onPhone ? result.appLink : payCodePagePath(result.donationId);
  // Resubmitting a PayMe checkout whose PayCode is still payable comes back as a redirect to the
  // stored web link. That link is what the QR code encodes, not a page to open on a desktop.
  if (result.provider === "payme" && !onPhone) return payCodePagePath(result.donationId);
  return result.url;
}
