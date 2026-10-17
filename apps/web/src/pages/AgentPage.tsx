import {
  type AgentAppearance,
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  Icon,
  normalizeAppearance,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import {
  useAgentAccess,
  useAgentBrain,
  useAgentDetail,
  useAgentRepos,
  useAgentSkills,
  useComputer,
  useCredentials,
  useMachines,
  useModels,
  useProposals,
  useRuns,
  useSetComputerTarget,
  useSettings,
  useUpdateAgent,
} from "@/api/queries";
import type { Agent, AgentAudience, AgentBrain, AgentDetail, AgentInput, AgentSkill } from "@/api/types";
import { resourceName, useConnectedById, useSetLevels } from "@/components/AccessLevels";
import { audienceValid } from "@/components/AgentAudience";
import { brainSummary, PlanTermsDialog } from "@/components/AgentBrain";
import { CLOUD, machineOf } from "@/components/AgentComputer";
import { DEFAULT_KEY, keyOptions, NO_OWNER, usd } from "@/components/AgentFields";
import { LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { type Level, levelsOf, resourcesOf } from "@/lib/access-levels";
import {
  AGENT_TABS,
  type AgentSection,
  type AgentTab,
  type BrainChoice,
  budgetValue,
  canEdit,
  changedKeys,
  channelsAfter,
  dropFields,
  type Edits,
  FIELD_PLACE,
  type Field,
  type Look,
  lineChanges,
  revertKey,
  type Saved,
  termsPending,
  thisMonth,
  type Viewer,
} from "@/lib/agent-edit";
import { errorText } from "@/lib/errors";
import { joinNames } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { lookOf } from "@/lib/look";
import { BLANK_LOOK, readBudget } from "@/lib/new-agent";
import { can } from "@/lib/permissions";
import { type RepoChoice, repoChoiceOf, repoListOf, reposText } from "@/lib/repos";
import { useToast } from "@/lib/toast";
import { AccessTab } from "./agent/AccessTab";
import { ActivityTab } from "./agent/ActivityTab";
import { type AgentEdit, AgentEditProvider, type Change, type Draft } from "./agent/context";
import { AgentHero } from "./agent/Hero";
import { InstructionsTab } from "./agent/InstructionsTab";
import { MemoryTab } from "./agent/MemoryTab";
import { OverviewTab } from "./agent/OverviewTab";
import { useVisibleChannels } from "./agent/pieces";
import { RepoDialog } from "./agent/Repos";
import { SaveBar } from "./agent/SaveBar";
import { SettingsTab } from "./agent/SettingsTab";

const fullLook = (a: AgentAppearance | undefined): Look => ({
  color: a?.color ?? BLANK_LOOK.color,
  eyes: a?.eyes ?? BLANK_LOOK.eyes,
  accessory: a?.accessory ?? BLANK_LOOK.accessory,
});
const sortIds = (ids: string[]) => [...ids].sort();

export interface AgentPageProps {
  agentId: string;
  tab: AgentTab;
  section?: AgentSection;
  /** Changes the tab (and section) in the URL. */
  onNavigate: (tab: AgentTab, section?: AgentSection) => void;
}

/** docs/design/telas/AgentePerfil.html — the agent on its sky, tabs, inline editing with one save bar. */
export function AgentPage(props: AgentPageProps) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(props.agentId);
  if (dir.loading) {
    return (
      <div className="page page--xwide">
        <LoadingPage rows={6} />
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="page page--xwide">
        <EmptyState icon="agent">{t("agent.notFound")}</EmptyState>
      </div>
    );
  }
  return <AgentProfile key={agent.id} agent={agent} {...props} />;
}

function AgentProfile({ agent, tab, section, onNavigate }: AgentPageProps & { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const dir = useDirectory(org.id);
  const admin = can(org.role, "manage_agents");
  const viewer: Viewer = admin ? "admin" : agent.ownerUserId === me.user.id ? "owner" : "member";
  const models = useModels();
  const detail = useAgentDetail(org.id, agent.id);
  const settings = useSettings(org.id);
  const credentials = useCredentials(org.id, can(org.role, "manage_credentials"));
  const access = useAgentAccess(org.id, agent.id);
  const repos = useAgentRepos(org.id, agent.id);
  const library = useAgentSkills(org.id, agent.id);
  const computer = useComputer(org.id, agent.id, viewer !== "member");
  const machines = useMachines(org.id, viewer !== "member");
  const brain = useAgentBrain(org.id, agent.id, viewer !== "member");
  const proposals = useProposals(org.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const visible = useVisibleChannels();
  const items = useConnectedById();
  const update = useUpdateAgent(org.id, agent.id);
  const setLevels = useSetLevels();
  const setTarget = useSetComputerTarget(org.id);
  const [edits, setEdits] = useState<Edits>({});
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  /** The repositories picker: open, with a repository to add ("Liberar"). */
  const [picking, setPicking] = useState<{ add?: string } | null>(null);
  const top = useRef<HTMLDivElement>(null);

  /* ---------- What the server has ---------- */

  const resources = useMemo(() => (access.data ? resourcesOf(access.data) : []), [access.data]);
  const saved = useMemo<Saved>(() => {
    const d: AgentDetail | undefined = detail.data;
    const visibleIds = new Set(visible.list.map((c) => c.id));
    const cred = d?.credentialId ?? null;
    return {
      name: agent.name,
      role: agent.role ?? "",
      look: fullLook(lookOf(agent)),
      instructions: agent.instructions,
      model: agent.model,
      key:
        admin && d && settings.data
          ? cred && cred !== settings.data.defaultCredentialId
            ? cred
            : DEFAULT_KEY
          : undefined,
      budget: admin && d ? (d.monthlyBudgetUsd ?? null) : undefined,
      owner: agent.ownerUserId ?? NO_OWNER,
      audience: agent.audience
        ? { mode: agent.audience.mode, userIds: agent.audience.userIds ?? [] }
        : { mode: agent.audienceMode ?? "everyone", userIds: [] },
      levels: access.data ? levelsOf(access.data) : undefined,
      repos: repos.data ? repoChoiceOf(repos.data) : undefined,
      skills: library.data ? sortIds(library.data.filter((s) => s.enabled).map((s) => s.id)) : undefined,
      channels:
        d && visible.ready ? sortIds(d.channels.map((c) => c.id).filter((id) => visibleIds.has(id))) : undefined,
      machine: computer.data ? machineOf(computer.data) : undefined,
      brain: brain.data
        ? { brain: brain.data.brain, model: brain.data.model, fallback: brain.data.fallback }
        : undefined,
    };
  }, [
    agent,
    admin,
    detail.data,
    settings.data,
    access.data,
    repos.data,
    library.data,
    computer.data,
    brain.data,
    visible,
  ]);

  /* ---------- The draft ---------- */

  const draft: Draft = {
    name: edits.name ?? saved.name,
    role: edits.role ?? saved.role,
    look: edits.look ?? saved.look,
    instructions: edits.instructions ?? saved.instructions,
    model: edits.model ?? saved.model,
    key: edits.key ?? saved.key,
    budget:
      edits.budget ??
      (saved.budget === undefined || saved.budget === null
        ? ""
        : new Intl.NumberFormat(i18n.language, { useGrouping: false, maximumFractionDigits: 2 }).format(saved.budget)),
    owner: edits.owner ?? saved.owner,
    audience: edits.audience ?? saved.audience,
    levels: { ...(saved.levels ?? {}), ...(edits.levels ?? {}) },
    repos: edits.repos ?? saved.repos,
    skills: edits.skills ?? saved.skills,
    channels: edits.channels ?? saved.channels,
    machine: edits.machine ?? saved.machine,
    brain: edits.brain ?? saved.brain,
  };

  /* ---------- What changed, said in words ---------- */

  const g = agentGrammar(t, agent.name);
  const ownerFirst = agent.ownerUserId ? (dir.memberById.get(agent.ownerUserId)?.name.split(/\s+/)[0] ?? null) : null;
  const lookText = (l: Look) =>
    [
      t(`look.colors.${l.color}`),
      t(`look.eyesNames.${l.eyes}`),
      ...(l.accessory !== "none" ? [t(`look.accessories.${l.accessory}`)] : []),
    ].join(" · ");
  const memberName = (id: string) =>
    id === NO_OWNER ? t("newAgent.noOwnerOption") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  const audienceText = (a: AgentAudience, owner: string) => {
    const first = (id: string) => memberName(id).split(/\s+/)[0] ?? "";
    if (a.mode === "everyone") return t("audience.summary.everyone");
    if (a.mode === "owner")
      return owner === NO_OWNER ? t("audience.summary.nobody") : t("audience.summary.owner", { name: first(owner) });
    const ids = [...new Set([...(owner === NO_OWNER ? [] : [owner]), ...a.userIds])];
    return ids.length ? joinNames(ids.map(first), t("newAgent.and")) : t("audience.summary.nobody");
  };
  const budgetText = (amount: number | null) =>
    amount === null
      ? settings.data?.defaultAgentBudgetUsd === undefined
        ? t("agentPage.budgetDefault")
        : t("agentPage.budgetDefaultAmount", { amount: usd(t, i18n.language, settings.data.defaultAgentBudgetUsd) })
      : t("agentPage.perMonth", { amount: usd(t, i18n.language, amount) });
  const keyText = (k: string) =>
    keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null).find((o) => o.value === k)
      ?.label ?? t("newAgent.defaultKey");
  const channelText = (ids: string[]) =>
    ids.length
      ? ids.map((id) => `#${visible.list.find((c) => c.id === id)?.name ?? ""}`).join(", ")
      : t("agentPage.none");
  const machineText = (id: string) =>
    id === CLOUD
      ? t("computer.target.cloud")
      : ((machines.data ?? []).find((m) => m.id === id)?.name ??
        (computer.data?.target?.kind === "machine" ? computer.data.target.name : id));
  const modelText = (id: string) => models.data?.models.find((m) => m.id === id)?.label ?? id;
  const resourceById = new Map(resources.map((r) => [r.id, r]));

  const changes: Change[] = changedKeys(saved, edits).map(({ key, field, resource }) => {
    const place = FIELD_PLACE[field];
    const base = { key, field, tab: place.tab, sec: place.sec };
    const label = (f: Field) => t(`agentPage.fields.${f}`);
    switch (field) {
      case "name":
        return { ...base, label: label("name"), was: saved.name, now: draft.name || t("agentPage.empty") };
      case "role":
        return {
          ...base,
          label: label("role"),
          was: saved.role || t("agentPage.empty"),
          now: draft.role || t("agentPage.empty"),
        };
      case "look":
        return { ...base, label: label("look"), was: lookText(saved.look), now: lookText(draft.look) };
      case "instructions": {
        const { added, removed } = lineChanges(saved.instructions, draft.instructions);
        const parts = [
          added ? t("agentPage.lines.added", { count: added }) : "",
          removed ? t("agentPage.lines.removed", { count: removed }) : "",
        ].filter(Boolean);
        return { ...base, label: label("instructions"), was: "", now: parts.join(", ") || t("agentPage.lines.edited") };
      }
      case "levels": {
        const r = resource ? resourceById.get(resource) : undefined;
        return {
          ...base,
          label: r ? resourceName(t, r, items) : label("levels"),
          was: t(`access.level.${saved.levels?.[resource ?? ""] ?? "none"}`),
          now: t(`access.level.${draft.levels[resource ?? ""] ?? "none"}`),
        };
      }
      case "repos":
        return {
          ...base,
          label: label("repos"),
          was: saved.repos ? reposText(t, saved.repos) : "",
          now: draft.repos ? reposText(t, draft.repos) : "",
        };
      case "skills":
        return {
          ...base,
          label: label("skills"),
          was: t("agentPage.skillsOn", { count: saved.skills?.length ?? 0 }),
          now: t("agentPage.skillsOn", { count: draft.skills?.length ?? 0 }),
        };
      case "model":
        return { ...base, label: label("model"), was: modelText(saved.model), now: modelText(draft.model) };
      case "key":
        return {
          ...base,
          label: label("key"),
          was: keyText(saved.key ?? DEFAULT_KEY),
          now: keyText(draft.key ?? DEFAULT_KEY),
        };
      case "budget": {
        const now = budgetValue(draft.budget);
        return {
          ...base,
          label: label("budget"),
          was: budgetText(saved.budget ?? null),
          now: now === undefined ? draft.budget : budgetText(now),
        };
      }
      case "owner":
        return { ...base, label: label("owner"), was: memberName(saved.owner), now: memberName(draft.owner) };
      case "audience":
        return {
          ...base,
          label: label("audience"),
          was: audienceText(saved.audience, saved.owner),
          now: audienceText(draft.audience, draft.owner),
        };
      case "channels":
        return {
          ...base,
          label: label("channels"),
          was: channelText(saved.channels ?? []),
          now: channelText(draft.channels ?? []),
        };
      case "brain":
        return {
          ...base,
          label: label("brain"),
          was: saved.brain ? brainSummary(t, saved.brain, brain.data?.options) : "",
          now: draft.brain ? brainSummary(t, draft.brain, brain.data?.options) : "",
        };
      default:
        return {
          ...base,
          label: label("machine"),
          was: machineText(saved.machine ?? CLOUD),
          now: machineText(draft.machine ?? CLOUD),
        };
    }
  });
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const fields = new Set(changes.map((c) => c.field));
  const errors = {
    name: fields.has("name") && !draft.name.trim() ? t("newAgent.errors.nameRequired") : undefined,
    budget: edits.budget !== undefined && readBudget(edits.budget).invalid ? t("agent.budgetInvalid") : undefined,
    audience:
      (fields.has("audience") || fields.has("owner")) &&
      !audienceValid(draft.audience, draft.owner === NO_OWNER ? null : draft.owner)
        ? draft.audience.mode === "owner"
          ? t("audience.modeText.noOwner")
          : t("audience.pickSomeone")
        : undefined,
    repos:
      fields.has("repos") && draft.repos?.mode === "some" && draft.repos.list.length === 0
        ? t("repos.emptyError")
        : undefined,
  };
  const problem = errors.name ?? errors.budget ?? errors.audience ?? errors.repos;
  const dirty = changes.length > 0;

  /* ---------- Editing ---------- */

  const set: AgentEdit["set"] = (field, value) => setEdits((e) => ({ ...e, [field]: value }));
  const setLevel = (id: string, level: Level) =>
    setEdits((e) => ({ ...e, levels: { ...(e.levels ?? {}), [id]: level } }));
  const revert = (key: string) => setEdits((e) => revertKey(e, key));
  const discard = () => setEdits({});

  const goTo = (next: AgentTab, sec?: AgentSection) => {
    onNavigate(next, sec);
    const el = top.current;
    // The tabs stay where they are; the content starts from the top of the tabs.
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView?.({ block: "start" });
  };
  // A section in the URL: scroll to it once Configurações shows.
  useEffect(() => {
    if (tab !== "settings" || !section) return;
    const timer = setTimeout(() =>
      document.getElementById(`agp-sec-${section}`)?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
    return () => clearTimeout(timer);
  }, [tab, section]);

  /* ---------- Saving ---------- */

  /** A switch to Claude Code or Codex that reached the draft unconfirmed: the warning, before anything is saved. */
  const [termsAsk, setTermsAsk] = useState<"claude_code" | "codex" | null>(null);

  const save = async (opts: { termsAccepted?: boolean } = {}) => {
    if (saving || !dirty) return;
    if (problem) {
      toast.show(problem, "error");
      return;
    }
    const brainDraft = draft.brain && opts.termsAccepted ? { ...draft.brain, termsAccepted: true } : draft.brain;
    if (
      fields.has("brain") &&
      brainDraft &&
      brainDraft.brain !== "model" &&
      termsPending(saved.brain?.brain, brainDraft)
    ) {
      setTermsAsk(brainDraft.brain);
      return;
    }
    setSaving(true);
    const done: Field[] = [];
    let failed = false;
    const fail = (e: unknown, silent: boolean) => {
      failed = true;
      if (silent) toast.show(errorText(t, e), "error");
    };
    // 1. The agent itself: one PATCH (the owner may send only the look and the audience).
    const patch: Partial<Omit<AgentInput, "handle">> = {};
    const patchFields: Field[] = [];
    const put = <K extends keyof typeof patch>(field: Field, k: K, v: (typeof patch)[K]) => {
      patch[k] = v;
      patchFields.push(field);
    };
    if (fields.has("name")) put("name", "name", draft.name.trim());
    if (fields.has("role")) put("role", "role", draft.role.trim());
    if (fields.has("instructions")) put("instructions", "instructions", draft.instructions);
    if (fields.has("model")) put("model", "model", draft.model);
    if (fields.has("key")) put("key", "credentialId", draft.key === DEFAULT_KEY ? null : (draft.key ?? null));
    if (fields.has("budget")) put("budget", "monthlyBudgetUsd", budgetValue(draft.budget) ?? null);
    if (fields.has("owner")) put("owner", "ownerUserId", draft.owner === NO_OWNER ? null : draft.owner);
    if (fields.has("audience"))
      put("audience", "audience", {
        mode: draft.audience.mode,
        userIds: draft.audience.mode === "people" ? draft.audience.userIds : [],
      });
    if (fields.has("look")) put("look", "appearance", normalizeAppearance(draft.look));
    if (patchFields.length > 0) {
      try {
        const next = await update.mutateAsync(patch);
        // Show the saved values at once (the lists refetch behind).
        qc.setQueryData<Agent[]>(keys.agents(org.id), (list) =>
          list?.map((a) => (a.id === agent.id ? { ...a, ...next } : a)),
        );
        if (patch.credentialId !== undefined || patch.monthlyBudgetUsd !== undefined) {
          qc.setQueryData<AgentDetail>(keys.agentDetail(org.id, agent.id), (old) =>
            old
              ? {
                  ...old,
                  ...(patch.credentialId !== undefined ? { credentialId: patch.credentialId } : {}),
                  ...(patch.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: patch.monthlyBudgetUsd } : {}),
                }
              : old,
          );
        }
        done.push(...patchFields);
      } catch (e) {
        fail(e, false);
      }
    }
    // 2. Access levels: one write (reads the grants fresh, sets every changed level).
    if (!failed && fields.has("levels")) {
      const levels: Record<string, Level> = {};
      for (const c of changes) {
        const id = c.key.slice("levels:".length);
        const l = edits.levels?.[id];
        if (c.field === "levels" && l) levels[id] = l;
      }
      try {
        await setLevels.mutateAsync({ agentId: agent.id, changes: levels });
        done.push("levels");
      } catch (e) {
        fail(e, false);
      }
    }
    // 2b. GitHub repositories: the whole ordered list (empty = every repository).
    if (!failed && fields.has("repos") && draft.repos) {
      try {
        const next = await api.repositories.set(org.id, agent.id, repoListOf(draft.repos));
        qc.setQueryData<string[]>(keys.agentRepos(org.id, agent.id), next);
        done.push("repos");
      } catch (e) {
        fail(e, true);
      }
    }
    // 3. Skills: the whole library with on/off.
    if (!failed && fields.has("skills") && library.data) {
      try {
        const on = new Set(draft.skills ?? []);
        const next = await api.skills.setForAgent(
          org.id,
          agent.id,
          library.data.map((s) => ({ skillId: s.id, enabled: on.has(s.id) })),
        );
        qc.setQueryData<AgentSkill[]>(keys.agentSkills(org.id, agent.id), next);
        void qc.invalidateQueries({ queryKey: keys.skills(org.id) });
        done.push("skills");
      } catch (e) {
        fail(e, true);
      }
    }
    // 4. Channels: the PUT replaces the list, so start from what the server has now (DMs, private channels).
    if (!failed && fields.has("channels")) {
      try {
        const current = await api.agents.channels(org.id, agent.id);
        const next = await api.agents.setChannels(
          org.id,
          agent.id,
          channelsAfter(current, saved.channels ?? [], draft.channels ?? []),
        );
        qc.setQueryData<AgentDetail>(keys.agentDetail(org.id, agent.id), (old) =>
          old ? { ...old, channels: next } : old,
        );
        void qc.invalidateQueries({ queryKey: keys.agentDetail(org.id, agent.id) });
        done.push("channels");
      } catch (e) {
        fail(e, true);
      }
    }
    // 5. The computer.
    if (!failed && fields.has("machine")) {
      try {
        await setTarget.mutateAsync({
          agentId: agent.id,
          machineId: draft.machine === CLOUD ? null : (draft.machine ?? null),
        });
        done.push("machine");
      } catch (e) {
        fail(e, true);
      }
    }
    // 6. Who thinks (after the computer: what it offers depends on it).
    if (!failed && fields.has("brain") && brainDraft) {
      const next: BrainChoice = brainDraft;
      try {
        const view = await api.agents.setBrain(org.id, agent.id, {
          brain: next.brain,
          model: next.brain === "model" ? null : next.model,
          fallback: next.fallback,
          // Only once the person confirmed the warning (when choosing it, or on save).
          ...(next.brain !== "model" && next.brain !== saved.brain?.brain && next.termsAccepted === true
            ? { acceptPlanTerms: true }
            : {}),
        });
        qc.setQueryData<AgentBrain>(keys.agentBrain(org.id, agent.id), view);
        // Headers and cards show who thinks (`Agent.brain`).
        void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
        done.push("brain");
      } catch (e) {
        fail(e, true);
      }
    }
    // A new computer changes what can think.
    if (done.includes("machine")) void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) });
    setEdits((e) => dropFields(e, done));
    setSaving(false);
    if (!failed) toast.show(t("agent.savedToast", agentGrammar(t, draft.name.trim() || agent.name)));
  };

  // ⌘/Ctrl+S saves.
  const keyboard = useRef({ save, dirty });
  keyboard.current = { save, dirty };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        if (!keyboard.current.dirty) return;
        e.preventDefault();
        void keyboard.current.save();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- Leaving with unsaved changes ---------- */

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirtyRef.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  });

  /* ---------- Archiving ---------- */

  const archive = useMutation({
    mutationFn: () => api.agents.archive(org.id, agent.id),
    onSuccess: () => {
      setArchiving(false);
      setEdits({});
      dirtyRef.current = false;
      toast.show(t("agentPage.archive.done", g));
      void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
      void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
    },
  });

  /* ---------- Tabs ---------- */

  const pending = (proposals.data ?? []).filter(
    (p) => p.agentId === agent.id && p.status === "pending" && p.target.type === "agent_instructions",
  ).length;
  const failures =
    viewer === "member" ? 0 : (runs.data ?? []).filter((r) => r.status === "failed" && thisMonth(r.createdAt)).length;
  const tabLabel = (id: AgentTab): ReactNode => {
    const n = changes.filter((c) => c.tab === id).length;
    let badge: ReactNode = null;
    if (n > 0)
      badge = (
        <span className="agp-badge agp-badge--edit ac-num" title={t("agentPage.changesCount", { count: n })}>
          <Icon name="edit" size={14} />
          {n}
        </span>
      );
    else if (id === "memory" && pending > 0)
      badge = (
        <span
          className="agp-badge agp-badge--ask ac-num"
          title={t("agentPage.memory.waitingCount", { count: pending })}
        >
          {pending}
        </span>
      );
    else if (id === "activity" && failures > 0)
      badge = (
        <span className="agp-badge ac-num" title={t("agentPage.activity.failuresCount", { count: failures })}>
          {failures}
        </span>
      );
    return (
      <>
        {t(`agentPage.tabs.${id}`)}
        {badge}
      </>
    );
  };

  const value: AgentEdit = {
    agent,
    viewer,
    g,
    saved,
    draft,
    edits,
    set,
    setLevel,
    revert,
    changes,
    changeOf: (key) => byKey.get(key),
    can: (field) => canEdit(viewer, field),
    errors,
    resources,
    accessState: access.isLoading ? "loading" : access.data ? "ready" : "unavailable",
    goTo,
    pickRepos: (add) => {
      goTo("access");
      setPicking({ add });
    },
    ownerFirst,
  };

  return (
    <AgentEditProvider value={value}>
      <div className="page page--xwide agp" data-dirty={dirty || undefined}>
        <AgentHero onArchive={() => setArchiving(true)} />
        <div className="agp-tabs" ref={top}>
          <Tabs
            label={t("agentPage.tabsLabel", g)}
            value={tab}
            onValueChange={(next) => goTo(next)}
            items={AGENT_TABS.map((id) => ({ value: id, label: tabLabel(id) }))}
          >
            <TabPanel value={tab}>
              <div className="agp-view" key={tab}>
                {tab === "overview" && <OverviewTab />}
                {tab === "instructions" && <InstructionsTab />}
                {tab === "access" && <AccessTab />}
                {tab === "memory" && <MemoryTab />}
                {tab === "activity" && <ActivityTab />}
                {tab === "settings" && (
                  <SettingsTab
                    section={section}
                    onSection={(sec) => goTo("settings", sec)}
                    onArchive={() => setArchiving(true)}
                  />
                )}
              </div>
            </TabPanel>
          </Tabs>
        </div>
        <SaveBar saving={saving} onSave={() => void save()} onDiscard={discard} onJump={(c) => goTo(c.tab, c.sec)} />
      </div>
      {picking && (
        <RepoDialog
          add={picking.add}
          onClose={() => setPicking(null)}
          onUse={(next: RepoChoice) => {
            set("repos", next);
            setPicking(null);
          }}
        />
      )}

      <PlanTermsDialog
        brain={termsAsk}
        onCancel={() => setTermsAsk(null)}
        onConfirm={() => {
          const draftBrain = draft.brain;
          setTermsAsk(null);
          if (draftBrain) set("brain", { ...draftBrain, termsAccepted: true });
          void save({ termsAccepted: true });
        }}
      />

      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o) blocker.reset?.();
        }}
        title={t("agentPage.leave.title")}
        description={t("agentPage.leave.text", { count: changes.length, ...g })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => blocker.reset?.()}>{t("edit.keepEditing")}</Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            {t("agentPage.leave.discard")}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t("agentPage.archive.title", g)}
        description={t("agentPage.archive.text", g)}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setArchiving(false)}>{t("common.cancel")}</Button>
          <Button variant="danger" icon="archive" loading={archive.isPending} onClick={() => archive.mutate()}>
            {t("agentPage.archive.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    </AgentEditProvider>
  );
}
