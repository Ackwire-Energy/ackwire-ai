import type { AiAccounts as AiAccountsView } from "@agenteschat/client";
import { keys, useAiAccounts, useAiStatus, useApi, useMachines } from "@agenteschat/client";
import {
  accountTitle,
  agentsToGive,
  endsOnClaude,
  groupPlans,
  identityUnknown,
  offersSignInAgain,
  onSeveralComputers,
  ownSignIns,
  ownSignInTitle,
  type PlanAccount,
  unusedCopies,
} from "@agenteschat/client/lib/ai-accounts";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentAi, aiStateOf } from "@agenteschat/client/lib/no-ai";
import { isPlanId, planOf, signInProviderOf } from "@agenteschat/client/lib/plans";
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  PlanMeter,
  ProviderLogo,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectAi, useMayConnectAi } from "@/components/ConnectAi";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { planMeterText } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { AddAccount } from "./AddAccountFlow";
import { PlanHold, usePlanHold } from "./ConnectAiSteps";

/*
 * Configurações › Contas de IA, "Seus planos" (ADR 0059): the viewer's own
 * accounts on every computer, each with its plan's meter and the agents it
 * thinks for, its logins (one per agent) in one row; renamed, signed in again
 * (a new key for a coding plan, to every login), given to one more agent where
 * it thinks for all of them (`shared`) or disconnected here. First, the
 * sign-ins of the computers they connected ("Conta deste computador"): the
 * agents there think with them, so they are plans too. Never blank: with none,
 * one way to connect one.
 */

type Row = AiAccountsView["accounts"][number];
type Open = { type: "rename" | "again" | "remove"; account: PlanAccount<Row> };

export function AiAccountsSection() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiAccounts(org.id);
  const machines = useMachines(org.id);
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connectAi = useConnectAi();
  const hold = usePlanHold();
  const mayConnect = useMayConnectAi();
  const look = useRightHandLook();
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  const rows = ai.data?.accounts ?? [];
  const accounts = groupPlans(rows);
  const own = ownSignIns(ai.data);
  const several = onSeveralComputers(rows);
  const names = (list: string[]) => joinNames(list, t);
  const meterText = planMeterText(t, i18n.language);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.aiAccounts(org.id) });
  // The same picker as everywhere an AI is connected, from the card's head as Provider keys' Add key is.
  // Under a hold its lines say what comes first: an invitation to connect a plan would contradict them.
  const noPlans = !hold && ai.isSuccess && rows.length === 0 && own.length === 0;
  const connect = connectAi && (
    <Button size="sm" icon="plus" onClick={() => connectAi.open({})}>
      {t("aiAccounts.page.connect")}
    </Button>
  );

  // One more of the person's agents thinks with an account made for all of them there: no sign-in.
  const giveTo = async (a: Row, agent: { id: string; name: string }) => {
    try {
      await api.agents.setBrain(org.id, agent.id, { brain: a.kind, account: a.id });
      toast.show(t("aiAccounts.done.savedAgent", { agent: agent.name, label: a.label }));
      refetch();
      for (const key of [keys.agents(org.id), keys.aiStatus(org.id), keys.agentBrain(org.id, agent.id)])
        void qc.invalidateQueries({ queryKey: key });
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    }
  };
  const toGive = (a: Row) =>
    agentsToGive({
      account: a,
      agents: dir.agents,
      machine: machines.data?.find((m) => m.id === a.machineId),
      viewerId: me.user.id,
      onKey: (id) => agentAi(dir.agentById.get(id), aiStateOf(status.data, id)) === "key",
    });

  // Every login of the account goes.
  const remove = async (account: PlanAccount<Row>) => {
    setBusy(true);
    try {
      for (const a of account.logins) await api.machines.removeAccount(org.id, a.machineId, a.id);
      toast.show(t("aiAccounts.page.disconnected", { label: account.logins[0]?.label ?? "" }));
      setOpen(null);
      refetch();
      void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  // The logins of an account that think for no agent, each a sign-in made again: they go, its agents stay as they are.
  const removeCopies = async (copies: Row[]) => {
    setBusy(true);
    try {
      for (const a of copies) await api.machines.removeAccount(org.id, a.machineId, a.id);
      toast.show(t("aiAccounts.page.copiesRemoved", { count: copies.length }));
      refetch();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card aria-labelledby="sec-plans">
      <CardHeader
        id="sec-plans"
        icon="computer"
        title={t("aiAccounts.page.title")}
        hint={{ name: t("common.about", { label: t("aiAccounts.page.title") }), text: t("aiAccounts.page.hint") }}
        action={!noPlans && !hold && connect}
      />
      {hold && <PlanHold hold={hold} />}
      {ai.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {ai.isError && <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote>}
      {noPlans && (
        <EmptyState
          size="panel"
          agent={look}
          title={t("aiAccounts.page.emptyTitle")}
          actions={
            connectAi &&
            mayConnect && (
              <Button variant="primary" icon="plus" onClick={() => connectAi.open({})}>
                {t("aiAccounts.page.connect")}
              </Button>
            )
          }
        >
          {t(mayConnect ? "aiAccounts.page.empty" : "aiAccounts.page.emptyViewer")}
        </EmptyState>
      )}
      {own.length > 0 && (
        <List>
          {own.map((o) => (
            <div key={o.key} className="ac-list__row ai-accounts__row">
              <ProviderLogo id={o.kind} size="sm" />
              <span className="list-col">
                <span className="ai-accounts__name ac-captop">{ownSignInTitle(t, o)}</span>
                <span className="small muted">{t("aiAccounts.page.ownOn", { computer: o.computer })}</span>
                {o.usage && <PlanMeter usage={o.usage} text={meterText} compact />}
              </span>
            </div>
          ))}
        </List>
      )}
      {accounts.length > 0 && (
        <List>
          {accounts.map((account) => {
            const { logins, usedBy, usage, signedOut, unknown } = account;
            const a = logins.find((l) => l.shared === true) ?? logins[0];
            if (!a) return null;
            const give = toGive(a);
            const copies = unusedCopies(account);
            const plan = planOf(a.provider);
            const allOut = signedOut.length === logins.length;
            // Of an account with a login per agent, the agents whose login is out.
            const outFor = allOut ? [] : signedOut.flatMap((l) => l.usedBy);
            const machine = machines.data?.find((m) => m.id === a.machineId);
            const facts = [
              a.email ??
                (a.keyHint
                  ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
                  : identityUnknown(a, machine)
                    ? t("aiAccounts.page.identityUnknown")
                    : null),
              several ? t("aiAccounts.page.on", { computer: computerNameOf(t, org.name, a.computer) }) : null,
              usedBy.length > 0
                ? t("aiAccounts.page.usedBy", { count: usedBy.length, agents: names(usedBy) })
                : t("aiAccounts.page.noAgent"),
            ].filter(Boolean);
            return (
              <div key={account.key} className="ac-list__row ai-accounts__row">
                <ProviderLogo id={a.provider ?? a.kind} size="sm" off={allOut} />
                <span className="list-col">
                  <span className="ai-accounts__name ac-captop">{accountTitle(a)}</span>
                  <span className="small muted">{facts.join(" · ")}</span>
                  {signedOut.length > 0 && (
                    <SettingNote icon="alert">
                      {outFor.length > 0
                        ? t("aiAccounts.page.signedOutFor", { count: outFor.length, agents: names(outFor) })
                        : plan
                          ? t("aiAccounts.page.keyRefused")
                          : t("aiAccounts.page.signedOut")}
                    </SettingNote>
                  )}
                  {signedOut.length === 0 && unknown.length > 0 && (
                    <SettingNote icon="info">{t("aiAccounts.page.statusUnknown")}</SettingNote>
                  )}
                  {copies.length > 0 && (
                    <span className="ai-panel__row">
                      <SettingNote icon="repeat">{t("aiAccounts.page.copies", { count: copies.length })}</SettingNote>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy}
                        disabled={busy}
                        onClick={() => void removeCopies(copies)}
                      >
                        {t("aiAccounts.page.removeCopies")}
                      </Button>
                    </span>
                  )}
                  {usage ? (
                    <PlanMeter usage={usage} text={meterText} compact />
                  ) : (
                    plan &&
                    !plan.usage && (
                      <span className="small muted">{t("aiAccounts.usage.notShared", { maker: plan.maker })}</span>
                    )
                  )}
                </span>
                <div className="ac-acts ac-captail ac-captop">
                  {give.length === 1 && give[0] ? (
                    <Button variant="ghost" size="sm" onClick={() => give[0] && void giveTo(a, give[0])}>
                      {t("aiAccounts.page.useFor", agentGrammar(give[0].name))}
                    </Button>
                  ) : (
                    give.length > 1 && (
                      <Menu
                        label={t("aiAccounts.page.useForMenu")}
                        trigger={
                          <Button variant="ghost" size="sm">
                            {t("aiAccounts.page.useForMenu")}
                          </Button>
                        }
                      >
                        {give.map((g) => (
                          <MenuItem key={g.id} onSelect={() => void giveTo(a, g)}>
                            {g.name}
                          </MenuItem>
                        ))}
                      </Menu>
                    )
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setOpen({ type: "rename", account })}>
                    {t("aiAccounts.page.rename")}
                  </Button>
                  {(logins.some(offersSignInAgain) || plan) && (
                    <Button variant="ghost" size="sm" onClick={() => setOpen({ type: "again", account })}>
                      {plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ac-btn--danger"
                    onClick={() => setOpen({ type: "remove", account })}
                  >
                    {t("aiAccounts.page.disconnect")}
                  </Button>
                </div>
              </div>
            );
          })}
        </List>
      )}

      {open?.type === "rename" && open.account.logins[0] && (
        <RenameDialog
          account={open.account.logins[0]}
          onClose={() => setOpen(null)}
          onSaved={(label) => {
            toast.show(t("aiAccounts.page.renamed", { label }));
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open?.type === "again" && (
        <AgainDialog
          account={open.account}
          local={ai.data?.computers.find((c) => c.machineId === open.account.logins[0]?.machineId)?.mine}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open?.type === "remove" && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={t("aiAccounts.page.disconnectTitle", { label: open.account.logins[0]?.label ?? "" })}
          description={[
            open.account.usedBy.length > 0
              ? t("aiAccounts.page.disconnectAgents", {
                  count: open.account.usedBy.length,
                  agents: names(open.account.usedBy),
                  computer: computerNameOf(t, org.name, open.account.logins[0]?.computer ?? ""),
                })
              : t("aiAccounts.page.disconnectNone", {
                  computer: computerNameOf(t, org.name, open.account.logins[0]?.computer ?? ""),
                }),
            ...(open.account.logins.some((l) =>
              endsOnClaude(
                l,
                machines.data?.find((m) => m.id === l.machineId),
              ),
            )
              ? [t("aiAccounts.page.revokeOnClaude")]
              : []),
          ].join(" ")}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button onClick={() => setOpen(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={busy} disabled={busy} onClick={() => void remove(open.account)}>
              {t("aiAccounts.page.disconnect")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </Card>
  );
}

/**
 * Signing in again: a coding plan's new key goes to every login of the account, a sign-in to its first login out
 * (else one unchecked, else its first). Closes once each login took it.
 */
function AgainDialog({
  account,
  local,
  onClose,
  onDone,
}: {
  account: PlanAccount<Row>;
  local: boolean | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const hold = usePlanHold();
  const added = useRef(new Set<string>());
  const a = account.signedOut[0] ?? account.unknown[0] ?? account.logins[0];
  if (!a) return null;
  const key = isPlanId(a.provider);
  const fanOut = key ? account.logins.map((l) => ({ id: l.id, again: l.id })) : undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={a.label} closeLabel={t("common.close")} width={520}>
      <DialogBody>
        {hold ? (
          <PlanHold hold={hold} />
        ) : (
          <AddAccount
            machineId={a.machineId}
            kind={a.kind}
            computer={a.computer}
            again={a.id}
            email={a.email}
            local={local}
            {...(signInProviderOf(a.provider) ? { provider: signInProviderOf(a.provider) } : {})}
            {...(fanOut ? { fanOut } : {})}
            onBack={onClose}
            onAdded={(_, login) => {
              added.current.add(login ?? a.id);
              if (added.current.size >= (fanOut?.length ?? 1)) onDone();
            }}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}

function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: Row;
  onClose: () => void;
  onSaved: (label: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const name = label.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("aiAccounts.page.renameTitle", { label: account.label })}
      closeLabel={t("common.close")}
      width={420}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name || busy) return;
          setBusy(true);
          api.machines.renameAccount(org.id, account.machineId, account.id, name).then(
            () => onSaved(name),
            () => {
              toast.show(t("agentPage.work.failed"), "error");
              setBusy(false);
            },
          );
        }}
      >
        <Locked when={busy}>
          <DialogBody>
            <Field label={t("aiAccounts.page.nameLabel")} id="ai-rename" help={t("aiAccounts.done.name")}>
              <Input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name || name === account.label}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
