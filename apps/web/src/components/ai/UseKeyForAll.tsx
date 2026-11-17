import type { AgentSetup, AiAccounts as AiAccountsView } from "@agenteschat/client";
import { keys, useApi, useSetupPreview } from "@agenteschat/client";
import { setupOutcome, takers } from "@agenteschat/client/lib/agent-setup";
import { type KeyModel, keyModelFirst, keyModelGroups } from "@agenteschat/client/lib/brain-picker";
import { type CodingPlan, planOf } from "@agenteschat/client/lib/plans";
import { providerLabel } from "@agenteschat/client/lib/providers";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Locked,
  OptionList,
  type OptionListItem,
  ProviderLogo,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

type Row = AiAccountsView["accounts"][number];

/** How many faces the "Todos os agentes" row shows before it stops. */
const FACES = 5;

/**
 * "Usar em todos os agentes" on a coding plan key's row: one of the key's models, in runs by what the key did with
 * each (`keyModelGroups`), for every agent that may take it (the server's preview), saved like "Usar em outros
 * agentes" (`applySetup`), which also makes it what new agents start with. `model`: the one it starts on (a reply's
 * stand-in), when the key may run it.
 */
export function UseKeyForAll({ account, model, onClose }: { account: Row; model?: string; onClose: () => void }) {
  const plan = planOf(account.provider);
  return plan ? <KeyForAllDialog account={account} plan={plan} preferred={model} onClose={onClose} /> : null;
}

function KeyForAllDialog({
  account,
  plan,
  preferred,
  onClose,
}: {
  account: Row;
  plan: CodingPlan;
  preferred: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const groups = keyModelGroups(plan, account.usage);
  const [model, setModel] = useState(() => keyModelFirst(groups, preferred));
  const [all, setAll] = useState(true);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(groups.works.length === 0 || groups.untested.some((m) => m.value === model));
  const chosen = [...groups.works, ...groups.untested].find((m) => m.value === model);
  const setup: AgentSetup = {
    brain: account.kind,
    machineId: account.machineId,
    account: account.id,
    model: model || null,
  };
  const agentIds = dir.agents.map((a) => a.id);
  const preview = useSetupPreview(org.id, model ? setup : null, agentIds);
  const can = takers(preview.data ?? []);
  const maker = plan.maker;
  const option = (m: KeyModel, line: string): OptionListItem<string> => ({
    value: m.value,
    title: m.label,
    ...(m.textOnly ? { tag: t("aiAccounts.page.textOnly") } : {}),
    description: line,
    ...(m.refused ? { disabled: true } : {}),
  });
  const list = (rows: KeyModel[], line: (m: KeyModel) => string, label: string) =>
    rows.length > 0 && (
      <OptionList
        aria-label={label}
        value={model}
        onValueChange={setModel}
        options={rows.map((m) => option(m, line(m)))}
      />
    );
  const makerOf = (m: KeyModel) => (m.maker ? providerLabel(m.maker) : maker);
  const use = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const results = await api.agents.applySetup(org.id, { setup, agentIds: can });
      const { done, missed } = setupOutcome(results, can.length);
      if (done > 0) toast.show(t("aiAccounts.page.useAllDone", { count: done, model: chosen.label }));
      if (missed > 0) toast.show(t("aiAccounts.page.useAllMissed", { count: missed }), "error");
      for (const key of [keys.agents(org.id), keys.aiStatus(org.id), keys.aiAccounts(org.id)])
        void qc.invalidateQueries({ queryKey: key });
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  const faces = can.slice(0, FACES).flatMap((id) => dir.agentById.get(id) ?? []);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={t("aiAccounts.page.useAllTitle", { plan: plan.label })}
      description={t("aiAccounts.page.useAllSub")}
      leading={<ProviderLogo id={account.provider ?? account.kind} />}
      closeLabel={t("common.close")}
      width={520}
      className="ai-keyall"
    >
      <Locked when={busy}>
        <DialogBody className="ai-keyall__body">
          {groups.works.length > 0 && (
            <section className="ai-keyall__group">
              <h3 className="ai-keyall__label">{t("aiAccounts.page.useAllWorks")}</h3>
              {list(groups.works, () => t("aiAccounts.page.useAllAnswered"), t("aiAccounts.page.useAllWorks"))}
            </section>
          )}
          {groups.refused.length > 0 && (
            <section className="ai-keyall__group">
              <h3 className="ai-keyall__label">{t("aiAccounts.page.useAllRefused")}</h3>
              {list(
                groups.refused,
                (m) =>
                  m.refused === "region"
                    ? t("aiAccounts.page.useAllRegion", { maker })
                    : t("aiAccounts.page.useAllOff", { maker }),
                t("aiAccounts.page.useAllRefused"),
              )}
            </section>
          )}
          {groups.untested.length > 0 && (
            <section className="ai-keyall__group">
              <button
                type="button"
                className="ai-keyall__more"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(!moreOpen)}
              >
                <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={16} />
                {t("aiAccounts.page.useAllUntested", { count: groups.untested.length })}
              </button>
              {moreOpen &&
                list(groups.untested, makerOf, t("aiAccounts.page.useAllUntested", { count: groups.untested.length }))}
            </section>
          )}
          {preview.isPending && model ? (
            <LoadingLine width={220} />
          ) : (
            <label htmlFor="keyall-all" className="agp-copydialog__all" data-off={can.length === 0 || undefined}>
              <Checkbox
                id="keyall-all"
                checked={all && can.length > 0}
                disabled={can.length === 0}
                onCheckedChange={setAll}
              />
              <span className="scope-row__text">
                <b>{t("aiAccounts.page.useAllAgents")}</b>
                <span className="small muted">
                  {can.length === 0
                    ? t("aiAccounts.page.useAllNone")
                    : t("aiAccounts.page.useAllAgentsLine", { count: can.length })}
                </span>
              </span>
              {faces.length > 0 && (
                <span className="ai-keyall__faces" aria-hidden="true">
                  {faces.map((a) => (
                    <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="sm" />
                  ))}
                </span>
              )}
            </label>
          )}
          {chosen?.textOnly && (
            <SettingNote icon="info">{t("aiAccounts.page.useAllTextOnly", { model: chosen.label })}</SettingNote>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button disabled={busy} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!chosen || !all || can.length === 0}
          onClick={() => void use()}
        >
          {chosen ? t("aiAccounts.page.useAllGo", { count: can.length }) : t("aiAccounts.page.useAllPick")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
