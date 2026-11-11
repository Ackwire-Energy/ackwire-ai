import {
  type Me,
  meQuery,
  type OrgSummary,
  useApi,
  useAuthConfig,
  useClosingMe,
  useComputerSetup,
  useRestoreAccount,
  useRestoreWorkspace,
} from "@agenteschat/client";
import { billingHoldOf } from "@agenteschat/client/lib/billing";
import { computerEdition } from "@agenteschat/client/lib/computer";
import {
  accountDeletingText,
  accountOutOfReach,
  deletedByText,
  deletingText,
  otherWorkspaces,
  restorable,
  workspaceLabel,
  workspaceNotes,
  workspaceOpens,
} from "@agenteschat/client/lib/deletion";
import { errorText, holdText, supportLineOf, suspendedText } from "@agenteschat/client/lib/errors";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { planHoldOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand, leadsWithPlan, rightHandOf } from "@agenteschat/client/lib/right-hand";
import type { FirstRunPowers } from "@agenteschat/client/lib/setup-checklist";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Button, Card, CardHeader, EmptyState, Icon, Spinner } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { DeleteAccountEntry } from "@/components/DeleteAccount";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePaidReturn } from "@/lib/paid-return";
import { useToast } from "@/lib/toast";

/**
 * The workspace's standing (ADR 0056 §8), as its people see it: on hold, a line at the top of the work area
 * (the reason only when the workspace is told one, else only that its agents are paused for review);
 * suspended, a screen of its own in place of the shell. Both say where to ask about it. `org.standing` events
 * move both live. A billing hold (ADR 0079) says what it is in its own words, and gives its owners and admins
 * the way to fix it on the billing service, except in the right hand's DM while its card leads with the plan, whose
 * row has that way (ADR 0162). A workspace being deleted gets a screen of its own too.
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

const PAID_POLL_MS = 5000;

/**
 * What the right hand's first-run rows may do for this person (`firstRunSteps`). Here, beside the hold's banner that
 * reads the card's plan row (`leadsWithPlan`), so the banner loads neither the card nor its rows' module: the root
 * route renders this file.
 */
export function useFirstRunPowers(): FirstRunPowers {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const setup = useComputerSetup(org.id);
  const may = stepPermissions(org, me.user.id, dir.agents);
  return {
    owner: org.role === "owner",
    configure: can(org, "configure"),
    createAgents: may.createAgents,
    connectAi: may.connectAi,
    pay: may.pay,
    connectors: can(org, "manage_connectors"),
    invite: may.invite,
    personal: isPersonal(org),
    // Waiting for its first plan (`usePlanHold`'s rule): a lapsed one keeps its rows, and this banner says the fix.
    waitsForPlan: planHoldOf(computerEdition(setup.data), org.standing) === "payment",
  };
}

export function HoldBanner() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const billingUrl = useAuthConfig().data?.billingUrl;
  const dir = useDirectory(org.id);
  const powers = useFirstRunPowers();
  const matchRoute = useMatchRoute();
  const billing = billingHoldOf(org.standing);
  const paid = usePaidReturn(org.id, billing !== null);
  // Back from paying, the billing service lifts the hold on its next pass: until `org.standing` says so, that's all.
  // An `org.standing` sent before this tab's socket opened is gone, so `/me` is asked again meanwhile.
  useQuery({ ...meQuery(useApi()), refetchInterval: billing && paid ? PAID_POLL_MS : false });
  const text = holdText(t, org.standing);
  if (!text) return null;
  if (billing && paid) {
    return (
      <section className="outages" aria-label={t("standing.label")}>
        <div className="outage hold-banner" role="status">
          <Spinner size={16} />
          <span className="outage__text">
            <b>{t("standing.billing.paid")}</b>
          </span>
        </div>
      </section>
    );
  }
  const admin = can(org, "manage_billing");
  const fix = admin && billingUrl ? billing : null;
  if (billing === "payment") {
    // Waiting for its first plan, nothing is lost: with only the right hand here, its own words say it.
    if (dir.loading || dir.agents.every(isRightHand)) return null;
    // In the right hand's DM its card leads with the plan, with the way to it: one button there, not two. Anywhere
    // else, and for whoever the card isn't for, the banner stays.
    const hand = rightHandOf(dir.agents);
    if (
      hand &&
      leadsWithPlan(hand, powers) &&
      matchRoute({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: hand.id } })
    )
      return null;
    return (
      <section className="outages" aria-label={t("standing.label")}>
        <div className="outage hold-banner" role="status">
          <span className="outage__text">
            <b>{t("standing.billing.teamReady")}</b>
            {!admin && <span>{t("standing.billing.askAdmin")}</span>}
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

/** Closed for now, why when told, where to ask, the person's other workspaces and Sair. */
export function SuspendedScreen({ org, me }: { org: OrgSummary; me: Me }) {
  const { t } = useTranslation();
  return (
    <div className="page page--mid suspended-page">
      <header className="page__header">
        <h1 className="page-title">{t("standing.screen.title")}</h1>
      </header>
      <EmptyState icon="lock" title={org.name} actions={<SignOutButton />}>
        {suspendedText(t, org.standing)}
        <SupportLine />
      </EmptyState>
      <OtherWorkspaces org={org} me={me} />
      <WholeAccount me={me} />
    </div>
  );
}

/**
 * Being deleted: that nothing more is needed and when it goes, who deleted it, and until then Restore for its owners
 * (the others read that only an owner can). Going to another workspace is the screen's main action. Its socket is
 * closed, so `GET /me` is asked again meanwhile: a restore opens the workspace, and once it's gone it leaves the list.
 */
export function DeletingScreen({ org, me }: { org: OrgSummary; me: Me }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const restore = useRestoreWorkspace(org.id);
  useClosingMe();
  const deletion = org.deletion;
  const owner = restorable(org);
  const due = !!deletion?.dueAt && Date.parse(deletion.dueAt) > Date.now();
  const by = deletion && deletedByText(t, i18n.language, deletion);
  const goesElsewhere = me.organizations.some((o) => o.id !== org.id && workspaceOpens(o));
  return (
    <div className="page page--mid suspended-page">
      <header className="page__header">
        <h1 className="page-title">{t("deleting.title", { name: org.name })}</h1>
      </header>
      <EmptyState
        icon="trash"
        actions={
          <>
            {owner && (
              <Button
                variant={goesElsewhere ? "default" : "primary"}
                loading={restore.isPending}
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate(undefined, {
                    onSuccess: () => toast.show(t("deleting.restored", { name: org.name })),
                  })
                }
              >
                {t("deleting.restore")}
              </Button>
            )}
            <SignOutButton />
          </>
        }
      >
        {deletion && deletingText(t, i18n.language, deletion)}
        {by && <span className="deleting-page__members">{by}</span>}
        {due && !owner && <span className="deleting-page__members">{t("deleting.membersOnly")}</span>}
      </EmptyState>
      <OtherWorkspaces org={org} me={me} create={me.user.canCreateWorkspace !== false} />
      <WholeAccount me={me} />
    </div>
  );
}

/**
 * The account was deleted and waits for its date: this screen in place of the whole app (`__root.tsx`), since no
 * workspace answers it. When it goes, Restaurar, and Sair. Past the date only the wait is left.
 */
export function AccountDeletingScreen({ dueAt }: { dueAt: string | null }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const restore = useRestoreAccount();
  const billing = Boolean(useAuthConfig().data?.billingUrl);
  useClosingMe();
  const due = !!dueAt && Date.parse(dueAt) > Date.now();
  return (
    <div className="page page--mid suspended-page">
      <header className="page__header">
        <h1 className="page-title">{t("accountDeleting.title")}</h1>
      </header>
      <EmptyState
        icon="trash"
        actions={
          <>
            {due && (
              <Button
                variant="primary"
                loading={restore.isPending}
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate(undefined, {
                    onSuccess: async () => {
                      toast.show(t("accountDeleting.restored"));
                      await navigate({ to: "/" });
                    },
                    onError: (error) => toast.show(errorText(t, error), "error"),
                  })
                }
              >
                {t("accountDeleting.restore")}
              </Button>
            )}
            <SignOutButton disabled={restore.isPending} />
          </>
        }
      >
        {accountDeletingText(t, i18n.language, dueAt)}
        {due && <span className="deleting-page__members">{t("accountDeleting.what")}</span>}
        {due && billing && <span className="deleting-page__members">{t("accountDeleting.plans")}</span>}
      </EmptyState>
    </div>
  );
}

/** Sair, from a workspace closed to its people: out of the account, to the sign-in. */
function SignOutButton({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <Button
      disabled={disabled}
      onClick={async () => {
        await auth.signOut();
        qc.clear();
        await navigate({ to: "/login" });
      }}
    >
      {t("auth.signOut")}
    </Button>
  );
}

/**
 * Deleting the account, only for someone with no workspace that opens: Sua conta isn't reachable from here for them,
 * and a person must always be able to delete their account (`accountOutOfReach`). Apart from this workspace's own
 * actions and under its own heading, so it can't be read as the way to delete the workspace on screen.
 */
function WholeAccount({ me }: { me: Me }) {
  const { t } = useTranslation();
  if (!accountOutOfReach(me.organizations)) return null;
  return (
    <Card aria-labelledby="closed-account" className="settings-danger suspended-page__account">
      <CardHeader
        id="closed-account"
        icon="trash"
        title={t("deleteAccount.whole")}
        subtitle={t("deleteAccount.card.text")}
        action={
          <DeleteAccountEntry
            trigger={(open) => (
              <Button size="sm" variant="danger" onClick={open}>
                {t("deleteAccount.card.button")}
              </Button>
            )}
          />
        }
      />
    </Card>
  );
}

/** The person's other workspaces to go to (none suspended), the first that opens as the main action; `create`: a new one. */
function OtherWorkspaces({ org, me, create = false }: { org: OrgSummary; me: Me; create?: boolean }) {
  const { t, i18n } = useTranslation();
  const others = otherWorkspaces(me.organizations, org.id);
  const notes = workspaceNotes(t, i18n.language, me.organizations);
  if (others.length === 0 && !create) return null;
  return (
    <nav className="suspended-page__others" aria-label={t("standing.screen.others")}>
      {others.length > 0 && <h2 className="ac-card__title">{t("standing.screen.others")}</h2>}
      {others.map((o, i) => (
        <Button key={o.id} asChild variant={i === 0 && workspaceOpens(o) ? "primary" : "default"}>
          <Link to="/org/$orgId" params={{ orgId: o.id }}>
            {workspaceLabel(o.name, notes.get(o.id))}
          </Link>
        </Button>
      ))}
      {create && (
        <Button variant="ghost" asChild>
          <Link to="/onboarding">
            <Icon name="plus" />
            {t("shell.newWorkspace")}
          </Link>
        </Button>
      )}
    </nav>
  );
}
