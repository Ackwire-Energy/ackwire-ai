import type { AiAccounts as AiAccountsView } from "@agenteschat/client";
import { keys, useAiAccounts, useApi } from "@agenteschat/client";
import { accountTitle, groupPlans, ownSignIns, type PlanAccount } from "@agenteschat/client/lib/ai-accounts";
import { joinNames } from "@agenteschat/client/lib/format";
import { isPlanId, planOf } from "@agenteschat/client/lib/plans";
import {
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  InfoHint,
  Input,
  List,
  PlanMeter,
  ProviderLogo,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectAi } from "@/components/ConnectAi";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { planMeterText } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { AddAccount } from "./AddAccountFlow";

/*
 * Configurações › Contas de IA, "Seus planos" (ADR 0059): the viewer's own
 * accounts on every computer, each with its plan's meter and the agents it
 * thinks for, its logins (one per agent) in one row; renamed, signed in again
 * (a new key for a coding plan, to every login) or disconnected here. First, the
 * sign-ins of the computers they connected ("Conta deste computador"): the
 * agents there think with them, so they are plans too. Never blank: with none,
 * one way to connect one.
 */

type Row = AiAccountsView["accounts"][number];
type Open = { type: "rename" | "again" | "remove"; account: PlanAccount<Row> };

export function AiAccountsSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiAccounts(org.id);
  const connectAi = useConnectAi();
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  const rows = ai.data?.accounts ?? [];
  const accounts = groupPlans(rows);
  const own = ownSignIns(ai.data);
  const several = new Set(rows.map((r) => r.machineId)).size > 1;
  const names = (list: string[]) => joinNames(list, t("newAgent.and"));
  const meterText = planMeterText(t, i18n.language);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.aiAccounts(org.id) });
  // The same picker as everywhere an AI is connected, from the card's head as Provider keys' Add key is.
  const connect = connectAi && (
    <Button size="sm" icon="plus" onClick={() => connectAi.open({})}>
      {t("aiAccounts.page.connect")}
    </Button>
  );

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

  return (
    <Card aria-labelledby="sec-plans">
      <div className="row" style={{ gap: 12 }}>
        <span className="ac-hintline" style={{ flex: "1 1 280px" }}>
          <h2 id="sec-plans" className="ac-card__title">
            {t("aiAccounts.page.title")}
          </h2>
          <InfoHint name={t("common.about", { label: t("aiAccounts.page.title") })}>
            {t("aiAccounts.page.hint")}
          </InfoHint>
        </span>
        {connect}
      </div>
      {ai.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {ai.isError && <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote>}
      {ai.isSuccess && rows.length === 0 && own.length === 0 && (
        <p className="small muted">{t("aiAccounts.page.empty")}</p>
      )}
      {own.length > 0 && (
        <List>
          {own.map((o) => (
            <div key={o.key} className="ac-list__row ai-accounts__row">
              <ProviderLogo id={o.kind} size="sm" />
              <span className="list-col">
                <span className="ai-accounts__name ac-captop">
                  {accountTitle({ label: t(`aiAccounts.connect.${o.kind}`), plan: o.plan })}
                </span>
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
            const { logins, usedBy, usage, signedOut } = account;
            const a = logins[0];
            if (!a) return null;
            const plan = planOf(a.provider);
            const allOut = signedOut.length === logins.length;
            // Of an account with a login per agent, the agents whose login is out.
            const outFor = allOut ? [] : signedOut.flatMap((l) => l.usedBy);
            const facts = [
              a.email ?? (a.keyHint ? t("aiAccounts.page.keyEnds", { hint: a.keyHint }) : null),
              several ? t("aiAccounts.page.on", { computer: a.computer }) : null,
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
                  {usage ? (
                    <PlanMeter usage={usage} text={meterText} compact />
                  ) : (
                    plan &&
                    !plan.usage && (
                      <span className="small muted">{t("aiAccounts.usage.notShared", { maker: plan.maker })}</span>
                    )
                  )}
                </span>
                <div className="ac-acts">
                  <Button variant="ghost" size="sm" onClick={() => setOpen({ type: "rename", account })}>
                    {t("aiAccounts.page.rename")}
                  </Button>
                  {(signedOut.length > 0 || plan) && (
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
          description={
            open.account.usedBy.length > 0
              ? t("aiAccounts.page.disconnectAgents", {
                  count: open.account.usedBy.length,
                  agents: names(open.account.usedBy),
                  computer: open.account.logins[0]?.computer ?? "",
                })
              : t("aiAccounts.page.disconnectNone", { computer: open.account.logins[0]?.computer ?? "" })
          }
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
 * (else its first). Closes once each login took it.
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
  const added = useRef(new Set<string>());
  const a = account.signedOut[0] ?? account.logins[0];
  if (!a) return null;
  const key = isPlanId(a.provider);
  const fanOut = key ? account.logins.map((l) => ({ id: l.id, again: l.id })) : undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={a.label} closeLabel={t("common.close")} width={520}>
      <DialogBody>
        <AddAccount
          machineId={a.machineId}
          kind={a.kind}
          computer={a.computer}
          again={a.id}
          email={a.email}
          local={local}
          {...(isPlanId(a.provider) ? { provider: a.provider } : {})}
          {...(fanOut ? { fanOut } : {})}
          onBack={onClose}
          onAdded={(_, login) => {
            added.current.add(login ?? a.id);
            if (added.current.size >= (fanOut?.length ?? 1)) onDone();
          }}
        />
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
        <DialogBody>
          <Field label={t("aiAccounts.page.nameLabel")} id="ai-rename" help={t("aiAccounts.done.name")}>
            <Input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </DialogBody>
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
