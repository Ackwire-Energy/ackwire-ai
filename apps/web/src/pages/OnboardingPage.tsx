import type { Machine, Model, Role } from "@agenteschat/client";
import { keys, useConfirmDevice, useMachines, useSandboxSettings } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { computerKind } from "@agenteschat/client/lib/machines";
import {
  addInvites,
  type InviteDraft,
  ONBOARDING_STEPS,
  type OnboardingStepId,
  validInvites,
} from "@agenteschat/client/lib/onboarding";
import { AUTO, keyLooksValid, PROVIDERS, type ProviderId, providerLabel } from "@agenteschat/client/lib/providers";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { handleFrom } from "@agenteschat/client/lib/text";
import {
  type AgentAppearance,
  Avatar,
  Button,
  Card,
  CardFooter,
  CardHeader,
  ComputerPortrait,
  Field,
  Icon,
  type IconName,
  Input,
  Logo,
  normalizeAppearance,
  OptionCard,
  Select,
  Spinner,
  Textarea,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { PlanTermsDialog } from "@/components/AgentBrain";
import { ImportFlow, ImportReport, useImportFlow } from "@/components/ImportFlow";
import { ConnectComputer, osOf, PAIR_POLL_MS } from "@/components/Machines";
import { ImageCropDialog, OrgMark } from "@/components/ProfilePhoto";
import { OnboardingHorizon, OnboardingProgress, WelcomeSky } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import { OpenPrefsButton } from "@/components/ThisMac";
import { VaultCard } from "@/components/wiki/VaultCard";
import { useVaultReader } from "@/components/wiki/WikiImport";
import { ZonePicker } from "@/components/ZoneSelect";
import { inDesktopApp, thisMac } from "@/lib/desktop";
import { importedModel } from "@/lib/import";
import { choosable, itemId } from "@/lib/import-flow";
import { importVault } from "@/lib/obsidian";
import { useToast } from "@/lib/toast";
import "./onboarding.css";

export const PRESETS = ["theo", "ada", "lia", "atlas"] as const;
export type Preset = (typeof PRESETS)[number];

/** Instructions each onboarding preset starts with (same as the roles of "Criar agente"). */
const PRESET_ROLE: Record<Preset, "pm" | "dev" | "ops" | null> = { theo: "pm", ada: "dev", lia: null, atlas: "ops" };
/** Each preset's own look (color, eyes, accessory), saved on the agent it creates. */
export const PRESET_LOOK: Record<Preset, Required<AgentAppearance>> = {
  theo: { color: "indigo", eyes: "round", accessory: "cap" },
  ada: { color: "green", eyes: "wide", accessory: "headphones" },
  lia: { color: "rose", eyes: "dots", accessory: "flower" },
  atlas: { color: "amber", eyes: "round", accessory: "antenna" },
};
/** The agent guiding the onboarding (always on the team: "Eu já estou aqui"). */
const GUIDE: Preset = "ada";
/** Who hosts each step: the agent asking its question (introducing itself the first time). */
const HOST: Record<OnboardingStepId, Preset> = {
  workspace: "ada",
  context: "lia",
  import: "theo",
  computer: "atlas",
  agents: "ada",
  team: "theo",
  done: "ada",
};
/** How long the guide keeps writing after a keystroke, and smiling after a step. */
const TYPING_MS = 900;
const HAPPY_MS = 1600;

type Computer = "cloud" | "machine" | null;
/** An agent created here (a preset or an imported one), for the later steps. */
interface CrewMember {
  key: string;
  name: string;
  appearance: AgentAppearance;
  initials?: string;
}
/** An imported agent once created: its id (also its `key`: a source key can repeat a preset's) and handle. */
interface ImportedCrew extends CrewMember {
  id: string;
  handle: string;
}

/** The guide's mood: writing while the person types, happy for a moment after a step. */
function useGuideMood() {
  const [typing, setTyping] = useState(false);
  const [happy, setHappy] = useState(false);
  const timers = useRef<{ typing?: ReturnType<typeof setTimeout>; happy?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.typing);
      clearTimeout(t.happy);
    };
  }, []);
  return {
    typing,
    happy,
    onTyping: () => {
      setTyping(true);
      clearTimeout(timers.current.typing);
      timers.current.typing = setTimeout(() => setTyping(false), TYPING_MS);
    },
    cheer: () => {
      setTyping(false);
      setHappy(true);
      clearTimeout(timers.current.happy);
      timers.current.happy = setTimeout(() => setHappy(false), HAPPY_MS);
    },
  };
}

/**
 * The onboarding: the steps on a rail (the pixel sky
 * on top fills as they get done); each step is one calm screen hosted by an
 * agent of the team, who asks in a speech bubble (introducing itself the first
 * time); one big action under the answer, "Pular esta etapa" on optional steps.
 */
export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const guide = useGuideMood();

  const [index, setIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [done, setDone] = useState<Set<OnboardingStepId>>(new Set());
  // The step where each host agent first showed up (it introduces itself there only).
  const [metAt, setMetAt] = useState<Partial<Record<Preset, OnboardingStepId>>>({});
  // Workspace
  const [org, setOrg] = useState("");
  const [zone, setZone] = useState(() => browserTimezone() ?? "UTC");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [logo, setLogo] = useState<{ imageBase64: string; contentType: string } | null>(null);
  const [logoDirty, setLogoDirty] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  // Context
  const [context, setContext] = useState("");
  const [savedContext, setSavedContext] = useState("");
  const contextBox = useRef<HTMLTextAreaElement>(null);
  // An Obsidian vault for the wiki: read in step 2, imported when it continues.
  const vault = useVaultReader([]);
  const [vaultPages, setVaultPages] = useState<number | null>(null);
  // Import: read and planned in its step, applied with the agents (their model depends on the key chosen there).
  const flow = useImportFlow(created?.orgId ?? null);
  const [importedCrew, setImportedCrew] = useState<ImportedCrew[]>([]);
  // Agents and key: first who joins, then (when nothing else thinks for them) the key.
  const [chosen, setChosen] = useState<Set<Preset>>(new Set(PRESETS));
  const [agentsPhase, setAgentsPhase] = useState<"pick" | "key">("pick");
  const [agentIds, setAgentIds] = useState<Partial<Record<Preset, string>>>({});
  // The workspace key: a provider's key, or the platform key where the server offers one.
  const [key, setKey] = useState<ProviderId | "platform">("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [openaiOrg, setOpenaiOrg] = useState("");
  const [openaiProject, setOpenaiProject] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [platform, setPlatform] = useState(false);
  // The monthly budget of every agent (US$, API usage only); null = the workspace default as it is.
  const [budget, setBudget] = useState<string | null>(null);
  // Computer (before the agents): with one connected, the model step can pick its Claude Code.
  const [computer, setComputer] = useState<Computer>(null);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [brain, setBrain] = useState<"model" | "claude_code">("model");
  const [askingTerms, setAskingTerms] = useState(false);
  // Team
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [sent, setSent] = useState<Set<string>>(new Set());

  const step = ONBOARDING_STEPS[index] ?? ONBOARDING_STEPS[0];
  const total = ONBOARDING_STEPS.length;
  const orgName = org.trim() || t("onboarding.yourCompany");
  const presetInfo = (p: Preset) => ({
    name: t(`onboarding.presets.${p}.name`),
    role: t(`onboarding.presets.${p}.role`),
    desc: t(`onboarding.presets.${p}.desc`),
  });
  const createdPresets = PRESETS.filter((p) => agentIds[p]);
  /** The imported agents to choose in "Agentes e chave": the ones the plan creates or updates. */
  const importAgents = (flow.planned?.items ?? []).flatMap((i) => {
    const agent = i.kind === "agent" && choosable(i) ? flow.planned?.bundle.agents.find((a) => a.key === i.key) : null;
    return agent ? [{ id: itemId(i), agent, handle: i.renamedTo ?? agent.handle }] : [];
  });
  const pickedImports = importAgents.filter((x) => flow.pick.has(x.id)).map((x) => x.agent);
  const chosenCount = chosen.size + pickedImports.length;
  /** Who joins besides the guide (it is "already here" in the copy). */
  const joining = chosenCount - (chosen.has(GUIDE) ? 1 : 0);
  const crew: CrewMember[] = [
    ...createdPresets.map((p) => ({
      key: p,
      name: presetInfo(p).name,
      appearance: PRESET_LOOK[p],
      initials: p === "atlas" ? "At" : undefined,
    })),
    ...importedCrew,
  ];
  const ready = validInvites(invites);
  const toSend = ready.filter((i) => !sent.has(i.email));
  /** Agents think through the connected computer's Claude Code: then the API key is optional. */
  const thinksOnComputer = computer === "machine" && machine !== null && brain === "claude_code";
  const needsKey = !keySaved && !thinksOnComputer;

  // The host of this step meets you here the first time.
  const host = HOST[step.id];
  useEffect(() => {
    setMetAt((m) => (m[host] ? m : { ...m, [host]: step.id }));
  }, [host, step.id]);

  const saveWorkspace = useMutation({
    mutationFn: async () => {
      let target = created;
      if (!target) {
        const res = await api.orgs.create({ name: org.trim() });
        target = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
        setCreated(target);
        await api.orgs.updateSettings(target.orgId, { timezone: zone });
        // The person's own zone and language, detected here: agents read the local time from it.
        const mine = browserTimezone();
        await Promise.all([
          mine ? api.orgs.updateMe(target.orgId, { timezone: mine }) : null,
          api.account.updateMe({ locale: i18n.language.startsWith("en") ? "en" : "pt-BR" }),
        ]).catch(() => undefined);
        // The platform key is only offered where the server has one (Cloud).
        const available = await api.agents.platformKeyAvailable(target.orgId).catch(() => false);
        setPlatform(available);
        if (!available) setKey((k) => (k === "platform" ? "anthropic" : k));
      } else {
        await api.orgs.updateSettings(target.orgId, { name: org.trim(), timezone: zone });
      }
      // The logo needs the workspace: picked before it existed, sent now.
      if (logoDirty) {
        if (logo) await api.orgs.setLogo(target.orgId, logo);
        else await api.orgs.removeLogo(target.orgId);
        setLogoDirty(false);
      }
      await qc.invalidateQueries({ queryKey: keys.me });
    },
  });

  const saveContext = useMutation({
    mutationFn: async () => {
      if (!created || context === savedContext) return;
      await api.orgs.updateSettings(created.orgId, { context });
      setSavedContext(context);
    },
  });

  const importWiki = useMutation({
    mutationFn: async () => {
      if (!created || !vault.report) return;
      const result = await importVault(api, created.orgId, vault.report, {
        folders: new Set(vault.report.folders.map((f) => f.name)),
        into: "",
        onConflict: "keep_both",
      });
      setVaultPages(result.created.length);
    },
    onError: (e) => toast.show(errorText(t, e), "error"),
  });

  /**
   * The import picked in its step, in one apply: each agent keeps its own
   * model when the chosen key runs it, else starts on "Automático"; the agents
   * it brings join #general.
   */
  const applyImported = async (list: { models: Model[] }, provider: string) => {
    const crewSoFar = [...importedCrew];
    const bundle = flow.planned?.bundle;
    if (!created || !bundle) return crewSoFar;
    const runnable = list.models.filter((m) => m.provider === provider).map((m) => m.id);
    const items = await flow.apply((b) => ({
      ...b,
      agents: b.agents.map((a) => ({ ...a, model: importedModel(a, runnable, AUTO) ?? null })),
    }));
    // The report waits for the last step.
    flow.focus.current = null;
    for (const item of items) {
      const agent = bundle.agents.find((a) => a.key === item.key);
      if (item.kind !== "agent" || !item.targetId || !agent || crewSoFar.some((c) => c.id === item.targetId)) continue;
      await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: item.targetId });
      crewSoFar.push({
        key: item.targetId,
        id: item.targetId,
        handle: item.renamedTo ?? agent.handle,
        name: agent.name,
        appearance: normalizeAppearance(agent.appearance),
      });
      setImportedCrew([...crewSoFar]);
    }
    return crewSoFar;
  };

  // The workspace default budget, shown (and changed) next to the key.
  const settings = useQuery({
    queryKey: ["onboarding", "settings", created?.orgId],
    queryFn: () => api.orgs.settings(created?.orgId ?? ""),
    enabled: Boolean(created) && step.id === "agents",
    staleTime: Number.POSITIVE_INFINITY,
  });
  const budgetValue = budget ?? (settings.data?.defaultAgentBudgetUsd?.toString() || "");
  const budgetOk = budgetValue === "" || (Number.isFinite(Number(budgetValue)) && Number(budgetValue) >= 0);

  const saveAgents = useMutation({
    /** `keyLater`: "Conectar depois", the agents come without a key (they answer once an AI is connected). */
    mutationFn: async (keyLater: boolean) => {
      if (!created) return;
      // No key needed when the agents think on the connected computer; one pasted is still saved.
      if (!keyLater && key !== "platform" && !keySaved && apiKey.trim()) {
        const cred = await api.agents.addCredential(created.orgId, {
          provider: key,
          label: providerLabel(key),
          apiKey: apiKey.trim(),
          ...(key === "anthropic" && workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
          ...(key === "openai" && openaiOrg.trim() ? { organizationId: openaiOrg.trim() } : {}),
          ...(key === "openai" && openaiProject.trim() ? { projectId: openaiProject.trim() } : {}),
        });
        // Every agent, the router, summaries and reflection use the workspace default key.
        await api.orgs.updateSettings(created.orgId, { defaultCredentialId: cred.id });
        setKeySaved(true);
      }
      if (budget !== null && budgetOk && budget !== "" && Number(budget) !== settings.data?.defaultAgentBudgetUsd) {
        await api.orgs.updateSettings(created.orgId, { defaultAgentBudgetUsd: Number(budget) });
      }
      const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
      const ids = { ...agentIds };
      for (const p of PRESETS) {
        if (!chosen.has(p) || ids[p]) continue;
        const info = presetInfo(p);
        const role = PRESET_ROLE[p];
        const agent = await api.agents.create(created.orgId, {
          name: info.name,
          handle: handleFrom(info.name),
          role: info.role,
          instructions: role ? t(`newAgent.roles.${role}.instructions`) : t("onboarding.presets.lia.instructions"),
          // "Automático": each task gets its model and effort.
          model: AUTO,
          // null = the workspace default key.
          credentialId: null,
          appearance: PRESET_LOOK[p],
        });
        await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: agent.id });
        ids[p] = agent.id;
        setAgentIds({ ...ids });
      }
      // Imported: one apply after the presets (a handle a preset took gets the next free one).
      const crewSoFar = await applyImported(list, key === "platform" ? "anthropic" : key);
      // The connected computer chosen a step before: every agent works there, and thinks with its
      // Claude Code when that was picked (the person confirmed the plan warning).
      if (computer !== "machine" || !machine) return;
      const all = [...PRESETS.flatMap((p) => (ids[p] ? [ids[p]] : [])), ...crewSoFar.map((c) => c.id)];
      for (const agentId of all) await api.sandbox.setTarget(created.orgId, agentId, machine.id);
      if (brain !== "claude_code") return;
      let failed = false;
      for (const agentId of all) {
        await api.agents
          .setBrain(created.orgId, agentId, { brain: "claude_code", fallback: true, acceptPlanTerms: true })
          .catch(() => {
            failed = true;
          });
      }
      if (failed) toast.show(t("onboarding.brain.failed", { computer: machine.name }), "error");
    },
  });

  const sandbox = useSandboxSettings(created?.orgId ?? "", Boolean(created) && step.id === "computer");
  const cloudAvailable = sandbox.data?.available !== false;

  const saveComputer = useMutation({
    mutationFn: async () => {
      if (!created) return;
      if (computer === "cloud" && sandbox.data?.available && !sandbox.data.enabled) {
        const saved = await api.sandbox.saveSettings(created.orgId, { enabled: true });
        qc.setQueryData(keys.sandboxSettings(created.orgId), saved);
      }
      // The agents come next: they go to the connected computer when they are created.
    },
  });

  const sendInvites = useMutation({
    mutationFn: async () => {
      if (!created) return;
      const next = new Set(sent);
      for (const invite of toSend) {
        try {
          await api.orgs.invite(created.orgId, { email: invite.email, role: invite.role });
          next.add(invite.email);
        } catch (err) {
          toast.show(`${invite.email}: ${errorText(t, err)}`, "error");
        }
      }
      setSent(next);
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      if (!created) return;
      await qc.invalidateQueries({ queryKey: keys.me });
      await navigate({
        to: "/org/$orgId/c/$channelId",
        params: { orgId: created.orgId, channelId: created.generalChannelId },
      });
    },
  });

  const go = (i: number) => {
    const next = Math.max(0, Math.min(total - 1, i));
    setIndex(next);
    setReached((r) => Math.max(r, next));
    setAgentsPhase("pick");
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      try {
        window.scrollTo({ top: 0 });
      } catch {
        // jsdom/happy-dom without scrolling.
      }
    }
  };

  /**
   * Saves what the step needs, marks it done and moves on. `skip` leaves an optional step as it is;
   * `keyLater` creates the agents without a key.
   */
  const advance = async (how?: "skip" | "keyLater") => {
    const skip = how === "skip";
    if (step.id === "done") {
      await finish.mutateAsync();
      return;
    }
    if (!skip) {
      if (step.id === "workspace") await saveWorkspace.mutateAsync();
      if (step.id === "context") {
        await saveContext.mutateAsync();
        // The vault goes in the background: the next steps don't wait for the attachments.
        if (vault.report && vaultPages === null && !importWiki.isPending) importWiki.mutate();
      }
      if (step.id === "agents") {
        // Without a computer that thinks for them, the agents need a key: its own screen first.
        if (agentsPhase === "pick" && needsKey) {
          setAgentsPhase("key");
          return;
        }
        await saveAgents.mutateAsync(how === "keyLater");
      }
      if (step.id === "computer") await saveComputer.mutateAsync();
      if (step.id === "team") await sendInvites.mutateAsync();
    } else if (step.id === "computer") {
      setComputer(null);
      setMachine(null);
      setBrain("model");
    } else if (step.id === "import") {
      flow.reset();
      flow.setCard(null);
    }
    setDone((d) => new Set(d).add(step.id));
    guide.cheer();
    go(index + 1);
  };

  const busy =
    saveWorkspace.isPending ||
    saveContext.isPending ||
    saveAgents.isPending ||
    flow.busy !== null ||
    saveComputer.isPending ||
    sendInvites.isPending ||
    finish.isPending;
  const keyOk = key === "platform" || keySaved || keyLooksValid(key, apiKey);
  const blocked =
    (step.id === "workspace" && !org.trim()) ||
    (step.id === "agents" && agentsPhase === "key" && (!keyOk || !budgetOk)) ||
    (step.id === "import" && !flow.planned) ||
    (step.id === "computer" && (computer === null || (computer === "machine" && !machine)));

  // What the rail shows under each done step.
  const railValue: Partial<Record<OnboardingStepId, string>> = {
    workspace: org.trim() || undefined,
    context: context.trim() ? t("onboarding.railValue.context") : undefined,
    import: pickedImports.length
      ? joinNames(
          pickedImports.map((a) => a.name),
          t("newAgent.and"),
        )
      : t("onboarding.railValue.skipped"),
    computer:
      computer === "cloud"
        ? t("onboarding.done.computerCloud")
        : computer === "machine" && machine
          ? machine.name
          : t("onboarding.railValue.skipped"),
    agents: crew.length
      ? joinNames(
          crew.map((c) => c.name),
          t("newAgent.and"),
        )
      : undefined,
    team: sent.size ? t("onboarding.railValue.invites", { count: sent.size }) : t("onboarding.railValue.later"),
  };

  // The question: the step's, or the key's on the agents' second screen.
  const metNames = (["lia", "theo", "atlas"] as Preset[])
    .filter((p) => metAt[p] && chosen.has(p))
    .map((p) => presetInfo(p).name);
  const ask =
    step.id === "done"
      ? null
      : step.id === "agents" && agentsPhase === "key"
        ? { title: t("onboarding.keyStep.title"), lead: t("onboarding.keyStep.lead") }
        : {
            title:
              step.id === "agents" && importAgents.length
                ? t("onboarding.agents.importedTitle")
                : t(`onboarding.${step.id}.title`),
            lead:
              step.id === "agents" && metNames.length
                ? t("onboarding.agents.leadMet", { names: joinNames(metNames, t("newAgent.and")) })
                : t(`onboarding.${step.id}.lead`),
          };
  const intro = metAt[host] === undefined || metAt[host] === step.id ? t(`onboarding.hosts.${host}`) : null;

  const primaryLabel =
    step.id === "done"
      ? t("onboarding.done.open")
      : step.id === "computer" && computer === "cloud"
        ? t("onboarding.actions.useCloud")
        : step.id === "agents" && agentsPhase === "pick" && !needsKey && joining > 0
          ? t("onboarding.actions.create", { count: joining })
          : step.id === "agents" && agentsPhase === "key" && joining > 0
            ? t("onboarding.actions.saveAndCreate", { count: joining })
            : step.id === "team" && toSend.length > 0
              ? t("onboarding.actions.invite", { count: toSend.length })
              : t("onboarding.actions.continue");
  // "Pular esta etapa" only on optional steps ("agents" never is, so its key phase needs no exception).
  const showSkip = step.optional;
  const back = () => {
    if (step.id === "agents" && agentsPhase === "key") setAgentsPhase("pick");
    else go(index - 1);
  };

  return (
    <div className="onb">
      <aside className="onb__rail">
        <span className="onb__brand">
          <Logo size={22} />
        </span>
        <div className="onb__progress">
          <span className="onb__progress-text">
            <span>
              {done.size >= total - 1
                ? t("onboarding.progress.done")
                : t("onboarding.progress.left", { count: total - 1 - done.size })}
            </span>
            <span className="onb__progress-count">
              {t("onboarding.progress.count", { n: done.size, total: total - 1 })}
            </span>
          </span>
          <OnboardingProgress progress={done.size / (total - 1)} />
        </div>
        <StepRail
          label={t("onboarding.stepsLabel")}
          current={index}
          onGo={go}
          doneLabel={t("onboarding.stepDone")}
          optionalLabel={t("onboarding.optionalTag")}
          steps={ONBOARDING_STEPS.map((s, i) => ({
            id: s.id,
            name: t(`onboarding.stepNames.${s.id}`),
            done: done.has(s.id),
            disabled: i > reached || busy || (created === null && i > 0),
            optional: s.optional,
            value: railValue[s.id],
          }))}
        />
        <OnboardingHorizon progress={done.size / (total - 1)} />
      </aside>

      <main
        className="onb__main"
        onInput={guide.onTyping}
        onKeyDown={(e) => {
          // Enter continues (the big button shows ↵), except where Enter means something else.
          const el = e.target as HTMLElement;
          if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          // In the context box Enter is a new line; ⌘/Ctrl+Enter continues there.
          if (el.closest("textarea") && !(e.metaKey || e.ctrlKey)) return;
          if (el.closest("button, a, [role='dialog'], [role='listbox'], [role='combobox']")) return;
          if (blocked || busy) return;
          e.preventDefault();
          void advance().catch(() => {});
        }}
      >
        <div className="onb__body" key={`${step.id}-${agentsPhase}`}>
          {(index > 0 || agentsPhase === "key") && (
            <button type="button" className="onb__back" onClick={back} disabled={busy}>
              <Icon name="chevronLeft" size={16} />
              {t("onboarding.back")}
            </button>
          )}

          {ask && (
            <HostAsk
              name={presetInfo(host).name}
              appearance={PRESET_LOOK[host]}
              initials={host === "atlas" ? "At" : undefined}
              fresh={metAt[host] === undefined || metAt[host] === step.id}
              typing={guide.typing}
              happy={guide.happy}
              intro={intro}
              title={ask.title}
              lead={ask.lead}
            />
          )}

          {step.id === "workspace" && (
            <div className="onb__answer">
              <div className="onb__ws">
                <button
                  type="button"
                  className="onb__logo"
                  aria-label={logo ? t("onboarding.workspace.logoChange") : t("onboarding.workspace.logoPick")}
                  title={t("onboarding.workspace.logoHelp")}
                  onClick={() => setLogoOpen(true)}
                >
                  {logo ? (
                    <OrgMark logo={`data:${logo.contentType};base64,${logo.imageBase64}`} size={56} />
                  ) : org.trim() ? (
                    <span className="onb__logo-letter">{org.trim().charAt(0).toUpperCase()}</span>
                  ) : (
                    <Icon name="upload" />
                  )}
                </button>
                <Input
                  className="onb__big"
                  aria-label={t("onboarding.workspace.name")}
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder={t("onboarding.workspace.namePlaceholder")}
                  autoFocus
                />
              </div>
              {zoneOpen ? (
                <Field
                  label={t("onboarding.workspace.timezone")}
                  id="org-zone"
                  help={t("onboarding.workspace.timezoneHelp")}
                >
                  <ZonePicker
                    id="org-zone"
                    value={zone}
                    onChange={setZone}
                    suggested={[browserTimezone() ?? "", "UTC"].filter(Boolean)}
                  />
                </Field>
              ) : (
                <p className="onb__help">
                  {t("onboarding.workspace.zone", { zone })} ·{" "}
                  <button type="button" className="onb__link" onClick={() => setZoneOpen(true)}>
                    {t("onboarding.workspace.zoneChange")}
                  </button>
                </p>
              )}
              <ImageCropDialog
                open={logoOpen}
                onClose={() => setLogoOpen(false)}
                title={t("orgLogo.title")}
                help={t("orgLogo.help")}
                placeholder={<OrgMark size={56} />}
                hasImage={logo !== null}
                removeLabel={t("orgLogo.remove")}
                format="image/png"
                save={async (image) => {
                  setLogo(image);
                  setLogoDirty(true);
                }}
                remove={async () => {
                  setLogo(null);
                  setLogoDirty(true);
                }}
                onSaved={() => setLogoOpen(false)}
                onRemoved={() => setLogoOpen(false)}
              />
            </div>
          )}

          {step.id === "context" && (
            <div className="onb__answer">
              <Textarea
                ref={contextBox}
                className="onb__big"
                rows={6}
                aria-label={t("onboarding.context.label")}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={t("onboarding.context.placeholder", { org: orgName })}
                autoFocus
              />
              <div className="onb__starters">
                {(["sell", "who", "rules"] as const).map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant="ghost"
                    icon="plus"
                    className="onb__starter"
                    onClick={() => {
                      const text = t(`onboarding.context.starters.${k}.text`);
                      const next = context.trim() ? `${context.replace(/\s*$/, "")}\n${text}` : text;
                      setContext(next);
                      requestAnimationFrame(() => {
                        const box = contextBox.current;
                        box?.focus();
                        box?.setSelectionRange(next.length, next.length);
                      });
                    }}
                  >
                    {t(`onboarding.context.starters.${k}.label`)}
                  </Button>
                ))}
              </div>
              <VaultCard reader={vault} />
            </div>
          )}

          {step.id === "import" && created && (
            <div className="onb__answer">
              <ImportFlow flow={flow} orgId={created.orgId} />
            </div>
          )}

          {step.id === "computer" && created && (
            <div className="onb__answer">
              <ComputerStep
                orgId={created.orgId}
                computer={computer}
                cloudAvailable={cloudAvailable}
                machine={machine}
                onChoose={(c) => {
                  setComputer(c);
                  if (c !== "machine") {
                    setMachine(null);
                    setBrain("model");
                  }
                }}
                onPaired={(m) => {
                  setMachine(m);
                  // Thinking on the computer is what spares the key; the plan warning comes first.
                  setAskingTerms(true);
                }}
              />
              <PlanTermsDialog
                brain={askingTerms ? "claude_code" : null}
                onCancel={() => setAskingTerms(false)}
                onConfirm={() => {
                  setBrain("claude_code");
                  setAskingTerms(false);
                }}
              />
            </div>
          )}

          {step.id === "agents" && agentsPhase === "pick" && (
            <div className="onb__answer">
              {importAgents.length > 0 && (
                // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
                <div className="grid-options" role="group" aria-label={t("onboarding.agents.importedLabel")}>
                  {importAgents.map(({ id, agent: a, handle }) => (
                    <OptionCard
                      key={id}
                      agent
                      pressed={flow.pick.has(id)}
                      onClick={() => flow.toggle([id], !flow.pick.has(id))}
                    >
                      <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} />
                      <span className="ac-option__text">
                        <span className="ac-option__title">{a.role ? `${a.name} · ${a.role}` : a.name}</span>
                        <span className="ac-option__desc">@{handle}</span>
                      </span>
                    </OptionCard>
                  ))}
                </div>
              )}
              {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
              <div className="grid-options" role="group" aria-label={t("onboarding.agents.listLabel")}>
                {PRESETS.filter((p) => p !== GUIDE).map((p) => {
                  const info = presetInfo(p);
                  return (
                    <OptionCard
                      key={p}
                      agent
                      pressed={chosen.has(p)}
                      onClick={() =>
                        setChosen((c) => {
                          const next = new Set(c);
                          if (next.has(p)) next.delete(p);
                          else next.add(p);
                          return next;
                        })
                      }
                    >
                      <AgentAvatar
                        name={info.name}
                        initials={p === "atlas" ? "At" : undefined}
                        appearance={PRESET_LOOK[p]}
                      />
                      <span className="ac-option__text">
                        <span className="ac-option__title">
                          {info.name} · {info.role}
                        </span>
                        <span className="ac-option__desc">{info.desc}</span>
                      </span>
                    </OptionCard>
                  );
                })}
              </div>
              {computer === "machine" && machine && (
                <Card as="section" aria-labelledby="brain-title">
                  <div className="stack-4">
                    <h2 id="brain-title" className="section-title">
                      {t("onboarding.brain.title")}
                    </h2>
                    <span className="small muted">{t("onboarding.brain.help", { computer: machine.name })}</span>
                  </div>
                  {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
                  <div className="grid-options grid-options--sm" role="group" aria-label={t("onboarding.brain.title")}>
                    <OptionCard
                      pressed={brain === "claude_code"}
                      onClick={() => brain !== "claude_code" && setAskingTerms(true)}
                    >
                      <span className="ac-option__text">
                        <span className="ac-option__title">
                          {t("onboarding.brain.claudeCode", { computer: machine.name })}
                        </span>
                        <span className="ac-option__desc">{t("onboarding.brain.claudeCodeDesc")}</span>
                      </span>
                    </OptionCard>
                    <OptionCard pressed={brain === "model"} onClick={() => setBrain("model")}>
                      <span className="ac-option__text">
                        <span className="ac-option__title">{t("onboarding.brain.model")}</span>
                        <span className="ac-option__desc">{t("onboarding.brain.modelDesc")}</span>
                      </span>
                    </OptionCard>
                  </div>
                  <PlanTermsDialog
                    brain={askingTerms ? "claude_code" : null}
                    onCancel={() => setAskingTerms(false)}
                    onConfirm={() => {
                      setBrain("claude_code");
                      setAskingTerms(false);
                    }}
                  />
                </Card>
              )}
            </div>
          )}

          {step.id === "agents" && agentsPhase === "key" && (
            <div className="onb__answer">
              {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
              <div className="grid-options grid-options--sm" role="group" aria-label={t("onboarding.provider")}>
                {PROVIDERS.map((p) => (
                  <OptionCard key={p.id} pressed={key === p.id} onClick={() => setKey(p.id)}>
                    <span className="ac-option__title">{p.label}</span>
                  </OptionCard>
                ))}
                {platform && (
                  <OptionCard pressed={key === "platform"} onClick={() => setKey("platform")}>
                    <span className="ac-option__text">
                      <span className="ac-option__title">{t("onboarding.platformChoice")}</span>
                      <span className="ac-option__desc">{t("onboarding.platformKeyDesc")}</span>
                    </span>
                  </OptionCard>
                )}
              </div>
              {key !== "platform" && (
                <>
                  <Field
                    label={t("onboarding.keyFor", { provider: providerLabel(key) })}
                    id="key-value"
                    error={keyTouched && !keyOk ? t(`onboarding.keyInvalid.${key}`) : undefined}
                  >
                    <Input
                      className="onb__big"
                      type="password"
                      placeholder={PROVIDERS.find((p) => p.id === key)?.placeholder}
                      autoComplete="off"
                      autoFocus
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      onBlur={() => setKeyTouched(apiKey.trim().length > 0)}
                    />
                  </Field>
                  <div>
                    <Button variant="ghost" size="sm" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
                      <Icon
                        name="chevronDown"
                        size={16}
                        style={advanced ? { transform: "rotate(180deg)" } : undefined}
                      />
                      {t("onboarding.advanced")}
                    </Button>
                  </div>
                  {advanced && key === "anthropic" && (
                    <Field
                      label={t("onboarding.anthropicWorkspace")}
                      id="key-ws"
                      help={t("onboarding.anthropicWorkspaceHelp")}
                    >
                      <Input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} autoComplete="off" />
                    </Field>
                  )}
                  {advanced && key === "openai" && (
                    <div className="grid-fields">
                      <Field label={t("onboarding.openaiOrg")} id="key-org" help={t("onboarding.optional")}>
                        <Input value={openaiOrg} onChange={(e) => setOpenaiOrg(e.target.value)} placeholder="org-…" />
                      </Field>
                      <Field label={t("onboarding.openaiProject")} id="key-project" help={t("onboarding.optional")}>
                        <Input
                          value={openaiProject}
                          onChange={(e) => setOpenaiProject(e.target.value)}
                          placeholder="proj_…"
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
              <p className="onb__help">
                {t("onboarding.suggestedAuto")}{" "}
                <button
                  type="button"
                  className="onb__link"
                  onClick={() => go(ONBOARDING_STEPS.findIndex((s) => s.id === "computer"))}
                >
                  {t("onboarding.keyStep.useComputer")}
                </button>
              </p>
              <BudgetCard
                value={budgetValue}
                invalid={!budgetOk}
                platform={key === "platform"}
                onChange={(v) => setBudget(v)}
              />
            </div>
          )}

          {step.id === "team" && created && (
            <div className="onb__answer">
              <TeamStep orgId={created.orgId} invites={invites} sent={sent} onChange={setInvites} agents={crew} />
            </div>
          )}

          {step.id === "done" && (
            <DoneStep
              orgName={orgName}
              agents={crew}
              computer={computer === "cloud" ? "cloud" : computer === "machine" ? (machine?.name ?? null) : undefined}
              invites={sent.size}
              wiki={vault.report ? (importWiki.isPending ? null : vaultPages) : undefined}
            />
          )}
          {step.id === "done" && created && flow.report && (
            <Card as="div">
              <ImportReport
                flow={flow}
                orgId={created.orgId}
                onRetry={async () => {
                  const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
                  await applyImported(list, key === "platform" ? "anthropic" : key);
                }}
              />
            </Card>
          )}

          <div className="onb__actions">
            <Button
              variant="primary"
              size="lg"
              block
              kbd={["↵"]}
              onClick={() => void advance().catch(() => {})}
              disabled={blocked || busy}
              loading={busy}
            >
              {primaryLabel}
            </Button>
            {showSkip && (
              <Button variant="ghost" onClick={() => void advance("skip").catch(() => {})} disabled={busy}>
                {t("onboarding.skip")}
              </Button>
            )}
            {step.id === "agents" && agentsPhase === "key" && (
              <>
                <Button variant="ghost" onClick={() => void advance("keyLater").catch(() => {})} disabled={busy}>
                  {t("connectAi.later")}
                </Button>
                <p className="onb__help">{t("connectAi.laterNote")}</p>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** The step's host: the agent (popping in the first time) and its speech bubble with the question. */
function HostAsk({
  name,
  appearance,
  initials,
  fresh,
  typing,
  happy,
  intro,
  title,
  lead,
}: {
  name: string;
  appearance: AgentAppearance;
  initials?: string;
  /** First time this agent shows up: it pops in and introduces itself. */
  fresh: boolean;
  typing: boolean;
  happy: boolean;
  intro: string | null;
  title: string;
  lead: string;
}) {
  return (
    <header className="onb__ask">
      <span className="onb__host" data-fresh={fresh || undefined}>
        <AgentAvatar
          name={name}
          initials={initials}
          appearance={appearance}
          size="lg"
          state={typing ? "writing" : undefined}
          expression={happy || fresh ? "happy" : undefined}
        />
        <span className="onb__host-name">{name}</span>
      </span>
      <div className="onb__bubble">
        {intro && <p className="onb__intro">{intro}</p>}
        <h1 className="onb__title">{title}</h1>
        <p className="onb__lead">{lead}</p>
      </div>
    </header>
  );
}

/** The monthly budget of every agent: what the API usage may cost, and who charges it. */
function BudgetCard({
  value,
  invalid,
  platform,
  onChange,
}: {
  value: string;
  invalid: boolean;
  platform: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card as="section" aria-labelledby="budget-title">
      <CardHeader
        icon="wallet"
        id="budget-title"
        title={t("onboarding.budget.title")}
        subtitle={t("onboarding.budget.sub")}
        action={
          <span className="onb__money" data-invalid={invalid || undefined}>
            <span aria-hidden="true">US$</span>
            <input
              inputMode="decimal"
              aria-label={t("onboarding.budget.label")}
              value={value}
              onChange={(e) => onChange(e.target.value.replace(",", "."))}
            />
            <span aria-hidden="true">{t("onboarding.budget.perMonth")}</span>
          </span>
        }
      />
      <CardFooter>{platform ? t("onboarding.budget.notePlatform") : t("onboarding.budget.noteKey")}</CardFooter>
    </Card>
  );
}

/** A choice card with an icon (computer step). */
function ChoiceCard({
  icon,
  art,
  title,
  desc,
  pressed,
  disabled,
  onClick,
}: {
  icon?: IconName;
  /** A picture instead of the icon (the computer step's portraits). */
  art?: ReactNode;
  title: string;
  desc: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const body = (
    <>
      {art ? (
        <span className="onb__art">{art}</span>
      ) : (
        icon && (
          <span className="onb__ic" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )
      )}
      <span className="ac-option__title">{title}</span>
      <span className="ac-option__desc">{desc}</span>
    </>
  );
  if (disabled) {
    return (
      <div className="ac-option ac-option--stacked onb__choice" aria-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <OptionCard stacked pressed={pressed} onClick={onClick} className="onb__choice">
      {body}
    </OptionCard>
  );
}

/**
 * Where the agents work: the workspace's cloud computer, or this computer / a
 * server (the Mac app or the terminal; the computer shows a code to confirm, live until it connects).
 * In agentes for Mac (ADR 0036) the second choice is "Este Mac", and choosing it connects it.
 */
function ComputerStep({
  orgId,
  computer,
  cloudAvailable,
  machine,
  onChoose,
  onPaired,
}: {
  orgId: string;
  computer: Computer;
  cloudAvailable: boolean;
  machine: Machine | null;
  onChoose: (c: Computer) => void;
  onPaired: (m: Machine) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  // The computers already there when "this computer" was picked: a new one is the one being connected.
  const [known, setKnown] = useState<Set<string> | null>(null);
  const waiting = computer === "machine" && known !== null && machine === null;
  const machines = useMachines(orgId, waiting, waiting ? PAIR_POLL_MS : false);
  const found = known ? (machines.data ?? []).find((m) => !known.has(m.id)) : undefined;
  useEffect(() => {
    if (found && !machine) onPaired(found);
  }, [found, machine, onPaired]);

  // In the app: picking "Este Mac" is the consent; the app hands the runner's code over and we confirm it.
  const app = inDesktopApp();
  const confirm = useConfirmDevice();
  const [linking, setLinking] = useState<"idle" | "connecting" | "failed">("idle");
  const [other, setOther] = useState(false);
  const linkThisMac = async () => {
    setLinking("connecting");
    try {
      const { userCode } = await thisMac.connect(orgId);
      if (userCode) {
        onPaired(await confirm.mutateAsync({ orgId, userCode }));
      } else {
        // Already in this organization: that machine.
        const id = (await thisMac.status()).orgs.find((o) => o.orgId === orgId)?.machineId;
        const here = (await api.machines.list(orgId)).find((m) => m.id === id);
        if (!here) throw new Error("not found");
        onPaired(here);
      }
      setLinking("idle");
    } catch {
      setLinking("failed");
    }
  };

  const chooseMachine = () => {
    onChoose("machine");
    if (app) {
      if (!machine && linking !== "connecting") void linkThisMac();
      return;
    }
    if (known) return;
    void api.machines
      .list(orgId)
      .catch(() => [] as Machine[])
      .then((before) => setKnown(new Set(before.map((m) => m.id))));
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
      <div className="onb__choices" role="group" aria-label={t("onboarding.computer.title")}>
        <ChoiceCard
          art={<ComputerPortrait kind="cloud" state={cloudAvailable ? "online" : "offline"} />}
          title={t("onboarding.computer.cloud")}
          desc={cloudAvailable ? t("onboarding.computer.cloudDesc") : t("onboarding.computer.cloudUnavailable")}
          pressed={computer === "cloud"}
          disabled={!cloudAvailable}
          onClick={() => onChoose("cloud")}
        />
        <ChoiceCard
          art={<ComputerPortrait kind={machine ? computerKind(machine.os) : "mac"} state="online" />}
          title={app ? t("onboarding.computer.thisMac") : t("onboarding.computer.mine")}
          desc={app ? t("onboarding.computer.thisMacDesc") : t("onboarding.computer.mineDesc")}
          pressed={computer === "machine"}
          onClick={chooseMachine}
        />
      </div>

      {computer === "cloud" && (
        <p className="onb__status" role="status">
          <Icon name="check" />
          <span>{t("onboarding.computer.cloudReady")}</span>
        </p>
      )}

      {computer === "machine" && app && (
        <Card as="div">
          {machine ? (
            <>
              <p className="onb__status" role="status">
                <Icon name="check" />
                <span>{t("onboarding.computer.thisMacConnected", { name: machine.name })}</span>
              </p>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <OpenPrefsButton tab="folders">{t("onboarding.computer.thisMacFolders")}</OpenPrefsButton>
                <Button size="sm" variant="ghost" aria-expanded={other} onClick={() => setOther((o) => !o)}>
                  {t("onboarding.computer.otherComputer")}
                </Button>
              </div>
              {other && <ConnectComputer orgId={orgId} download />}
            </>
          ) : linking === "failed" ? (
            <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="small" style={{ flex: 1, minWidth: 200 }}>
                {t("machines.thisMac.failed")}
              </span>
              <Button size="sm" onClick={() => void linkThisMac()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <span className="row small muted" role="status" style={{ gap: 8 }}>
              <Spinner />
              {t("onboarding.computer.thisMacConnecting")}
            </span>
          )}
        </Card>
      )}

      {computer === "machine" && !app && (
        <Card as="div">
          {machine ? (
            <p className="onb__status" role="status">
              <Icon name="check" />
              <span>
                {t("onboarding.computer.connected", {
                  name: machine.name,
                  os: t(`machines.os.${osOf(machine.os)}`),
                })}
              </span>
            </p>
          ) : (
            <>
              <ConnectComputer orgId={orgId} />
              <span className="row small muted" role="status" style={{ gap: 8 }}>
                <Spinner />
                {t("machines.download.waiting")}
              </span>
            </>
          )}
        </Card>
      )}
    </>
  );
}

/** Who works with you: e-mails as chips (each with a role), and the invite link. */
function TeamStep({
  orgId,
  invites,
  sent,
  onChange,
  agents,
}: {
  orgId: string;
  invites: InviteDraft[];
  sent: Set<string>;
  onChange: (list: InviteDraft[]) => void;
  agents: CrewMember[];
}) {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const link = useQuery({
    queryKey: ["onboarding", "invite-link", orgId],
    queryFn: () => api.invites.createLink(orgId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const roleOptions = [
    { value: "member" as Role, label: t("roles.member"), description: t("roles.memberDesc") },
    { value: "admin" as Role, label: t("roles.admin"), description: t("roles.adminDesc") },
  ];
  const commit = (text: string) => {
    if (!text.trim()) return;
    onChange(addInvites(invites, text));
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && invites.length > 0) {
      const last = invites[invites.length - 1];
      if (last && !sent.has(last.email)) onChange(invites.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
  };
  const copy = async () => {
    if (!link.data) return;
    try {
      await navigator.clipboard.writeText(link.data.url);
      setCopied(true);
    } catch {
      toast.show(link.data.url);
    }
  };
  const invalid = invites.some((i) => !i.valid);
  return (
    <>
      <Card as="div">
        <label className="onb__label" htmlFor="invite-emails">
          {t("onboarding.team.emails")}
        </label>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click on the box focuses its input */}
        <div
          className="onb__emails"
          onClick={(e) => {
            if (e.target === e.currentTarget) input.current?.focus();
          }}
        >
          {invites.map((i) => (
            <span key={i.email} className="onb__chip" data-invalid={!i.valid || undefined}>
              <Avatar name={i.email} initials={i.email.slice(0, 2).toUpperCase()} size="sm" />
              <span className="onb__chip-email">{i.email}</span>
              {!i.valid ? (
                <span className="onb__chip-bad">{t("onboarding.team.invalid")}</span>
              ) : sent.has(i.email) ? (
                <span className="small muted">{t("onboarding.team.sent")}</span>
              ) : (
                <Select
                  size="sm"
                  value={i.role}
                  aria-label={t("onboarding.team.roleOf", { email: i.email })}
                  options={roleOptions}
                  onValueChange={(role) => onChange(invites.map((x) => (x.email === i.email ? { ...x, role } : x)))}
                />
              )}
              {!sent.has(i.email) && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="close"
                  aria-label={t("onboarding.removeInvite", { email: i.email })}
                  onClick={() => onChange(invites.filter((x) => x.email !== i.email))}
                />
              )}
            </span>
          ))}
          <input
            ref={input}
            id="invite-emails"
            className="onb__emails-input"
            type="text"
            inputMode="email"
            autoComplete="off"
            value={draft}
            placeholder={invites.length ? t("onboarding.team.more") : t("onboarding.team.placeholder")}
            aria-describedby="invite-emails-help"
            aria-invalid={invalid || undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => commit(draft)}
          />
        </div>
        <span id="invite-emails-help" className={invalid ? "small onb__error" : "small muted"}>
          {invalid ? t("onboarding.team.invalidHelp") : t("onboarding.team.rolesHelp")}
        </span>
      </Card>
      <Card as="div">
        <span className="onb__label">{t("onboarding.team.link")}</span>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Input
            readOnly
            value={link.data?.url ?? ""}
            aria-label={t("onboarding.team.link")}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button icon="copy" onClick={() => void copy()} disabled={!link.data}>
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
        <span className="small muted">{t("onboarding.team.linkHelp")}</span>
      </Card>
      {agents.length > 0 && (
        <div className="row small muted" style={{ gap: 8 }}>
          <span>{t("onboarding.team.meet")}</span>
          {agents.map((a) => (
            <AgentAvatar key={a.key} name={a.name} initials={a.initials} appearance={a.appearance} size="sm" />
          ))}
        </div>
      )}
    </>
  );
}

/** The last step: the welcome card on a small sky, the crew, and a short summary. */
function DoneStep({
  orgName,
  agents,
  computer,
  invites,
  wiki,
}: {
  orgName: string;
  agents: CrewMember[];
  /** Pages imported from Obsidian; null while importing, undefined when none was brought. */
  wiki?: number | null;
  /** "cloud", a machine's name, null while it waits to connect, undefined when skipped. */
  computer: string | null | undefined;
  invites: number;
}) {
  const { t } = useTranslation();
  const text = useRef<HTMLDivElement>(null);
  const names = joinNames(
    agents.map((a) => a.name),
    t("newAgent.and"),
  );
  const computerLabel =
    computer === "cloud"
      ? t("onboarding.done.computerCloud")
      : computer === null
        ? t("onboarding.done.computerPending")
        : computer === undefined
          ? t("onboarding.done.computerLater")
          : computer;
  return (
    <>
      <section className="onb__welcome" aria-labelledby="onb-welcome-title">
        <WelcomeSky calm={() => [text.current]} />
        <div className="onb__welcome-text" ref={text}>
          <p className="onb__eyebrow onb__eyebrow--sky">{t("onboarding.done.eyebrow")}</p>
          <h1 id="onb-welcome-title" className="onb__welcome-title">
            {t("onboarding.done.title", { org: orgName })}
          </h1>
          <p className="onb__welcome-lead">
            {agents.length === 1
              ? t("onboarding.done.textOne", { names })
              : agents.length > 1
                ? t("onboarding.done.textMany", { names })
                : t("onboarding.done.textNone")}
          </p>
        </div>
        {agents.length > 0 && (
          <div className="onb__crew" aria-hidden="true">
            {agents.map((a) => (
              <AgentAvatar key={a.key} name={a.name} initials={a.initials} appearance={a.appearance} size="lg" />
            ))}
          </div>
        )}
      </section>
      <dl className="onb__summary">
        <Card as="div">
          <dt className="small muted">{t("onboarding.done.agents")}</dt>
          <dd className="onb__stat">{agents.length}</dd>
        </Card>
        <Card as="div">
          <dt className="small muted">{t("onboarding.done.computer")}</dt>
          <dd className="onb__stat">{computerLabel}</dd>
        </Card>
        <Card as="div">
          <dt className="small muted">{t("onboarding.done.invites")}</dt>
          <dd className="onb__stat">{invites}</dd>
        </Card>
        {wiki !== undefined && (
          <Card as="div">
            <dt className="small muted">{t("onboarding.done.wiki")}</dt>
            <dd className="onb__stat">
              {wiki === null ? t("onboarding.done.wikiImporting") : t("onboarding.done.wikiPages", { count: wiki })}
            </dd>
          </Card>
        )}
      </dl>
    </>
  );
}
