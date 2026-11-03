import type { Agent } from "@agenteschat/client";
import { useCredentials, useModels, usePlatformKey, useUpdateAgent } from "@agenteschat/client";
import { audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { handleAfterRename } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { AUTO, modelChoices } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { AffixInput, Button, Card, CardFooter, CardHeader, Dialog, Input } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LookRows, ModelSelect, modelOptions } from "@/components/AgentFields";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { fullLook, lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * Configurações › Workspace › Lodi (ADR 0134): only what admins set for the team's right hand. Its name and look, its
 * AI and model, its own monthly budget and who may use it, each saved as it changes; one line says it can't be
 * archived or deleted, and its audit log is a click away. Its instructions are the product's.
 */
export function RightHandSettingsSection() {
  const { org } = useOrg();
  const agent = useDirectory(org.id).agents.find(isRightHand);
  return agent ? <RightHandForm agent={agent} /> : null;
}

function RightHandForm({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const [name, setName] = useState(agent.name);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const [looking, setLooking] = useState(false);
  const [look, setLook] = useState(() => fullLook(lookOf(agent)));
  const g = agentGrammar(agent.name);
  const label = t("rightHand.label");
  const save = (patch: Parameters<typeof update.mutate>[0], onSuccess?: () => void) =>
    update.mutate(patch, { onSuccess, onError: (e) => toast.show(errorText(t, e), "error") });
  const rename = () => {
    const next = name.trim();
    if (!next || next === agent.name) return setName(agent.name);
    save({ name: next, handle: handleAfterRename(agent, next) });
  };
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      return toast.show(t("agent.budgetInvalid"), "error");
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  const list = modelOptions(
    t,
    i18n.language,
    modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
  );
  return (
    <>
      <Card>
        <div className="settings-rows">
          <PrefRow
            id="rh-name"
            icon="agent"
            label={t("rightHand.settings.name")}
            help={t("rightHand.settings.nameHelp", { ...g, label })}
            control={
              <span className="rh-set__name">
                <AgentAvatar agentId={agent.id} name={agent.name} size="md" />
                <Input
                  aria-label={t("rightHand.settings.name")}
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <Button size="sm" icon="edit" onClick={() => setLooking(true)}>
                  {t("rightHand.settings.changeLook")}
                </Button>
              </span>
            }
          />
          <PrefRow
            id="rh-ai"
            icon="bulb"
            label={t("rightHand.settings.ai")}
            help={t("rightHand.settings.aiHelp")}
            control={
              <ModelSelect
                className="rh-set__model"
                aria-label={t("rightHand.settings.ai")}
                value={agent.model}
                onChange={(model) => model !== agent.model && save({ model })}
                options={[
                  { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") },
                  ...(agent.model === AUTO || list.some((o) => o.value === agent.model)
                    ? []
                    : [{ value: agent.model, label: agent.model }]),
                  ...list,
                ]}
              />
            }
          />
          <PrefRow
            id="rh-budget"
            icon="wallet"
            label={t("rightHand.settings.budget")}
            help={t("rightHand.settings.budgetHelp", g)}
            control={
              <span className="rh-set__budget">
                <AffixInput
                  aria-label={t("rightHand.settings.budget")}
                  prefix="US$"
                  inputMode="decimal"
                  value={budget}
                  placeholder={t("rightHand.value.budgetDefault")}
                  onChange={(e) => setBudget(e.target.value)}
                  onBlur={saveBudget}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <span className="muted">{t("rightHand.settings.perMonth")}</span>
              </span>
            }
          />
        </div>
      </Card>
      <Card aria-labelledby="rh-audience">
        <CardHeader
          id="rh-audience"
          icon="audiencePeople"
          title={t("rightHand.settings.audience")}
          subtitle={t("rightHand.settings.audienceHelp", g)}
        />
        <div className="rh-set__audience">
          <AudienceChoice
            value={audienceOf(agent)}
            onChange={(next) => save({ audience: audiencePatch(next) })}
            ownerUserId={agent.ownerUserId}
            agentName={agent.name}
            idPrefix="rh-audience"
          />
        </div>
        <CardFooter icon="lock">
          {t("rightHand.settings.lock", g)}{" "}
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "audit" }}
            search={{ agent: agent.id }}
          >
            {t("rightHand.settings.audit", g)}
          </Link>
        </CardFooter>
      </Card>
      <Dialog
        open={looking}
        onOpenChange={setLooking}
        title={t("rightHand.settings.changeLook")}
        closeLabel={t("common.close")}
        width={480}
      >
        <span className="rh-set__face">
          <AgentAvatar name={agent.name} appearance={look} size="lg" />
        </span>
        <LookRows look={look} onChange={setLook} />
        <div className="rh-set__acts">
          <Button variant="ghost" onClick={() => setLooking(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => save({ appearance: look }, () => setLooking(false))}
          >
            {t("common.save")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
