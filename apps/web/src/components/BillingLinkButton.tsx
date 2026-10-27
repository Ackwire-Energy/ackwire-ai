import { type BillingFrom, useApi } from "@agenteschat/client";
import { Button, type ButtonProps } from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * Opens the workspace's plan and billing on the billing service, signed in (ADR 0071). The link is minted on
 * the click and goes nowhere but the address bar: it opens once and lasts minutes.
 */
export function BillingLinkButton({
  orgId,
  from,
  children,
  ...button
}: { orgId: string; from: BillingFrom } & Omit<ButtonProps, "onClick" | "loading">) {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const open = useMutation({
    mutationFn: () => api.orgs.billingLink(orgId, from),
    onSuccess: ({ url }) => navigateAway(url),
    onError: () => toast.show(t("billing.failed"), "error"),
    meta: { silent: true },
  });
  return (
    <Button {...button} loading={open.isPending} onClick={() => open.mutate()}>
      {children}
    </Button>
  );
}
