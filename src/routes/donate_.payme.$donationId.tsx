import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/pageHead";

import { PayMePayCodePage } from "../components/site/PayMePayCodePage";

// `donate_` keeps this page out from under /donate, which has no <Outlet />. The address carries the
// donation id that only the donor holds, so the page is private: noindex and no referrer.
export const Route = createFileRoute("/donate_/payme/$donationId")({
  head: () => pageHead({ title: "PayMe 付款", private: true }),
  component: PayMePayCodeRoute,
});

function PayMePayCodeRoute() {
  const { donationId } = Route.useParams();
  return <PayMePayCodeRouteView donationId={donationId} />;
}

export function PayMePayCodeRouteView({ donationId }: { donationId: string }) {
  return <PayMePayCodePage donationId={donationId} />;
}
