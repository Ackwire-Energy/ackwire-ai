import { useAuthConfig } from "@agenteschat/client";
import { planOfferOf } from "@agenteschat/client/lib/billing";
import { useQuery } from "@tanstack/react-query";

/**
 * The plan the onboarding offers, read by the browser from the billing service's public plan list in the person's
 * language: this server never names a plan nor a price (ADR 0079 §6). Null without a billing service, while it loads,
 * and when the list can't be read: the onboarding then names no plan.
 */
export function usePlanOffer(locale: string) {
  const billingUrl = useAuthConfig().data?.billingUrl ?? null;
  return (
    useQuery({
      queryKey: ["planOffer", billingUrl, locale],
      queryFn: async () => {
        const res = await fetch(`${billingUrl?.replace(/\/+$/, "")}/plans.json?locale=${encodeURIComponent(locale)}`);
        return res.ok ? planOfferOf(await res.json()) : null;
      },
      enabled: billingUrl !== null,
      retry: 0,
      staleTime: 10 * 60_000,
    }).data ?? null
  );
}
