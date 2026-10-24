import type { AiComputer, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAiAccounts, useApi, useMachines } from "@agenteschat/client";
import { CODING_PLANS, PLAN_IDS, type PlanId } from "@agenteschat/client/lib/plans";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  ProviderLogo,
  Select,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { AddAccount } from "./AddAccountFlow";

/*
 * "Conectar uma IA" (ADR 0058): what to bring (a Claude or ChatGPT plan, or a
 * coding plan's key), on which of the caller's computers when more than one
 * can take it, the provider's own sign-in (`AddAccount`), then its name and
 * the agent it thinks for.
 */

export interface ConnectChoice {
  kind: MachineAccountKind;
  provider?: PlanId;
}

const CHOICES: ConnectChoice[] = [
  { kind: "claude_code" },
  { kind: "codex" },
  ...PLAN_IDS.map((provider) => ({ kind: "claude_code" as const, provider })),
];

const choiceId = (c: ConnectChoice) => c.provider ?? c.kind;
/** A computer that can take this choice now: the caller adds accounts there, it runs the CLI, and it is on. */
const takes = (c: AiComputer, choice: ConnectChoice) =>
  c.canAdd && c.online && c.brains[choice.kind] && (!choice.provider || c.keys);
/** Why no computer takes it (null when one does). */
function blocker(computers: AiComputer[], choice: ConnectChoice): "claude_code" | "codex" | "keys" | "online" | null {
  if (computers.some((c) => takes(c, choice))) return null;
  const mine = computers.filter((c) => c.canAdd);
  if (!mine.some((c) => c.brains[choice.kind])) return choice.kind;
  if (choice.provider && !mine.some((c) => c.brains[choice.kind] && c.keys)) return "keys";
  return "online";
}

const NONE = "__none";

export function ConnectAiDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const ai = useAiAccounts(org.id);
  const [choice, setChoice] = useState<ConnectChoice | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [added, setAdded] = useState<MachineAccount | null>(null);
  const computers = ai.data?.computers ?? [];
  const fit = choice ? computers.filter((c) => takes(c, choice)) : [];
  const computer = fit.find((c) => c.machineId === machineId) ?? (fit.length === 1 ? fit[0] : undefined);
  const name = (c: ConnectChoice) => (c.provider ? CODING_PLANS[c.provider].label : t(`aiAccounts.connect.${c.kind}`));

  let body: ReactNode;
  if (!ai.data) {
    body = (
      <DialogBody>
        {ai.isError ? <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote> : <Spinner />}
      </DialogBody>
    );
  } else if (!computers.some((c) => c.canAdd)) {
    body = (
      <DialogBody>
        <SettingNote icon="computer">{t("aiAccounts.connect.noComputer")}</SettingNote>
        <Button asChild size="sm" variant="primary">
          <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "computers" }} onClick={onClose}>
            {t("aiAccounts.connect.addComputer")}
          </Link>
        </Button>
      </DialogBody>
    );
  } else if (!choice) {
    body = (
      <DialogBody>
        <div className="ai-connect__choices">
          {CHOICES.map((c) => {
            const why = blocker(computers, c);
            return (
              <button
                key={choiceId(c)}
                type="button"
                className="ac-option"
                disabled={why !== null}
                onClick={() => setChoice(c)}
              >
                <ProviderLogo id={choiceId(c)} size="sm" off={why !== null} />
                <span className="ac-option__text">
                  <span className="ac-option__title">{name(c)}</span>
                  <span className="ac-option__desc">
                    {why
                      ? t(`aiAccounts.connect.needs.${why}`)
                      : c.provider
                        ? t("aiAccounts.connect.keyText")
                        : t(`aiAccounts.connect.${c.kind}Text`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogBody>
    );
  } else if (!computer) {
    body = (
      <>
        <DialogBody>
          <fieldset className="ai-connect__choices">
            <legend>{t("aiAccounts.connect.computer")}</legend>
            {fit.map((c) => (
              <button key={c.machineId} type="button" className="ac-option" onClick={() => setMachineId(c.machineId)}>
                <span className="ac-option__text">
                  <span className="ac-option__title">{c.name}</span>
                </span>
              </button>
            ))}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setChoice(null)}>{t("common.back")}</Button>
        </DialogFooter>
      </>
    );
  } else if (!added) {
    body = (
      <DialogBody>
        <AddAccount
          machineId={computer.machineId}
          kind={choice.kind}
          computer={computer.name}
          {...(choice.provider ? { provider: choice.provider } : {})}
          onBack={() => {
            setMachineId(null);
            setChoice(null);
          }}
          onAdded={setAdded}
        />
      </DialogBody>
    );
  } else {
    body = <FinishAccount account={added} computer={computer} onDone={onClose} />;
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("aiAccounts.connect.title")}
      description={t("aiAccounts.connect.sub")}
      closeLabel={t("common.close")}
      width={520}
      className="ai-connect"
    >
      {body}
    </Dialog>
  );
}

/** The last step: what people call it, and the caller's agent on that computer it thinks for (or none yet). */
function FinishAccount({
  account,
  computer,
  onDone,
}: {
  account: MachineAccount;
  computer: AiComputer;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const machines = useMachines(org.id);
  const mine = (machines.data?.find((m) => m.id === computer.machineId)?.agents ?? []).filter(
    (a) => dir.agentById.get(a.id)?.ownerUserId === me.user.id,
  );
  const [label, setLabel] = useState(account.label);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = agentId ?? (mine.length === 1 ? (mine[0]?.id ?? NONE) : NONE);
  const finish = async () => {
    setBusy(true);
    try {
      const name = label.trim();
      if (name && name !== account.label)
        await api.machines.renameAccount(org.id, computer.machineId, account.id, name);
      const agent = mine.find((a) => a.id === chosen);
      if (agent) {
        await api.agents.setBrain(org.id, agent.id, { brain: account.kind, account: account.id });
        void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) });
        void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
      }
      void qc.invalidateQueries({ queryKey: keys.aiAccounts(org.id) });
      const shown = name || account.label;
      toast.show(
        agent
          ? t("aiAccounts.done.savedAgent", { agent: agent.name, label: shown })
          : t("aiAccounts.done.saved", { label: shown }),
      );
      onDone();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
      setBusy(false);
    }
  };
  return (
    <>
      <DialogBody>
        <SettingNote icon="check" live>
          {t("aiAccounts.done.title", { label: account.label, computer: computer.name })}
        </SettingNote>
        <Field label={t("aiAccounts.done.name")} id="ai-done-name">
          <Input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {mine.length > 0 ? (
          <Field label={t("aiAccounts.done.agent")} id="ai-done-agent">
            <Select
              aria-label={t("aiAccounts.done.agent")}
              value={chosen}
              onValueChange={setAgentId}
              options={[
                ...mine.map((a) => ({ value: a.id, label: a.name })),
                { value: NONE, label: t("aiAccounts.done.noAgent") },
              ]}
            />
          </Field>
        ) : (
          <p className="small muted">{t("aiAccounts.done.noAgents", { computer: computer.name })}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => void finish()}>
          {t("aiAccounts.done.finish")}
        </Button>
      </DialogFooter>
    </>
  );
}
