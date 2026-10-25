import type { Agent, AgentAudience } from "@agenteschat/client";
import {
  useAgents,
  useChannels,
  useCreateAgent,
  useCredentials,
  useDms,
  useMailAccounts,
  useMembers,
  useModels,
  usePlatformKey,
  useSettings,
  useSkills,
} from "@agenteschat/client";
import { LEVELS, type Level, saveLevels } from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, itemName } from "@agenteschat/client/lib/connected";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { choiceOf, defaultPolicy, MAIL_ACTIONS, toMailLevel } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { AUTO, isAuto, modelChoices } from "@agenteschat/client/lib/providers";
import { scopeText } from "@agenteschat/client/lib/scopes";
import {
  AffixInput,
  type AgentAppearance,
  type AgentColor,
  Button,
  Card,
  CheckboxPill,
  EmptyState,
  type Expression,
  Field,
  Icon,
  type IconName,
  Input,
  Kbd,
  Logo,
  modKey,
  prefersReducedMotion,
  randomAppearance,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { LevelRow, useConnectedById } from "@/components/AccessLevels";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  BudgetField,
  DEFAULT_KEY,
  InstructionTips,
  KeySelect,
  keyOptions,
  LookPicker,
  ModelCards,
  NO_OWNER,
  OwnerSelect,
  usd,
} from "@/components/AgentFields";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { MailIcon } from "@/components/MailConnect";
import { useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { AgentBornSky, AgentPreviewSky, OnboardingHorizon } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import {
  BLANK_LOOK,
  cleanHandle,
  type DraftCheck,
  type DraftError,
  firstInvalidStep,
  freeHandle,
  handleForName,
  handleProblem,
  NEW_AGENT_STEPS,
  type NewAgentStep,
  presetChannels,
  presetLevels,
  ROLE_GROUPS,
  ROLE_PRESETS,
  type RoleGroupId,
  type RoleId,
  readBudget,
  stepErrors,
} from "@/lib/new-agent";
import "./new-agent.css";

/** The icon next to each group of roles on the first step. */
const GROUP_ICON: Record<RoleGroupId, IconName> = { tech: "code", customers: "members", operations: "layers" };

/** How long the preview keeps writing after a keystroke. */
const TYPING_MS = 700;

/** The preview agent's mood: dash eyes while you type, a passing face when something lands (none with reduced motion). */
function useDraftMood() {
  const [typing, setTyping] = useState(false);
  const [face, setFace] = useState<Expression | undefined>(undefined);
  const timers = useRef<{ typing?: ReturnType<typeof setTimeout>; face?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.typing);
      clearTimeout(t.face);
    };
  }, []);
  return {
    typing,
    face,
    onTyping: () => {
      if (prefersReducedMotion()) return;
      setTyping(true);
      clearTimeout(timers.current.typing);
      timers.current.typing = setTimeout(() => setTyping(false), TYPING_MS);
    },
    react: (expression: Expression, ms = 1200) => {
      if (prefersReducedMotion()) return;
      setTyping(false);
      setFace(expression);
      clearTimeout(timers.current.face);
      timers.current.face = setTimeout(() => setFace(undefined), ms);
    },
  };
}

interface Created {
  agent: Agent;
  look: Required<AgentAppearance>;
  channels: { id: string; name: string }[];
  ownerName: string | null;
}

/** "Criar agente": the steps on a rail, a live preview of the agent on the right. */
export function NewAgentPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const allowed = can(org.role, "manage_agents");
  if (!allowed) {
    return (
      <main className="shell__main">
        <div className="page page--narrow">
          <header className="page__header">
            <h1 className="page-title">{t("newAgent.title")}</h1>
          </header>
          <EmptyState icon="agent">{t("newAgent.adminsOnly", { org: org.name })}</EmptyState>
        </div>
      </main>
    );
  }
  return <NewAgentFlow />;
}

function NewAgentFlow() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org, me } = useOrg();
  const api = useApi();
  const members = useMembers(org.id);
  const agents = useAgents(org.id);
  const models = useModels();
  const credentials = useCredentials(org.id);
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  const library = useSkills(org.id);
  const create = useCreateAgent(org.id);
  const connected = useConnectedById();
  const connectedList = useMemo(() => [...connected.values()], [connected]);
  const mail = useMailAccounts(org.id);
  // Mailboxes (ADR 0038) start without access: email is always granted on purpose.
  const mailboxes = useMemo(() => (mail.data ?? []).filter((a) => a.status === "active"), [mail.data]);
  const mood = useDraftMood();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const phone = useMediaQuery("(max-width: 820px)");

  // Navigation
  const [index, setIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [tried, setTried] = useState<Set<NewAgentStep>>(new Set());
  const [created, setCreated] = useState<Created | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // The draft
  const [role, setRole] = useState<RoleId | null>(null);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [look, setLook] = useState<Required<AgentAppearance>>(BLANK_LOOK);
  const [instructions, setInstructions] = useState("");
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [mailLevels, setMailLevels] = useState<Record<string, Level>>({});
  const [skillIds, setSkillIds] = useState<Set<string> | null>(null);
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState(me.user.id);
  const [audience, setAudience] = useState<AgentAudience>({ mode: "everyone", userIds: [] });
  // "Automático" for every new agent: each task gets its model and effort; a fixed model is one click away.
  const [model, setModel] = useState<string>(AUTO);
  const [key, setKey] = useState(DEFAULT_KEY);
  // Empty = the workspace default budget (every agent has one).
  const [budget, setBudget] = useState("");

  const step = NEW_AGENT_STEPS[index] ?? "role";
  const total = NEW_AGENT_STEPS.length;
  const dmChannels = useMemo(() => new Set((dms.data ?? []).map((d) => d.channelId)), [dms.data]);
  const myChannels = useMemo(
    () => (channels.data ?? []).filter((c) => c.isMember && !dmChannels.has(c.id)),
    [channels.data, dmChannels],
  );
  const choices = useMemo(
    () => modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
    [models.data, credentials.data, platform.data],
  );
  const usable = useMemo(
    () => new Set(choices.flatMap(([, list]) => list.filter((c) => c.available).map((c) => c.model.id))),
    [choices],
  );
  const taken = useMemo(
    () =>
      new Set([
        ...(agents.data ?? []).map((a) => a.handle.toLowerCase()),
        ...(members.data ?? []).map((m) => m.handle?.toLowerCase()).filter((h): h is string => Boolean(h)),
      ]),
    [agents.data, members.data],
  );

  // Defaults once the data arrives: the skills on for new agents, the levels.
  useEffect(() => {
    if (library.data && skillIds === null)
      setSkillIds(new Set(library.data.filter((s) => s.defaultForNewAgents).map((s) => s.id)));
  }, [library.data, skillIds]);
  useEffect(() => {
    setLevels((prev) => {
      const missing = connectedList.filter((i) => prev[i.id] === undefined);
      if (missing.length === 0) return prev;
      return { ...prev, ...presetLevels(role ?? "custom", missing) };
    });
  }, [connectedList, role]);

  const ownerId = owner === NO_OWNER ? null : owner;
  const ownerMember = (members.data ?? []).find((m) => m.userId === ownerId);
  const ownerFirst = ownerMember?.name.split(/\s+/)[0] ?? null;
  const displayName = name.trim() || t("newAgent.defaultName");
  const previewName = name.trim() || t("newAgent.previewName");
  const g = agentGrammar(t, displayName);
  const rolePreset = role ? ROLE_PRESETS[role] : null;
  const roleName = role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : null;
  const check: DraftCheck = {
    role,
    name,
    handle,
    taken,
    ownerUserId: ownerId,
    audience,
    budget,
    modelOk: isAuto(model) ? usable.size > 0 : usable.has(model),
  };
  const errors = tried.has(step) ? stepErrors(step, check) : [];
  const errorOf = (field: DraftError["field"]) => errors.find((e) => e.field === field);
  // A taken or malformed @ shows while typing; a missing one only after trying to go on.
  const liveHandle = handle ? handleProblem(handle, taken) : null;
  const handleError = errorOf("handle") ?? (liveHandle ? { field: "handle" as const, code: liveHandle } : undefined);
  const errorText = (e: DraftError): string => {
    if (e.field === "role") return t("newAgent.errors.roleRequired");
    if (e.field === "name") return t("newAgent.errors.nameRequired");
    if (e.field === "handle") {
      if (e.code === "taken")
        return t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) });
      return e.code === "empty" ? t("newAgent.errors.handleEmpty") : t("newAgent.errors.handleFormat");
    }
    if (e.field === "audience")
      return e.code === "noOwner" ? t("audience.modeText.noOwner") : t("audience.pickSomeone");
    if (e.field === "budget") return t("newAgent.budgetInvalid");
    return t("newAgent.errors.modelUnavailable");
  };
  const { amount, invalid: budgetInvalid } = readBudget(budget);
  const defaultBudget = settings.data?.defaultAgentBudgetUsd;
  const budgetShown = amount ?? defaultBudget;
  const modelInfo = (models.data?.models ?? []).find((m) => m.id === model);
  const modelLabel = isAuto(model) ? t("brain.auto.label") : (modelInfo?.label ?? model);
  const keys = keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null);
  const keyLabel = keys.find((k) => k.value === key)?.label ?? t("newAgent.defaultKey");
  const granted = connectedList.filter((i) => (levels[i.id] ?? "none") !== "none");
  const grantedMail = mailboxes.filter((a) => (mailLevels[a.id] ?? "none") !== "none");
  const mailAsks = MAIL_ACTIONS.approval.map((a) => t(`mail.action.${a}.name`));
  const skills = (library.data ?? []).filter((s) => skillIds?.has(s.id));
  const joined = myChannels.filter((c) => channelIds.has(c.id));
  const asksOf = (item: ConnectedItem) =>
    (item.def?.scopes ?? []).filter((s) => s.sensitive).map((s) => scopeText(t, s).label);

  const scrollTop = () => {
    try {
      root.current?.scrollTo?.({ top: 0 });
    } catch {
      // happy-dom without scrolling.
    }
  };
  const goTo = (i: number) => {
    const next = Math.max(0, Math.min(total - 1, i));
    setIndex(next);
    setReached((r) => Math.max(r, next));
    setPreviewOpen(false);
    scrollTop();
  };
  // Moving between steps puts the focus on the new step's title (not on the first render).
  const moved = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on step change only
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [index, created]);

  const fail = (s: NewAgentStep) => {
    setTried((prev) => new Set(prev).add(s));
    mood.react("surprised", 1100);
  };
  const submit = async () => {
    const bad = firstInvalidStep(check);
    if (bad >= 0) {
      const s = NEW_AGENT_STEPS[bad] ?? "role";
      fail(s);
      goTo(bad);
      return;
    }
    const agent = await create.mutateAsync({
      name: name.trim(),
      handle,
      role: role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : "",
      instructions,
      model,
      ownerUserId: ownerId,
      audience: { mode: audience.mode, userIds: audience.mode === "people" ? audience.userIds : [] },
      credentialId: key !== DEFAULT_KEY ? key : null,
      monthlyBudgetUsd: amount,
      appearance: look,
    });
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
    // Mailboxes: the chosen level with the default rules (every send asks); rules are set on the agent page.
    for (const account of grantedMail) {
      await api.mail.setAgent(org.id, agent.id, account.id, {
        level: toMailLevel(mailLevels[account.id] ?? "none"),
        canDelete: false,
        policy: defaultPolicy(),
      });
    }
    const libraryList = library.data ?? [];
    if (libraryList.length > 0) {
      await api.skills.setForAgent(
        org.id,
        agent.id,
        libraryList.map((s) => ({ skillId: s.id, enabled: skillIds?.has(s.id) ?? s.defaultForNewAgents })),
      );
    }
    setCreated({
      agent,
      look,
      channels: joined.map((c) => ({ id: c.id, name: c.name })),
      ownerName: ownerFirst,
    });
    mood.react("happy", 2200);
    scrollTop();
  };
  const next = () => {
    if (created || create.isPending) return;
    if (stepErrors(step, check).length > 0) {
      fail(step);
      setTimeout(() => root.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    if (index === total - 1) {
      void submit().catch(() => {});
      return;
    }
    mood.react("happy", 900);
    goTo(index + 1);
  };
  const back = () => {
    if (created || index === 0) return;
    goTo(index - 1);
  };
  const reset = () => {
    setCreated(null);
    setIndex(0);
    setReached(0);
    setTried(new Set());
    setRole(null);
    setName("");
    setHandle("");
    setHandleTouched(false);
    setLook(BLANK_LOOK);
    setInstructions("");
    setLevels(presetLevels("custom", connectedList));
    setSkillIds(library.data ? new Set(library.data.filter((s) => s.defaultForNewAgents).map((s) => s.id)) : null);
    setChannelIds(new Set());
    setOwner(me.user.id);
    setAudience({ mode: "everyone", userIds: [] });
    setModel(AUTO);
    setKey(DEFAULT_KEY);
    setBudget("");
    scrollTop();
  };

  // Keyboard: Enter goes on (⌘/Ctrl+Enter inside the instructions), Esc goes back (or leaves a field).
  const keyboard = useRef({ next, back });
  keyboard.current = { next, back };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inside = !target || target === document.body || Boolean(root.current?.contains(target));
      if (!inside) return;
      const tag = target?.tagName;
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        if (tag === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
        // Buttons and links act on their own (Continuar too); so do radios, checkboxes and pickers.
        if (tag === "BUTTON" || tag === "A") return;
        if (tag === "INPUT" && (target as HTMLInputElement).type === "search") return;
        if (target?.getAttribute("role") && tag !== "INPUT" && tag !== "TEXTAREA") return;
        e.preventDefault();
        keyboard.current.next();
      } else if (e.key === "Escape") {
        if (tag === "INPUT" || tag === "TEXTAREA") {
          target?.blur();
          return;
        }
        keyboard.current.back();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- Changes that also move the preview ---------- */

  const pickRole = (id: RoleId) => {
    const preset = ROLE_PRESETS[id];
    const agentName = id === "custom" ? "" : t(`newAgent.roles.${id}.agent`);
    setRole(id);
    setName(agentName);
    setHandle(handleForName(agentName));
    setHandleTouched(false);
    setLook({ ...preset.look });
    setInstructions(t(`newAgent.roles.${id}.instructions`));
    setLevels(presetLevels(id, connectedList));
    setChannelIds(new Set(presetChannels(id, myChannels)));
    setModel(AUTO);
    setTried((prev) => {
      const nextTried = new Set(prev);
      nextTried.delete("role");
      return nextTried;
    });
    if (id !== role) mood.react(id === "custom" ? "wink" : "happy", 1400);
  };
  const changeName = (value: string) => {
    const had = Boolean(name.trim());
    setName(value);
    if (!handleTouched) setHandle(handleForName(value));
    if (!had && value.trim()) mood.react("happy", 1200);
    else mood.onTyping();
  };
  const setLevel = (id: string, level: Level) => {
    setLevels((prev) => ({ ...prev, [id]: level }));
    if (level === "write") mood.react("star", 900);
  };
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const nextSet = new Set(set);
    if (on) nextSet.add(id);
    else nextSet.delete(id);
    return nextSet;
  };

  /* ---------- The step's content ---------- */

  const head = (title: string, lead: string) => (
    <header className="onb__head">
      <p className="onb__eyebrow">{t("newAgent.stepOf", { n: index + 1, total })}</p>
      <h1 className="onb__title newag__title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="onb__lead">{lead}</p>
    </header>
  );
  const errorLine = (e: DraftError | undefined) =>
    e ? (
      <span className="newag__err" role="alert">
        <Icon name="info" size={14} />
        {errorText(e)}
      </span>
    ) : null;
  const mailChip = (account: (typeof mailboxes)[number]) => (
    <span key={account.id} className="ac-chip newag__chip">
      <MailIcon choice={choiceOf(account)} />
      {t(mailLevels[account.id] === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", {
        name: account.address,
      })}
    </span>
  );
  const connectorChip = (item: ConnectedItem) => {
    const n = itemName(t, item);
    return (
      <span key={item.id} className="ac-chip newag__chip">
        <ConnectorIcon def={item.def} label={n} />
        {t(levels[item.id] === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", { name: n })}
      </span>
    );
  };
  const chip = (icon: IconName, text: string, k?: string) => (
    <span key={k ?? text} className="ac-chip">
      <Icon name={icon} />
      {text}
    </span>
  );
  const audienceText = () => {
    if (audience.mode === "everyone") return t("audience.summary.everyone");
    if (audience.mode === "owner")
      return ownerFirst ? t("audience.summary.owner", { name: ownerFirst }) : t("audience.summary.nobody");
    const names = (members.data ?? [])
      .filter((m) => m.userId === ownerId || audience.userIds.includes(m.userId))
      .map((m) => m.name.split(/\s+/)[0] ?? m.name);
    return names.length ? joinNames(names, t("newAgent.and")) : t("audience.summary.nobody");
  };

  const views: Record<NewAgentStep, () => ReactNode> = {
    role: () => (
      <>
        {head(t("newAgent.steps.role.title"), t("newAgent.steps.role.lead"))}
        {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
        <div className="newag__role-groups" role="group" aria-label={t("newAgent.steps.role.name")}>
          {ROLE_GROUPS.map((group) => (
            <section key={group.id} className="newag__section" aria-labelledby={`ag-roles-${group.id}`}>
              <div className={group.id === ROLE_GROUPS[0].id ? "newag__sect newag__sect--first" : "newag__sect"}>
                <h2 id={`ag-roles-${group.id}`}>
                  <Icon name={GROUP_ICON[group.id]} />
                  {t(`newAgent.roleGroups.${group.id}`)}
                </h2>
              </div>
              <div className="newag__roles">
                {group.roles.map((id) => {
                  const preset = ROLE_PRESETS[id];
                  const kit = connectedList.filter((i) => i.def && (preset.levels[i.def.id] ?? "none") !== "none");
                  const room = presetChannels(id, myChannels)
                    .map((cid) => myChannels.find((c) => c.id === cid)?.name)
                    .filter(Boolean)[0];
                  return (
                    <button
                      key={id}
                      type="button"
                      className="newag__role"
                      aria-pressed={role === id}
                      onClick={() => pickRole(id)}
                    >
                      <span className="newag__check" aria-hidden="true">
                        <Icon name="check" size={14} />
                      </span>
                      <span className="newag__role-top">
                        <AgentAvatar
                          name={t(`newAgent.roles.${id}.agent`)}
                          appearance={preset.look}
                          size="lg"
                          className="newag__role-agent"
                        />
                        <span className="newag__role-name">
                          <b>{t(`newAgent.roles.${id}.name`)}</b>
                          <span>{t("newAgent.startsAs", { name: t(`newAgent.roles.${id}.agent`) })}</span>
                        </span>
                      </span>
                      <span className="newag__role-desc">{t(`newAgent.roles.${id}.desc`)}</span>
                      {(kit.length > 0 || room) && (
                        <span className="newag__chips">
                          {kit.slice(0, 3).map((i) => (
                            <span key={i.id} className="ac-chip newag__chip">
                              <ConnectorIcon def={i.def} label={itemName(t, i)} />
                              {itemName(t, i)}
                            </span>
                          ))}
                          {room && chip("channel", room)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          <button
            type="button"
            className="newag__role newag__role--blank"
            aria-pressed={role === "custom"}
            onClick={() => pickRole("custom")}
          >
            <span className="newag__check" aria-hidden="true">
              <Icon name="check" size={14} />
            </span>
            <span className="newag__blank-icon" aria-hidden="true">
              <Icon name="plus" />
            </span>
            <span className="newag__role-name">
              <b>{t("newAgent.roles.custom.name")}</b>
              <span>{t("newAgent.roles.custom.desc")}</span>
            </span>
          </button>
        </div>
        {errorLine(errorOf("role"))}
      </>
    ),
    identity: () => (
      <>
        {head(t("newAgent.steps.identity.title"), t("newAgent.steps.identity.lead"))}
        <Card as="div" className="newag__card">
          <div className="newag__grid2">
            <Field
              label={t("newAgent.name")}
              id="ag-name"
              error={errorOf("name") ? errorText(errorOf("name") as DraftError) : undefined}
            >
              <Input
                className="newag__big"
                value={name}
                maxLength={32}
                autoComplete="off"
                placeholder={t("newAgent.namePlaceholder")}
                onChange={(e) => changeName(e.target.value)}
              />
            </Field>
            <Field
              label={t("newAgent.handle")}
              id="ag-handle"
              error={handleError ? errorText(handleError) : undefined}
              help={handle ? t("newAgent.handleHelp", { handle }) : t("newAgent.handleEmpty")}
            >
              <AffixInput
                className="newag__big"
                prefix="@"
                value={handle}
                maxLength={32}
                autoComplete="off"
                placeholder={t("newAgent.handlePlaceholder")}
                onChange={(e) => {
                  setHandleTouched(true);
                  setHandle(cleanHandle(e.target.value));
                  mood.onTyping();
                }}
              />
            </Field>
          </div>
        </Card>
        <div className="newag__sect">
          <h2>{t("newAgent.look")}</h2>
          <Button
            size="sm"
            icon="shuffle"
            onClick={() => {
              setLook((l) => ({ ...BLANK_LOOK, ...randomAppearance(l) }) as Required<AgentAppearance>);
              mood.react("dizzy", 1000);
            }}
          >
            {t("newAgent.shuffle")}
          </Button>
        </div>
        <Card as="div" className="newag__card newag__look">
          <LookPicker
            look={look}
            onPick={(patch) => {
              setLook((l) => ({ ...l, ...patch }));
              if (patch.color) mood.react("happy", 1100);
              else if (patch.eyes) mood.react("wink", 700);
              else if (patch.accessory && patch.accessory !== "none") mood.react("happy", 900);
            }}
          />
        </Card>
      </>
    ),
    instructions: () => {
      const original = role ? t(`newAgent.roles.${role}.instructions`) : "";
      const changed = role !== null && role !== "custom" && instructions !== original;
      return (
        <>
          {head(t("newAgent.steps.instructions.title", g), t("newAgent.steps.instructions.lead"))}
          <Textarea
            className="newag__textarea"
            rows={9}
            aria-label={t("newAgent.instructions")}
            placeholder={t("newAgent.instructionsPlaceholder")}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              mood.onTyping();
            }}
          />
          <div className="newag__ta-meta">
            <span className="newag__origin">
              {role && role !== "custom" ? (
                <>
                  <Icon name={ROLE_PRESETS[role].icon} size={14} />
                  {t("newAgent.startedFrom", { role: roleName })}
                </>
              ) : (
                <>
                  <Icon name="edit" size={14} />
                  {t("newAgent.roles.custom.name")}
                </>
              )}
              {changed && (
                <Button size="sm" variant="ghost" icon="undo" onClick={() => setInstructions(original)}>
                  {t("newAgent.restore")}
                </Button>
              )}
            </span>
            <span className="newag__count ac-num">
              <span aria-hidden="true">{instructions.length}</span>
              <span className="ac-visually-hidden">{t("newAgent.characters", { count: instructions.length })}</span>
            </span>
          </div>
          <InstructionTips
            helper={me.user.name.split(/\s+/)[0] ?? me.user.name}
            onAdd={(add) => {
              setInstructions((v) => (v.trim() ? `${v.replace(/\s+$/, "")}\n` : "") + add);
              setTimeout(() => {
                const ta = root.current?.querySelector<HTMLTextAreaElement>("textarea");
                ta?.focus();
                ta?.setSelectionRange?.(ta.value.length, ta.value.length);
              });
            }}
          />
          <p className="newag__note">
            <Icon name="info" size={16} />
            <span>{t("newAgent.contextNote", { ...g, org: org.name })}</span>
          </p>
          {!instructions.trim() && <p className="small muted">{t("newAgent.noInstructions", g)}</p>}
        </>
      );
    },
    tools: () => (
      <>
        {head(t("newAgent.steps.tools.title"), t("newAgent.steps.tools.lead", { ...g, org: org.name }))}
        <Card as="div" className="newag__card">
          {connectedList.length + mailboxes.length > 0 ? (
            <>
              <div className="newag__list-head">
                <span className="small muted">
                  {t("newAgent.connectedCount", { count: connectedList.length + mailboxes.length })}
                </span>
                <span className="newag__quick">
                  {t("newAgent.all")}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLevels(presetLevels("custom", connectedList));
                      setMailLevels({});
                    }}
                  >
                    {t("access.level.none")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLevels(Object.fromEntries(connectedList.map((i) => [i.id, "read" as Level])));
                      setMailLevels(Object.fromEntries(mailboxes.map((a) => [a.id, "read" as Level])));
                    }}
                  >
                    {t("access.level.read")}
                  </Button>
                </span>
              </div>
              <ul className="level-list" aria-label={t("newAgent.connectorsLabel")}>
                {connectedList.map((item) => {
                  const n = itemName(t, item);
                  const level = levels[item.id] ?? "none";
                  return (
                    <LevelRow
                      key={item.id}
                      icon={<ConnectorIcon def={item.def} label={n} />}
                      name={n}
                      description={item.account}
                      asks={level === "write" ? asksOf(item) : []}
                      levels={LEVELS}
                      value={level}
                      onChange={(l) => setLevel(item.id, l)}
                    />
                  );
                })}
                {mailboxes.map((account) => {
                  const level = mailLevels[account.id] ?? "none";
                  return (
                    <LevelRow
                      key={account.id}
                      icon={<MailIcon choice={choiceOf(account)} />}
                      name={account.address}
                      description={account.label || null}
                      asks={level === "write" ? mailAsks : []}
                      levels={LEVELS}
                      value={level}
                      onChange={(l) => {
                        setMailLevels((prev) => ({ ...prev, [account.id]: l }));
                        if (l === "write") mood.react("star", 900);
                      }}
                    />
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="small muted">{t("access.noConnectors", { org: org.name })}</p>
          )}
          <Link
            className="newag__addrow"
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "connectors" }}
          >
            <Icon name="plug" />
            {t("newAgent.connectOther")}
            <span className="newag__addrow-aside">{t("newAgent.opensConnectors")}</span>
          </Link>
        </Card>
        <p className="newag__note">
          <Icon name="shield" size={16} />
          <span>
            <b>{t("newAgent.approvalsNote")}</b>{" "}
            {ownerFirst ? t("newAgent.approverOwner", { name: ownerFirst }) : t("newAgent.approverAdmins")}
          </span>
        </p>
        {(library.data ?? []).length > 0 && (
          <section className="newag__section" aria-labelledby="ag-skills">
            <div className="newag__sect">
              <h2 id="ag-skills">
                <Icon name="book" />
                {t("skills.step")} <span className="newag__opt-label">{t("newAgent.optional")}</span>
              </h2>
              <span className="small muted">{t("newAgent.skillsHelp", g)}</span>
            </div>
            <div className="newag__pills">
              {(library.data ?? []).map((s) => (
                <CheckboxPill
                  key={s.id}
                  id={`ag-skill-${s.id}`}
                  checked={skillIds?.has(s.id) ?? false}
                  onCheckedChange={(on) => setSkillIds((prev) => toggle(prev ?? new Set(), s.id, on))}
                >
                  {s.name}
                </CheckboxPill>
              ))}
            </div>
          </section>
        )}
      </>
    ),
    where: () => (
      <>
        {head(t("newAgent.steps.where.title"), t("newAgent.steps.where.lead", g))}
        <div className="newag__sect newag__sect--first">
          <h2>
            <Icon name="channel" />
            {t("newAgent.channels")}
          </h2>
          <span className="small muted">{t("newAgent.channelsHelp")}</span>
        </div>
        {myChannels.length > 0 ? (
          <div className="newag__pills">
            {myChannels.map((c) => (
              <CheckboxPill
                key={c.id}
                id={`ag-ch-${c.id}`}
                checked={channelIds.has(c.id)}
                onCheckedChange={(on) => {
                  setChannelIds((prev) => toggle(prev, c.id, on));
                  if (on) mood.react("happy", 700);
                }}
              >
                {`#${c.name}`}
              </CheckboxPill>
            ))}
          </div>
        ) : (
          <p className="small muted">{t("newAgent.noChannels")}</p>
        )}
        <div className="newag__sect">
          <h2>
            <Icon name="person" />
            {t("newAgent.owner")}
          </h2>
        </div>
        <Card as="div" className="newag__card">
          <OwnerSelect
            value={owner}
            members={members.data ?? []}
            meId={me.user.id}
            onChange={(v) => {
              setOwner(v);
              if (v !== NO_OWNER) setAudience((a) => ({ ...a, userIds: a.userIds.filter((id) => id !== v) }));
            }}
          />
          <span className="small muted">{ownerId ? t("newAgent.ownerHelp") : t("newAgent.noOwnerHelp")}</span>
        </Card>
        <div className="newag__sect">
          <h2>
            <Icon name="message" />
            {t("audience.title", g)}
          </h2>
        </div>
        <Card as="div" className="newag__card">
          <AudienceChoice
            compact
            value={audience}
            onChange={setAudience}
            ownerUserId={ownerId}
            agentName={displayName}
            idPrefix="ag-audience"
          />
          {errorLine(errorOf("audience"))}
        </Card>
      </>
    ),
    model: () => {
      return (
        <>
          {head(t("newAgent.steps.model.title"), t("newAgent.steps.model.lead"))}
          <ModelCards
            choices={choices}
            value={model}
            money
            onChange={(id) => {
              setModel(id);
              mood.react(id.toLowerCase().includes("opus") ? "star" : "happy", 800);
            }}
          />
          {errorLine(errorOf("model"))}
          <div className="newag__sect">
            <h2>
              <Icon name="key" />
              {t("newAgent.key")}
            </h2>
          </div>
          <KeySelect value={key} onChange={setKey} options={keys} />
          <div className="newag__sect">
            <h2>
              <Icon name="wallet" />
              {t("newAgent.budgetTitle")}
            </h2>
            <span className="small muted">{t("newAgent.budgetHelp", g)}</span>
          </div>
          <Card as="div" className="newag__card">
            <BudgetField
              id="ag-budget"
              value={budget}
              onChange={setBudget}
              defaultBudget={defaultBudget}
              error={errorOf("budget") ? errorText(errorOf("budget") as DraftError) : undefined}
            />
            {!errorOf("budget") && (
              <span className="small muted">
                {defaultBudget === undefined
                  ? t("agent.budgetDefaultHelp")
                  : t("agent.budgetDefaultHelpAmount", { amount: usd(t, locale, defaultBudget) })}{" "}
                {ownerFirst ? t("newAgent.warnsOwner", { name: ownerFirst }) : t("newAgent.warnsAdmins")}
              </span>
            )}
          </Card>
        </>
      );
    },
    review: () => {
      const row = (to: NewAgentStep, icon: IconName, label: string, value: ReactNode) => (
        <div className="newag__rv" key={label}>
          <span className="newag__rv-k">
            <Icon name={icon} size={16} />
            {label}
          </span>
          <div className="newag__rv-v">{value}</div>
          <Button
            size="sm"
            variant="ghost"
            icon="edit"
            aria-label={t("newAgent.editSection", { section: label })}
            onClick={() => goTo(NEW_AGENT_STEPS.indexOf(to))}
          >
            {t("agent.edit")}
          </Button>
        </div>
      );
      const chips = (list: ReactNode[], empty: string) =>
        list.length ? <span className="newag__chips">{list}</span> : <span className="muted">{empty}</span>;
      return (
        <>
          {head(t("newAgent.steps.review.title", g), t("newAgent.steps.review.lead"))}
          <Card as="div" className="newag__card newag__review">
            {row(
              "role",
              rolePreset?.icon ?? "agent",
              t("newAgent.steps.role.name"),
              <span>
                {role && role !== "custom"
                  ? `${roleName} · ${t(`newAgent.roles.${role}.desc`)}`
                  : t("newAgent.roles.custom.name")}
              </span>,
            )}
            {row(
              "identity",
              "person",
              t("newAgent.name"),
              <>
                <span>
                  <b>{displayName}</b> <span className="muted">@{handle}</span>
                </span>
                <span className="small muted">
                  {[
                    t(`look.colors.${look.color}`),
                    t(`look.eyesNames.${look.eyes}`),
                    ...(look.accessory !== "none" ? [t(`look.accessories.${look.accessory}`)] : []),
                  ].join(" · ")}
                </span>
              </>,
            )}
            {row(
              "instructions",
              "document",
              t("newAgent.instructions"),
              instructions.trim() ? (
                <span className="newag__quote">{instructions.trim()}</span>
              ) : (
                <span className="muted">{t("newAgent.onlyContext")}</span>
              ),
            )}
            {row(
              "tools",
              "plug",
              t("newAgent.tools"),
              chips(
                [
                  ...granted.map(connectorChip),
                  ...grantedMail.map(mailChip),
                  ...skills.map((s) => chip("book", s.name, s.id)),
                ],
                t("newAgent.noTools"),
              ),
            )}
            {row(
              "where",
              "channel",
              t("newAgent.channels"),
              chips(
                joined.map((c) => chip("channel", c.name, c.id)),
                t("newAgent.noChannelsReview"),
              ),
            )}
            {row(
              "where",
              "members",
              t("newAgent.answers"),
              <span>
                {ownerMember?.name ?? t("newAgent.noOwnerAdmins")}{" "}
                <span className="muted">· {t("newAgent.talksTo", { who: audienceText() })}</span>
              </span>,
            )}
            {row(
              "model",
              "bolt",
              t("newAgent.modelAndCost"),
              <span>
                {modelLabel}{" "}
                <span className="muted">
                  · {keyLabel}
                  {budgetShown !== undefined && ` · ${t("newAgent.upTo", { amount: usd(t, locale, budgetShown) })}`}
                </span>
              </span>,
            )}
          </Card>
          <p className="newag__note">
            <Icon name="shield" size={16} />
            <span>
              {ownerFirst ? t("newAgent.reviewNoteOwner", { name: ownerFirst }) : t("newAgent.reviewNoteAdmins")}
            </span>
          </p>
        </>
      );
    },
  };

  /* ---------- The created moment ---------- */

  if (created) {
    return (
      <div className="onb newag newag--done" ref={root}>
        <NewAgentRail index={total} reached={total} total={total} onGo={() => {}} done />
        <main className="newag__main">
          <div className="newag__content newag__content--done">
            <CreatedMoment created={created} phone={phone} face={mood.face} onAgain={reset} heading={heading} />
          </div>
        </main>
      </div>
    );
  }

  /* ---------- The preview ---------- */

  const last = index === total - 1;
  const footErrors = errors.map(errorText);
  const hint: Record<NewAgentStep, ReactNode> = {
    role: role
      ? role === "custom"
        ? t("newAgent.roles.custom.name")
        : t("newAgent.startsAs", { name: t(`newAgent.roles.${role}.agent`) })
      : t("newAgent.hints.role"),
    identity: handle ? t("newAgent.hints.identity", { handle }) : "",
    instructions: (
      <>
        <Kbd>{modKey()}</Kbd>
        <Kbd>↵</Kbd>
        {t("newAgent.hints.instructions")}
      </>
    ),
    tools:
      granted.length + grantedMail.length
        ? t("newAgent.hints.tools", { count: granted.length + grantedMail.length })
        : t("newAgent.hints.noTools"),
    where: joined.length ? t("newAgent.hints.where", { count: joined.length }) : t("newAgent.noChannelsYet"),
    model: modelLabel,
    review: t("newAgent.hints.review"),
  };

  return (
    <div className="onb newag" ref={root}>
      <NewAgentRail index={index} reached={reached} total={total} onGo={goTo} done={false} />
      <div className="newag__work">
        <main className="newag__main">
          <div className="newag__content" key={step}>
            {views[step]()}
          </div>
          <div className="newag__foot">
            <span className="newag__hint" data-bad={footErrors.length > 0 || undefined}>
              {footErrors.length > 0 ? (
                <>
                  <Icon name="info" size={14} />
                  {footErrors[0]}
                </>
              ) : (
                hint[step]
              )}
            </span>
            {index > 0 ? (
              <Button variant="ghost" size="lg" icon="chevronLeft" onClick={back}>
                {t("common.back")}
              </Button>
            ) : (
              <Button asChild variant="ghost" size="lg">
                <Link to="/org/$orgId" params={{ orgId: org.id }}>
                  {t("common.cancel")}
                </Link>
              </Button>
            )}
            <Button
              variant="primary"
              size="lg"
              kbd={["↵"]}
              loading={create.isPending}
              aria-disabled={footErrors.length > 0 || undefined}
              onClick={next}
            >
              {last ? t("newAgent.create", { name: displayName }) : t("common.continue")}
            </Button>
          </div>
        </main>
        <aside className="newag__aside" aria-label={t("newAgent.preview.label")}>
          <div className="newag__cap">
            <span className="onb__eyebrow">{t("newAgent.preview.title")}</span>
            <span className="small muted">{t("newAgent.preview.hint")}</span>
          </div>
          <div className="newag__pv" data-big={step === "identity" || undefined} data-open={previewOpen || undefined}>
            <div className="newag__pv-cover">
              <AgentPreviewSky color={look.color as AgentColor} />
              <span className="newag__pv-state">
                <Icon name="edit" size={14} />
                {t("newAgent.preview.draft")}
              </span>
              <AgentAvatar
                name={previewName}
                appearance={look}
                size="xl"
                className="newag__pv-agent"
                state={mood.typing ? "writing" : undefined}
                expression={mood.face}
              />
            </div>
            <div className="newag__pv-body">
              <div className="newag__pv-head">
                <div className="newag__pv-name">
                  <b data-placeholder={!name.trim() || undefined}>{previewName}</b>
                  <span>
                    {handle ? `@${handle}` : "@…"}
                    {roleName && <span className="newag__pv-role"> · {roleName}</span>}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={previewOpen ? "close" : "chevronDown"}
                  className="newag__pv-toggle"
                  aria-expanded={previewOpen}
                  aria-label={previewOpen ? t("newAgent.preview.hide") : t("newAgent.preview.show")}
                  onClick={() => setPreviewOpen((o) => !o)}
                />
              </div>
              {roleName && rolePreset && (
                <span className="newag__chips newag__pv-wide">{chip(rolePreset.icon, roleName)}</span>
              )}
              {instructions.trim() && <p className="newag__pv-instr">{instructions.trim().split("\n")[0]}</p>}
              <PreviewSection label={t("newAgent.preview.uses")}>
                {granted.length || grantedMail.length || skills.length ? (
                  <>
                    <span className="newag__chips">
                      {granted.map(connectorChip)}
                      {grantedMail.map(mailChip)}
                      {skills.map((s) => chip("book", s.name, s.id))}
                    </span>
                    {(() => {
                      const asks = [
                        ...granted.filter((i) => levels[i.id] === "write").flatMap(asksOf),
                        ...(grantedMail.some((a) => mailLevels[a.id] === "write") ? mailAsks : []),
                      ];
                      return asks.length ? (
                        <span className="newag__asks">
                          <Icon name="lock" size={14} />
                          {t("toolReview.asks", { count: new Set(asks).size })}
                        </span>
                      ) : null;
                    })()}
                  </>
                ) : (
                  <span className="newag__empty">{t("newAgent.preview.onlyTalks")}</span>
                )}
              </PreviewSection>
              <PreviewSection label={t("newAgent.preview.worksIn")}>
                {joined.length ? (
                  <span className="newag__chips">{joined.map((c) => chip("channel", c.name, c.id))}</span>
                ) : (
                  <span className="newag__empty">{t("newAgent.noChannelsYet")}</span>
                )}
              </PreviewSection>
              <PreviewSection label={t("newAgent.preview.answers")}>
                <span className="newag__chips">
                  {chip("person", ownerFirst ?? t("newAgent.noOwnerOption"), "owner")}
                  {chip("message", audienceText(), "audience")}
                </span>
              </PreviewSection>
              <PreviewSection label={t("newAgent.modelAndCost")}>
                <span className="newag__chips">
                  {modelLabel && chip("bolt", modelLabel, "model")}
                  {budgetShown !== undefined &&
                    !budgetInvalid &&
                    chip("wallet", t("newAgent.upTo", { amount: usd(t, locale, budgetShown) }), "budget")}
                </span>
              </PreviewSection>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PreviewSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="newag__pv-sec">
      <span className="newag__pv-label">{label}</span>
      {children}
    </div>
  );
}

/** The rail: brand, title, the steps (visited ones clickable), leaving, and the horizon rising with progress. */
function NewAgentRail({
  index,
  reached,
  total,
  onGo,
  done,
}: {
  index: number;
  reached: number;
  total: number;
  onGo: (i: number) => void;
  done: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <aside className="onb__rail newag__rail">
      <div className="newag__rail-head">
        <span className="onb__brand">
          <Logo size={22} />
        </span>
        <Button asChild variant="ghost" size="sm" iconOnly aria-label={t("newAgent.leave")}>
          <Link to="/org/$orgId" params={{ orgId: org.id }} title={t("newAgent.leave")}>
            <Icon name="close" />
          </Link>
        </Button>
      </div>
      <div className="newag__rail-title">
        <b>{t("newAgent.railTitle")}</b>
        <span>{t("newAgent.railOrg", { org: org.name, role: t(`roles.${org.role}Lower`) })}</span>
      </div>
      <StepRail
        label={t("newAgent.stepsLabel")}
        current={done ? -1 : index}
        onGo={onGo}
        doneLabel={t("onboarding.stepDone")}
        steps={NEW_AGENT_STEPS.map((s, i) => ({
          id: s,
          name: t(`newAgent.steps.${s}.name`),
          done: done || i < reached,
          disabled: done || i > reached,
        }))}
      />
      <OnboardingHorizon progress={done ? 1 : reached / (total - 1)} />
    </aside>
  );
}

/** The new agent on its own sky: where it is, and what to do next. */
function CreatedMoment({
  created,
  phone,
  face,
  onAgain,
  heading,
}: {
  created: Created;
  phone: boolean;
  face: Expression | undefined;
  onAgain: () => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const text = useRef<HTMLDivElement>(null);
  const { agent, channels } = created;
  const first = channels[0];
  const names = joinNames(
    channels.map((c) => `#${c.name}`),
    t("newAgent.and"),
  );
  return (
    <>
      <section className="newag__born" aria-labelledby="ag-born">
        <AgentBornSky color={created.look.color} at={phone ? [0.5, 0.26] : [0.8, 0.45]} calm={() => [text.current]} />
        <span className="newag__born-agent">
          <AgentAvatar name={agent.name} appearance={created.look} size="xl" expression={face} />
        </span>
        <div className="newag__born-text" ref={text}>
          <p className="onb__eyebrow onb__eyebrow--sky">{t("newAgent.newOnTeam")}</p>
          <h1 id="ag-born" className="newag__born-title" ref={heading} tabIndex={-1}>
            {t("newAgent.createdTitle", { name: agent.name })}
          </h1>
          <p className="newag__born-lead">
            {channels.length > 0
              ? t("newAgent.createdText", { channels: names, handle: agent.handle })
              : t("newAgent.createdTextNoChannels", { name: agent.name, handle: agent.handle })}
          </p>
          <div className="newag__born-actions">
            {first && (
              <Button asChild variant="primary" className="newag__on-sky">
                <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: first.id }}>
                  {t("newAgent.goTo", { channel: first.name })}
                  <Icon name="arrowRight" size={16} />
                </Link>
              </Button>
            )}
            <Button asChild variant={first ? "default" : "primary"} className="newag__on-sky">
              <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
                {t("newAgent.openProfile")}
              </Link>
            </Button>
            <Button icon="plus" className="newag__on-sky" onClick={onAgain}>
              {t("newAgent.createAnother")}
            </Button>
          </div>
        </div>
      </section>
      <div className="newag__nexts">
        <Card as="div" className="newag__next">
          <b>
            <Icon name="message" size={16} />
            {t("newAgent.next.hello.title")}
          </b>
          <span>
            {first
              ? t("newAgent.next.hello.inChannel", { handle: agent.handle, channel: first.name })
              : t("newAgent.next.hello.text", { handle: agent.handle })}
          </span>
        </Card>
        <Card as="div" className="newag__next">
          <b>
            <Icon name="bell" size={16} />
            {created.ownerName
              ? t("newAgent.next.alerts.owner", { name: created.ownerName })
              : t("newAgent.next.alerts.admins")}
          </b>
          <span>{t("newAgent.next.alerts.text")}</span>
        </Card>
        <Card as="div" className="newag__next">
          <b>
            <Icon name="shield" size={16} />
            {t("newAgent.next.profile.title")}
          </b>
          <span>{t("newAgent.next.profile.text")}</span>
        </Card>
      </div>
    </>
  );
}
