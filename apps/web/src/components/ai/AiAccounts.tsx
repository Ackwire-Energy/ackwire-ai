import type { AiAccounts as AiAccountsView } from "@agenteschat/client";
import { keys, useAiAccounts, useApi } from "@agenteschat/client";
import { isPlanId, planOf } from "@agenteschat/client/lib/plans";
import {
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  List,
  PlanMeter,
  ProviderLogo,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectAi } from "@/components/ConnectAi";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { planMeterText } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { AddAccount } from "./AddAccountFlow";

/*
 * Configurações › Contas de IA, "Seus planos" (ADR 0059): the viewer's own
 * accounts on every computer, each with its plan's meter and the agent it
 * thinks for; renamed, signed in again (a new key for a coding plan) or
 * disconnected here. Never blank: with none, one way to connect one.
 */

type Row = AiAccountsView["accounts"][number];
type Open = { type: "rename" | "again" | "remove"; account: Row };

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
  const several = new Set(rows.map((r) => r.machineId)).size > 1;
  const meterText = planMeterText(t, i18n.language);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.aiAccounts(org.id) });
  // The same picker as everywhere an AI is connected.
  const connect = connectAi && (
    <Button size="sm" variant={rows.length ? "default" : "primary"} icon="plus" onClick={() => connectAi.open({})}>
      {t("aiAccounts.page.connect")}
    </Button>
  );

  const remove = async (a: Row) => {
    setBusy(true);
    try {
      await api.machines.removeAccount(org.id, a.machineId, a.id);
      toast.show(t("aiAccounts.page.disconnected", { label: a.label }));
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
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-plans" className="ac-card__title">
            {t("aiAccounts.page.title")}
          </h2>
          <span className="small muted">{t("aiAccounts.page.text")}</span>
        </div>
        {rows.length > 0 && connect}
      </div>
      {ai.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {ai.isError && <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote>}
      {ai.isSuccess && rows.length === 0 && (
        <div className="ai-accounts__empty">
          <p className="small muted">{t("aiAccounts.page.empty")}</p>
          {connect}
        </div>
      )}
      {rows.length > 0 && (
        <List>
          {rows.map((a) => {
            const plan = planOf(a.provider);
            const out = a.status === "signed_out";
            const facts = [
              a.email ?? (a.keyHint ? t("aiAccounts.page.keyEnds", { hint: a.keyHint }) : null),
              several ? t("aiAccounts.page.on", { computer: a.computer }) : null,
              a.usedBy[0] ? t("aiAccounts.page.thinksFor", { agent: a.usedBy[0] }) : t("aiAccounts.page.noAgent"),
            ].filter(Boolean);
            return (
              <div key={a.id} className="ac-list__row ai-accounts__row">
                <ProviderLogo id={a.provider ?? a.kind} size="sm" off={out} />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>{a.label}</span>
                  <span className="small muted">{facts.join(" · ")}</span>
                  {out && (
                    <SettingNote icon="alert">
                      {plan ? t("aiAccounts.page.keyRefused") : t("aiAccounts.page.signedOut")}
                    </SettingNote>
                  )}
                  {a.usage ? (
                    <PlanMeter usage={a.usage} text={meterText} compact />
                  ) : (
                    plan &&
                    !plan.usage && (
                      <span className="small muted">{t("aiAccounts.usage.notShared", { maker: plan.maker })}</span>
                    )
                  )}
                </span>
                <div className="row" style={{ gap: 4 }}>
                  <Button variant="ghost" size="sm" onClick={() => setOpen({ type: "rename", account: a })}>
                    {t("aiAccounts.page.rename")}
                  </Button>
                  {(out || plan) && (
                    <Button variant="ghost" size="sm" onClick={() => setOpen({ type: "again", account: a })}>
                      {plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ac-btn--danger"
                    onClick={() => setOpen({ type: "remove", account: a })}
                  >
                    {t("aiAccounts.page.disconnect")}
                  </Button>
                </div>
              </div>
            );
          })}
        </List>
      )}
      {rows.length > 0 && <p className="small muted">{t("aiAccounts.page.where")}</p>}

      {open?.type === "rename" && (
        <RenameDialog
          account={open.account}
          onClose={() => setOpen(null)}
          onSaved={(label) => {
            toast.show(t("aiAccounts.page.renamed", { label }));
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open?.type === "again" && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={open.account.label}
          closeLabel={t("common.close")}
          width={520}
        >
          <DialogBody>
            <AddAccount
              machineId={open.account.machineId}
              kind={open.account.kind}
              computer={open.account.computer}
              again={open.account.id}
              email={open.account.email}
              local={ai.data?.computers.find((c) => c.machineId === open.account.machineId)?.mine}
              {...(isPlanId(open.account.provider) ? { provider: open.account.provider } : {})}
              onBack={() => setOpen(null)}
              onAdded={() => {
                setOpen(null);
                refetch();
              }}
            />
          </DialogBody>
        </Dialog>
      )}
      {open?.type === "remove" && (
        <Dialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={t("aiAccounts.page.disconnectTitle", { label: open.account.label })}
          description={
            open.account.usedBy[0]
              ? t("aiAccounts.page.disconnectAgent", { agent: open.account.usedBy[0], computer: open.account.computer })
              : t("aiAccounts.page.disconnectNone", { computer: open.account.computer })
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
