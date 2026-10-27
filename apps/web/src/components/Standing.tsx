import { type Me, type OrgSummary, useAuthConfig } from "@agenteschat/client";
import { billingHoldOf } from "@agenteschat/client/lib/billing";
import { holdText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, EmptyState, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { useOrg } from "@/components/org-context";

/**
 * The workspace's standing (ADR 0056 §8), as its people see it: on hold, a line at the top of the work area
 * (the reason only when the workspace is told one, else only that its agents are paused for review);
 * suspended, a screen of its own in place of the shell. Both say where to ask about it. `org.standing` events
 * move both live. A billing hold (ADR 0077) says what it is in its own words, and gives its owners and admins
 * the way to fix it on the billing service.
 */

/** "Precisa de ajuda? Escreva para …" when the server says where (`SUPPORT_EMAIL`), else to ask who runs it. */
export function SupportLine() {
  const { t } = useTranslation();
  const email = useAuthConfig().data?.supportEmail;
  return (
    <span className="support-line">
      {email ? (
        <>
          {t("support.writeBefore")}
          <a href={`mailto:${email}`}>{email}</a>
          {t("support.writeAfter")}
        </>
      ) : (
        t("support.ask")
      )}
    </span>
  );
}

export function HoldBanner() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const billingUrl = useAuthConfig().data?.billingUrl;
  const text = holdText(t, org.standing);
  if (!text) return null;
  const billing = billingHoldOf(org.standing);
  const admin = can(org.role, "manage_billing");
  const fix = admin && billingUrl ? billing : null;
  return (
    <section className="outages" aria-label={t("standing.label")}>
      <div className="outage hold-banner" role="status">
        <Icon name="pause" size={20} className="outage__icon" />
        <span className="outage__text">
          <b>{text}</b>
          <span>{t(billing ? "standing.billing.sub" : "standing.bannerSub")}</span>
          {billing && !admin ? <span>{t("standing.billing.askAdmin")}</span> : !fix && <SupportLine />}
        </span>
        {fix && (
          <span className="outage__acts">
            <BillingLinkButton orgId={org.id} from="hold" size="sm" variant="primary">
              {t(`standing.billing.cta.${fix}`)}
            </BillingLinkButton>
          </span>
        )}
      </div>
    </section>
  );
}

/** Closed for now, why when told, where to ask, the person's other workspaces, and Sair. */
export function SuspendedScreen({ org, me }: { org: OrgSummary; me: Me }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const reason = org.standing?.reason;
  const others = me.organizations.filter((o) => o.id !== org.id && o.standing?.state !== "suspended");
  return (
    <div className="page page--mid suspended-page">
      <header className="page__header">
        <h1 className="page-title">{t("standing.screen.title")}</h1>
      </header>
      <EmptyState
        icon="lock"
        title={org.name}
        actions={
          <Button
            onClick={async () => {
              await auth.signOut();
              qc.clear();
              await navigate({ to: "/login" });
            }}
          >
            {t("auth.signOut")}
          </Button>
        }
      >
        {reason ? t("standing.suspendedFor", { reason }) : t("standing.screen.text")}
        <SupportLine />
      </EmptyState>
      {others.length > 0 && (
        <nav className="suspended-page__others" aria-label={t("standing.screen.others")}>
          <h2 className="ac-card__title">{t("standing.screen.others")}</h2>
          {others.map((o) => (
            <Button key={o.id} asChild>
              <Link to="/org/$orgId" params={{ orgId: o.id }}>
                {o.name}
              </Link>
            </Button>
          ))}
        </nav>
      )}
    </div>
  );
}
