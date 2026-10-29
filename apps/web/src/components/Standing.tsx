import { type Me, type OrgSummary, useAuthConfig } from "@agenteschat/client";
import { holdText, supportLineOf, suspendedText } from "@agenteschat/client/lib/errors";
import { Button, EmptyState, Icon } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { useOrg } from "@/components/org-context";

/**
 * The workspace's standing (ADR 0056 §8), as its people see it: on hold, a line at the top of the work area
 * (the reason only when the workspace is told one, else only that its agents are paused for review);
 * suspended, a screen of its own in place of the shell. Both say where to ask about it. `org.standing` events
 * move both live.
 */

/** "Precisa de ajuda? Escreva para …", or to ask who runs the server, as `supportLineOf` says. */
export function SupportLine() {
  const { t } = useTranslation();
  const line = supportLineOf(useAuthConfig().data);
  if (!line) return null;
  return (
    <span className="support-line">
      {line === "ask" ? (
        t("support.ask")
      ) : (
        <>
          {t("support.writeBefore")}
          <a href={`mailto:${line.email}`}>{line.email}</a>
          {t("support.writeAfter")}
        </>
      )}
    </span>
  );
}

export function HoldBanner() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const text = holdText(t, org.standing);
  if (!text) return null;
  return (
    <section className="outages" aria-label={t("standing.label")}>
      <div className="outage hold-banner" role="status">
        <Icon name="pause" size={20} className="outage__icon" />
        <span className="outage__text">
          <b>{text}</b>
          <span>{t("standing.bannerSub")}</span>
          <SupportLine />
        </span>
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
        {suspendedText(t, org.standing)}
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
