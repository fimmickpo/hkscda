import { z } from "zod";

import { publicDonationStatuses, type PublicDonationStatus } from "./publicStatus";

export type ReceiptStatus =
  | "not_requested"
  | "pending"
  | "issued"
  | "failed"
  | "void"
  | "unavailable";
export type NotificationStatus =
  | "not_required"
  | "pending"
  | "provider_accepted"
  | "delivered"
  | "failed"
  | "unavailable";
export type DonationEffectStatuses = {
  receiptStatus: ReceiptStatus;
  notificationStatus: NotificationStatus;
};

export type PublicDonationStatusRepository = {
  refreshPendingCod?: (donationId: string) => Promise<unknown>;
  refreshPendingPayMe?: (donationId: string) => Promise<unknown>;
  findStatus: (donationId: string) => Promise<PublicDonationStatus | null>;
  findEffects?: (
    donationId: string,
    status: PublicDonationStatus,
  ) => Promise<DonationEffectStatuses>;
};

export type PublicDonationStatusResult = {
  status: PublicDonationStatus;
  paymentStatus: PublicDonationStatus;
} & DonationEffectStatuses;

const donationIdSchema = z.string().uuid();

export async function loadPublicDonationStatus({
  donationId,
  repository,
}: {
  donationId: string;
  repository: PublicDonationStatusRepository;
}): Promise<PublicDonationStatusResult | null> {
  if (!donationIdSchema.safeParse(donationId).success) return null;

  try {
    await Promise.all([
      repository.refreshPendingCod?.(donationId),
      repository.refreshPendingPayMe?.(donationId),
    ]);
  } catch {
    // Refresh is best-effort. A provider or database timeout must not invent a
    // terminal state or hide the last locally committed donation status.
  }

  const status = await repository.findStatus(donationId);
  if (!status || !publicDonationStatuses.includes(status)) return null;
  let effects: DonationEffectStatuses = {
    receiptStatus: "unavailable",
    notificationStatus: "unavailable",
  };
  try {
    effects = (await repository.findEffects?.(donationId, status)) ?? effects;
  } catch {
    // Keep the committed payment state even if receipt or notification reads fail.
  }
  return {
    status,
    paymentStatus: status,
    receiptStatus: effects.receiptStatus,
    notificationStatus: effects.notificationStatus,
  };
}
