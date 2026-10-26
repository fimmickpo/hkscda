import { describe, expect, test } from "bun:test";

import { loadPublicDonationStatus } from "./publicStatus.server";

describe("public donation status", () => {
  test("returns only payment state", async () => {
    const result = await loadPublicDonationStatus({
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      repository: { findStatus: async () => "succeeded" },
    });

    expect(result).toEqual({
      status: "succeeded",
      paymentStatus: "succeeded",
      receiptStatus: "unavailable",
      notificationStatus: "unavailable",
    });
  });

  test("public status exposes only payment and effect states", async () => {
    const result = await loadPublicDonationStatus({
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      repository: {
        findStatus: async () => "succeeded",
        findEffects: async () =>
          ({
            receiptStatus: "pending",
            notificationStatus: "failed",
            privateEmail: "secret@example.invalid",
          }) as never,
      },
    });
    expect(result).toEqual({
      status: "succeeded",
      paymentStatus: "succeeded",
      receiptStatus: "pending",
      notificationStatus: "failed",
    });
  });

  test("hides invalid and missing donations", async () => {
    expect(
      await loadPublicDonationStatus({
        donationId: "invalid",
        repository: { findStatus: async () => "succeeded" },
      }),
    ).toBeNull();
    expect(
      await loadPublicDonationStatus({
        donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
        repository: { findStatus: async () => null },
      }),
    ).toBeNull();
  });

  test("refreshes pending COD only after UUID validation and before reading status", async () => {
    const calls: string[] = [];
    const repository = {
      refreshPendingCod: async () => {
        calls.push("refresh");
      },
      findStatus: async () => {
        calls.push("find");
        return "succeeded" as const;
      },
    };

    await loadPublicDonationStatus({
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      repository,
    });
    expect(calls).toEqual(["refresh", "find"]);

    calls.length = 0;
    await loadPublicDonationStatus({ donationId: "invalid", repository });
    expect(calls).toEqual([]);
  });

  test("continues with the local status when COD refresh is unavailable", async () => {
    const result = await loadPublicDonationStatus({
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      repository: {
        refreshPendingCod: async () => {
          throw new Error("COD unavailable");
        },
        findStatus: async () => "pending",
      },
    });

    expect(result).toEqual({
      status: "pending",
      paymentStatus: "pending",
      receiptStatus: "unavailable",
      notificationStatus: "unavailable",
    });
  });

  test("succeeded payment survives receipt or acknowledgement failure", async () => {
    const result = await loadPublicDonationStatus({
      donationId: "f8dce8fa-83f4-4d5f-b0b0-fbc3348efb7a",
      repository: {
        refreshPendingCod: async () => {
          throw new Error("acknowledgement retry failed");
        },
        findStatus: async () => "succeeded",
      },
    });

    expect(result?.status).toBe("succeeded");
    expect(result?.paymentStatus).toBe("succeeded");
  });

  test("calls refreshPendingPayMe before reading status", async () => {
    let called = false;
    const result = await loadPublicDonationStatus({
      donationId: "11111111-1111-4111-8111-111111111111",
      repository: {
        refreshPendingPayMe: async () => {
          called = true;
        },
        findStatus: async () => "succeeded",
      },
    });
    expect(called).toBe(true);
    expect(result?.status).toBe("succeeded");
    expect(result?.paymentStatus).toBe("succeeded");
  });

  test("a refreshPendingPayMe failure is swallowed and the committed status is returned", async () => {
    const result = await loadPublicDonationStatus({
      donationId: "11111111-1111-4111-8111-111111111111",
      repository: {
        refreshPendingPayMe: async () => {
          throw new Error("payme timeout");
        },
        findStatus: async () => "succeeded",
      },
    });
    expect(result?.status).toBe("succeeded");
    expect(result?.paymentStatus).toBe("succeeded");
  });
});
