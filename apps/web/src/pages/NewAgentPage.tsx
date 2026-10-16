import {
  Button,
  Card,
  CheckboxPill,
  EmptyState,
  Field,
  Input,
  OptionCard,
  Select,
  type SelectOption,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import {
  useChannels,
  useCreateAgent,
  useCredentials,
  useDms,
  useMembers,
  useModels,
  usePlatformKey,
  useSettings,
  useSkills,
} from "@/api/queries";
import type { Agent, AgentAudience, Credential, Model } from "@/api/types";
import { LevelRow, ResourceIcon, useConnectedById } from "@/components/AccessLevels";
import { AudienceChoice, audienceValid } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { SkillPicker } from "@/components/Skills";
import { LEVELS, type Level, saveLevels } from "@/lib/access-levels";
import { itemName } from "@/lib/connected";
import { formatUsd, joinNames } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { can } from "@/lib/permissions";
import { modelChoices, providerLabel } from "@/lib/providers";
import { handleFrom, parseAmount } from "@/lib/text";

/** Select value for "Sem responsável" (the API takes `ownerUserId: null`). */
export const NO_OWNER = "__none__";

export const ROLE_IDS = ["dev", "ops", "qa", "pm", "custom"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** Model descriptions of the approved screen, by model family. */
export function modelDescription(t: TFunction, locale: string, model: Model) {
  const id = model.id.toLowerCase();
  if (id.includes("sonnet")) return t("newAgent.modelDesc.sonnet");
  if (id.includes("opus")) return t("newAgent.modelDesc.opus");
  if (id.includes("haiku")) return t("newAgent.modelDesc.haiku");
  const fmt = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  return t("newAgent.modelDesc.other", { input: fmt(model.inputUsdPerMTok), output: fmt(model.outputUsdPerMTok) });
}

/** Value of the "Chave padrão do workspace" option (the API takes `credentialId: null`). */
export const DEFAULT_KEY = "__default__";

/**
 * Key choices: the workspace default first (with its masked hint), then the
 * other stored keys.
 */
export function keyOptions(t: TFunction, credentials: Credential[], defaultId: string | null): SelectOption[] {
  const live = credentials.filter((c) => !c.revokedAt);
  const def = live.find((c) => c.id === defaultId);
  return [
    {
      value: DEFAULT_KEY,
      label: t("newAgent.defaultKey"),
      description: def
        ? t("newAgent.defaultKeyDesc", { provider: providerLabel(def.provider), hint: def.keyHint })
        : undefined,
    },
    ...live
      .filter((c) => c.id !== defaultId)
      .map((c) => ({
        value: c.id,
        label: c.label,
        description: t("newAgent.otherKeyDesc", { provider: providerLabel(c.provider), hint: c.keyHint }),
      })),
  ];
}

/** Models grouped by provider; those without a key are disabled and say why. */
export function modelOptions(
  t: TFunction,
  locale: string,
  models: Model[],
  credentials: Credential[],
  platform: boolean,
): SelectOption[] {
  return modelChoices(models, credentials, platform).flatMap(([provider, choices]) =>
    choices.map(({ model, available }) => ({
      value: model.id,
      label: model.label,
      group: providerLabel(provider),
      disabled: !available,
      description: available
        ? modelDescription(t, locale, model)
        : t("newAgent.modelNeedsKey", { provider: providerLabel(provider) }),
    })),
  );
}

/**
 * Starting level of each connection on "Criar agente": "Ler" for the
 * organization's own connectors (Drive starts off), nothing for servers
 * connected by address. Sensitive actions ask for approval at any level.
 */
export function defaultLevel(item: { custom: boolean; def: { id: string } | null }): Level {
  if (item.custom) return "none";
  return item.def?.id === "drive" ? "none" : "read";
}

/** telas/NovoAgente.dc.html */
export function NewAgentPage() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const allowed = can(org.role, "manage_agents");
  const members = useMembers(org.id);
  const models = useModels();
  const credentials = useCredentials(org.id, allowed);
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const dmChannels = useMemo(() => new Set((dms.data ?? []).map((d) => d.channelId)), [dms.data]);
  // What the agent can use: one level per connection (the same levels as the agent page).
  const connected = useConnectedById();
  const connectedList = useMemo(() => [...connected.values()], [connected]);
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const create = useCreateAgent(org.id);
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);

  const [role, setRole] = useState<RoleId>("qa");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(me.user.id);
  const [audience, setAudience] = useState<AgentAudience>({ mode: "everyone", userIds: [] });
  const [instructions, setInstructions] = useState(t("newAgent.roles.qa.instructions"));
  const [model, setModel] = useState<string | undefined>(undefined);
  const [key, setKey] = useState<string | undefined>(undefined);
  // Empty = the workspace default budget (every agent has one).
  const [budget, setBudget] = useState("");
  const [on, setOn] = useState<Record<string, boolean>>({});
  // "Skills" (optional): only when the library exists and has something.
  const library = useSkills(org.id);
  const [skillIds, setSkillIds] = useState<Set<string> | null>(null);
  // Skills marked "Ligar em agentes novos" start checked.
  useEffect(() => {
    if (library.data && skillIds === null)
      setSkillIds(new Set(library.data.filter((s) => s.defaultForNewAgents).map((s) => s.id)));
  }, [library.data, skillIds]);
  const [created, setCreated] = useState<{ agent: Agent; channels: { id: string; name: string }[] } | null>(null);

  const myChannels = useMemo(
    () => (channels.data ?? []).filter((c) => c.isMember && !dmChannels.has(c.id)),
    [channels.data, dmChannels],
  );
  useEffect(() => {
    if (model || !models.data || !credentials.data) return;
    // The deployment's default, unless the workspace has no key for its provider.
    const usable = modelOptions(t, i18n.language, models.data.models, credentials.data, platform.data ?? false).filter(
      (o) => !o.disabled,
    );
    setModel(
      usable.find((o) => o.value === models.data.defaultModel)?.value ?? usable[0]?.value ?? models.data.defaultModel,
    );
  }, [model, models.data, credentials.data, platform.data, t, i18n.language]);
  useEffect(() => {
    if (!key) setKey(DEFAULT_KEY);
  }, [key]);
  useEffect(() => {
    // Defaults like the screen: the channels you're in, and reading the connectors.
    setOn((prev) => {
      const next = { ...prev };
      for (const c of myChannels) if (next[`ch:${c.id}`] === undefined) next[`ch:${c.id}`] = c.name !== "general";
      return next;
    });
    setLevels((prev) => {
      const next = { ...prev };
      for (const item of connectedList) next[item.id] ??= defaultLevel(item);
      return next;
    });
  }, [myChannels, connectedList]);

  if (!allowed) {
    return (
      <div className="page page--narrow">
        <header className="page__header">
          <h1 className="page-title">{t("newAgent.title")}</h1>
        </header>
        <EmptyState icon="agent">{t("newAgent.adminsOnly", { org: org.name })}</EmptyState>
      </div>
    );
  }

  const displayName = name.trim() || t("newAgent.defaultName");
  const handle = handleFrom(name.trim() || t("newAgent.defaultName"));
  const amount = budget.trim() === "" ? null : parseAmount(budget);
  const budgetInvalid = amount !== null && !(amount > 0);
  const defaultBudget = settings.data?.defaultAgentBudgetUsd;
  const cannotCreate = budgetInvalid || !name.trim() || create.isPending;

  const pickRole = (id: RoleId) => {
    setRole(id);
    setInstructions(t(`newAgent.roles.${id}.instructions`));
  };

  const submit = async () => {
    if (cannotCreate) return;
    const agent = await create.mutateAsync({
      name: name.trim(),
      handle,
      role: role === "custom" ? "" : t(`newAgent.roles.${role}.name`),
      instructions,
      model,
      ownerUserId: owner === NO_OWNER ? null : owner,
      audience: audienceValid(audience, owner === NO_OWNER ? null : owner)
        ? { mode: audience.mode, userIds: audience.mode === "people" ? audience.userIds : [] }
        : { mode: "everyone", userIds: [] },
      credentialId: key && key !== DEFAULT_KEY ? key : null,
      monthlyBudgetUsd: amount,
    });
    const joined = myChannels.filter((c) => on[`ch:${c.id}`]);
    if (joined.length > 0) {
      await api.agents.setChannels(
        org.id,
        agent.id,
        joined.map((c) => ({ channelId: c.id })),
      );
    }
    // New agents start with the built-in defaults; the chosen connector levels go on top, in one
    // write that reads the agent's grants first (nothing written afterwards replaces them).
    const chosen = Object.fromEntries(
      connectedList
        .filter((item) => (levels[item.id] ?? "none") !== "none")
        .map((item) => [`connector:${item.id}`, levels[item.id] as Level]),
    );
    if (Object.keys(chosen).length > 0) await saveLevels(api, org.id, agent.id, chosen);
    const libraryList = library.data ?? [];
    if (libraryList.length > 0) {
      await api.skills.setForAgent(
        org.id,
        agent.id,
        libraryList.map((s) => ({ skillId: s.id, enabled: skillIds?.has(s.id) ?? s.defaultForNewAgents })),
      );
    }
    setCreated({ agent, channels: joined.map((c) => ({ id: c.id, name: c.name })) });
  };

  if (created) {
    const first = created.channels[0];
    const names = joinNames(
      created.channels.map((c) => `#${c.name}`),
      t("newAgent.and"),
    );
    return (
      <div className="page page--narrow">
        <Card padded as="div" style={{ alignItems: "flex-start", gap: 16 }}>
          <AgentAvatar agent={created.agent} size="lg" name={created.agent.name} running />
          <h1 className="page-title">{t("newAgent.createdTitle", { name: created.agent.name })}</h1>
          <p className="page-sub" style={{ maxWidth: "60ch" }}>
            {created.channels.length > 0
              ? t("newAgent.createdText", { channels: names, handle: created.agent.handle })
              : t("newAgent.createdTextNoChannels", { name: created.agent.name, handle: created.agent.handle })}
          </p>
          <div className="row">
            {first ? (
              <Button asChild variant="primary">
                <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: first.id }}>
                  {t("newAgent.goTo", { channel: first.name })}
                </Link>
              </Button>
            ) : (
              <Button asChild variant="primary">
                <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: created.agent.id }}>
                  {t("newAgent.openProfile")}
                </Link>
              </Button>
            )}
            <Button
              onClick={() => {
                setCreated(null);
                setName("");
              }}
            >
              {t("newAgent.createAnother")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const ownerOptions: SelectOption[] = [
    ...(members.data ?? []).map((m) => ({ value: m.userId, label: m.name, description: t(`roles.${m.role}`) })),
    { value: NO_OWNER, label: t("newAgent.noOwnerOption"), description: t("newAgent.noOwnerHelp") },
  ];
  const modelSelect = modelOptions(
    t,
    i18n.language,
    models.data?.models ?? [],
    credentials.data ?? [],
    platform.data ?? false,
  );
  const toggles = myChannels.map((c) => ({ id: `ch:${c.id}`, label: `#${c.name}` }));

  return (
    <div className="page page--narrow">
      <header className="page__header">
        <h1 className="page-title">{t("newAgent.title")}</h1>
        <p className="page-sub">{t("newAgent.subtitle")}</p>
      </header>

      <section aria-labelledby="q-role" className="section">
        <h2 id="q-role" className="section-title">
          {t("newAgent.roleQuestion")}
        </h2>
        <div className="grid-options grid-options--sm">
          {ROLE_IDS.map((id) => (
            <OptionCard key={id} agent stacked pressed={role === id} onClick={() => pickRole(id)}>
              <span className="ac-option__title">{t(`newAgent.roles.${id}.name`)}</span>
              <span className="ac-option__desc">{t(`newAgent.roles.${id}.desc`)}</span>
            </OptionCard>
          ))}
        </div>
      </section>

      <section aria-labelledby="q-who" className="section" style={{ gap: 16 }}>
        <h2 id="q-who" className="section-title">
          {t("newAgent.who")}
        </h2>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <AgentAvatar size="lg" name={displayName} />
          <div className="grid-fields" style={{ flex: 1 }}>
            <Field label={t("newAgent.name")} id="ag-name" help={t("newAgent.nameHelp", { handle })}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("newAgent.namePlaceholder")}
              />
            </Field>
            <Field
              label={t("newAgent.owner")}
              id="ag-owner"
              help={owner === NO_OWNER ? t("newAgent.noOwnerHelp") : t("newAgent.ownerHelp")}
            >
              <Select value={owner} onValueChange={setOwner} options={ownerOptions} />
            </Field>
          </div>
        </div>
        <div className="stack-4" style={{ gap: 8 }}>
          <span className="ac-field__label">{t("audience.title", agentGrammar(t, displayName))}</span>
          <AudienceChoice
            value={audience}
            onChange={setAudience}
            ownerUserId={owner === NO_OWNER ? null : owner}
            agentName={displayName}
            idPrefix="ag-audience"
          />
        </div>
        <Field label={t("newAgent.instructions")} id="ag-instr" help={t("newAgent.instructionsHelp")}>
          <Textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
      </section>

      <section aria-labelledby="q-model" className="section">
        <h2 id="q-model" className="section-title">
          {t("newAgent.modelAndCost")}
        </h2>
        <div className="grid-fields">
          <Field label={t("newAgent.model")} id="ag-model">
            <Select value={model} onValueChange={setModel} options={modelSelect} />
          </Field>
          <Field label={t("newAgent.key")} id="ag-key">
            <Select
              value={key}
              onValueChange={setKey}
              options={keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null)}
              placeholder={t("newAgent.noKeys")}
            />
          </Field>
          <Field
            label={t("newAgent.budget")}
            id="ag-budget"
            error={budgetInvalid ? t("newAgent.budgetInvalid") : undefined}
            help={[
              defaultBudget === undefined
                ? t("agent.budgetDefaultHelp")
                : t("agent.budgetDefaultHelpAmount", { amount: formatUsd(t, i18n.language, defaultBudget) }),
              t("newAgent.budgetHelp"),
            ].join(" ")}
          >
            <Input
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder={
                defaultBudget === undefined ? undefined : new Intl.NumberFormat(i18n.language).format(defaultBudget)
              }
            />
          </Field>
        </div>
      </section>

      <section aria-labelledby="q-where" className="section">
        <h2 id="q-where" className="section-title">
          {t("newAgent.where")}
        </h2>
        <div className="row">
          {toggles.map((tg) => (
            <CheckboxPill
              key={tg.id}
              id={`tg-${tg.id.replace(":", "-")}`}
              checked={Boolean(on[tg.id])}
              onCheckedChange={(v) => setOn((prev) => ({ ...prev, [tg.id]: v }))}
            >
              {tg.label}
            </CheckboxPill>
          ))}
        </div>
        {connectedList.length > 0 && (
          <ul className="level-list" aria-label={t("newAgent.connectorsLabel")}>
            {connectedList.map((item) => {
              const name = itemName(t, item);
              return (
                <LevelRow
                  key={item.id}
                  icon={<ResourceIcon resource={{ connectionId: item.id, area: null }} items={connected} name={name} />}
                  name={name}
                  levels={LEVELS}
                  value={levels[item.id] ?? "none"}
                  onChange={(l) => setLevels((prev) => ({ ...prev, [item.id]: l }))}
                />
              );
            })}
          </ul>
        )}
        <span className="small muted">{t("newAgent.whereNote")}</span>
      </section>

      {(library.data ?? []).length > 0 && (
        <section aria-labelledby="q-skills" className="section">
          <h2 id="q-skills" className="section-title">
            {t("skills.step")}
          </h2>
          <span className="small muted">{t("skills.stepText")}</span>
          <SkillPicker skills={library.data ?? []} selected={skillIds ?? new Set()} onChange={setSkillIds} />
        </section>
      )}

      <div className="row" style={{ justifyContent: "flex-end", paddingTop: 8, borderTop: "1px solid var(--line)" }}>
        <Button asChild>
          <Link to="/org/$orgId" params={{ orgId: org.id }}>
            {t("common.cancel")}
          </Link>
        </Button>
        <Button variant="primary" disabled={cannotCreate} onClick={() => void submit().catch(() => {})}>
          {t("newAgent.create", { name: displayName })}
        </Button>
      </div>
    </div>
  );
}
