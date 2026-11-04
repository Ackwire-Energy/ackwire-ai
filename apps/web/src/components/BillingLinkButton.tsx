import { type BillingFrom, useApi } from "@agenteschat/client";
import { Button, type ButtonProps } from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * Mints the workspace's billing link and leaves for it (ADR 0079), saying `billing.failed` when it can't. The link
 * goes nowhere but the address bar: it opens once and lasts minutes. The billing service sends the person back to
 * the page they opened it from.
 */
export function useOpenBilling(orgId: string, from: BillingFrom) {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const here = useRouterState({ select: (s) => s.location.href });
  return useMutation({
    mutationFn: () => api.orgs.billingLink(orgId, from, here),
    onSuccess: ({ url }) => navigateAway(url),
    onError: () => toast.show(t("billing.failed"), "error"),
    meta: { silent: true },
  });
}

/** Opens the workspace's plan and billing on the billing service, signed in, minted on the click. */
export function BillingLinkButton({
  orgId,
  from,
  children,
  ...button
}: { orgId: string; from: BillingFrom } & Omit<ButtonProps, "onClick" | "loading">) {
  const open = useOpenBilling(orgId, from);
  return (
    <Button {...button} loading={open.isPending} onClick={() => open.mutate()}>
      {children}
    </Button>
  );
}
