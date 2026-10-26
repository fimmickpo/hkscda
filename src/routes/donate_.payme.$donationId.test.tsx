import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));

mock.module("../components/site/PayMePayCodePage", () => ({
  PayMePayCodePage: ({ donationId }: { donationId: string }) => <p>donation:{donationId}</p>,
}));

describe("PayMe PayCode route", () => {
  test("hands the donation id from the address to the PayCode page", async () => {
    const { PayMePayCodeRouteView } = await import("./donate_.payme.$donationId");
    const markup = renderToStaticMarkup(<PayMePayCodeRouteView donationId="abc-123" />);

    expect(markup).toContain("donation:abc-123");
  });

  test("is a private page: titled, kept out of search, and sends no referrer", async () => {
    const { Route } = await import("./donate_.payme.$donationId");
    const head = (Route as unknown as { head: () => { meta: Record<string, string>[] } }).head();

    expect(head.meta[0].title).toContain("PayMe 付款");
    expect(head.meta).toContainEqual({ name: "robots", content: "noindex, nofollow, noarchive" });
    expect(head.meta).toContainEqual({ name: "referrer", content: "no-referrer" });
  });

  test("sits beside /donate, not under it, because /donate has no outlet for a child route", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./donate_.payme.$donationId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('createFileRoute("/donate_/payme/$donationId")');
  });
});
