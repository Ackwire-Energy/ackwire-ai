import type { AiStatus, Machine, Role } from "@agenteschat/client";
import {
  ApiError,
  keys,
  meQuery,
  newClientId,
  useAiStatus,
  useAuthConfig,
  useComputerSetup,
  useConfirmDevice,
  useMachines,
  useSandboxSettings,
} from "@agenteschat/client";
import { billingHoldOf } from "@agenteschat/client/lib/billing";
import {
  computerEdition,
  computerName,
  etaLine,
  type SetupView,
  setupPending,
  setupPortrait,
  setupView,
  WORKSPACE_COMPUTER_KIND,
} from "@agenteschat/client/lib/computer";
import { errorCode, errorText, holdText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import {
  type ComputerKind,
  type ComputerState,
  computerKind,
  computerState,
  hostDescKey,
} from "@agenteschat/client/lib/machines";
import { firstMentioned } from "@agenteschat/client/lib/markdown";
import {
  type AiChoice,
  aiStateOf,
  defaultChoice,
  firstAgent,
  gateDims,
  kindOf,
  planLabel,
} from "@agenteschat/client/lib/no-ai";
import {
  addInvites,
  firstAskOrder,
  type InviteDraft,
  ONBOARDING_STEPS,
  type OnboardingStepId,
  validInvites,
} from "@agenteschat/client/lib/onboarding";
import { AUTO, keyLooksValid, providerLabel } from "@agenteschat/client/lib/providers";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { handleFrom } from "@agenteschat/client/lib/text";
import {
  type AgentAppearance,
  Avatar,
  Button,
  Card,
  CardHeader,
  ComputerPortrait,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
  Logo,
  normalizeAppearance,
  OptionCard,
  onScreenKeyboard,
  Select,
  Spinner,
  Textarea,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  AiPicker,
  type KeyDraft,
  KeyPanel,
  PlanPanel,
  usePlanGates,
  type WhoRow,
  WhoThinks,
} from "@/components/ai/ConnectAiSteps";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { ImportFlow, ImportReport, useImportFlow } from "@/components/ImportFlow";
import { ConnectComputer, osOf, PAIR_POLL_MS } from "@/components/Machines";
import { OrgProvider } from "@/components/org-context";
import { ImageCropDialog, OrgMark } from "@/components/ProfilePhoto";
import { OnboardingHorizon, OnboardingProgress, WelcomeSky } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import { OpenPrefsButton, useAgentsHere, useOrgName } from "@/components/ThisMac";
import { ComputerTitle, SetupWait, useSetupWait, type WaitReader } from "@/components/WorkspaceComputer";
import { VaultCard } from "@/components/wiki/VaultCard";
import { useVaultReader } from "@/components/wiki/WikiImport";
import { ZonePicker } from "@/components/ZoneSelect";
import { thisMac } from "@/lib/desktop";
import { sendNewLink } from "@/lib/email-confirmation";
import { importedModel } from "@/lib/import";
import { choosable, itemId } from "@/lib/import-flow";
import { importVault } from "@/lib/obsidian";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";
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
/** The agent guiding the onboarding: always on the team, so it has no card to uncheck. */
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
/** How often the workspace's computer is asked about while it's on its way (no socket is open here). */
const COMPUTER_POLL_MS = 5000;
/**
 * In the wait's first minute, until the provisioner says when it will be ready (it does from its first pass): asked
 * this often, so the time and the email line show as soon as it has.
 */
const FIRST_TIME_POLL_MS = 2000;

/** `host`: the server's own computer. */
type Computer = "cloud" | "machine" | "host" | null;
/** An agent created here (a preset or an imported one), for the later steps. */
interface CrewMember {
  key: string;
  id: string;
  /** As the server made it, which the first message mentions. */
  handle: string;
  name: string;
  role?: string;
  appearance: AgentAppearance;
  initials?: string;
}
/**
 * An imported agent once created: its id is also its `key` (a source key can repeat a preset's), and it keeps the
 * model it had where it came from (it starts on Automatic; a key that runs that model gives it back).
 */
interface ImportedCrew extends CrewMember {
  model: string | null;
}
/** Done's computer at the end of the faces: its portrait and what it says to someone pointing at it or reading. */
interface ComputerPlate {
  kind: ComputerKind;
  state: ComputerState;
  label: string;
}
/** Under the first message: whether the agent it names can start on it now. */
interface AskLine {
  state: AiState;
  icon: IconName;
  text: string;
}
type AiState = AiStatus["agents"][number]["state"];
const LINE_ICON: Record<AiState, IconName> = { ready: "check", waiting: "clock", no_ai: "plug" };

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
  const auth = useAuth();
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
  // Import: read and planned in its step, applied when the team is kept (a key saved later gives back their models).
  const flow = useImportFlow(created?.orgId ?? null);
  const [importedCrew, setImportedCrew] = useState<ImportedCrew[]>([]);
  // Agents and AI: first who joins (created when that screen is left), then what they think with.
  const [chosen, setChosen] = useState<Set<Preset>>(new Set(PRESETS));
  const [agentsPhase, setAgentsPhase] = useState<"pick" | "ai">("pick");
  const [agentIds, setAgentIds] = useState<Partial<Record<Preset, string>>>({});
  const [handles, setHandles] = useState<Partial<Record<Preset, string>>>({});
  // The option picked (none: the default), the agent a plan is for, and the plans given so far (by agent).
  const [aiPicked, setAiPicked] = useState<AiChoice | null>(null);
  const [aiAgent, setAiAgent] = useState<string | undefined>(undefined);
  const [planned, setPlanned] = useState<Record<string, { label: string; mark: string }>>({});
  // A computer the person connected: its own sign-in thinks for every agent, unless they pick another account.
  const [own, setOwn] = useState(true);
  // The workspace key: a provider's key, or the platform key where the server offers one.
  const [draft, setDraft] = useState<KeyDraft>({ provider: "anthropic", apiKey: "" });
  const [keySaved, setKeySaved] = useState(false);
  const [platform, setPlatform] = useState(false);
  // The monthly budget of every agent (US$, API usage only); null = the workspace default as it is.
  const [budget, setBudget] = useState<string | null>(null);
  // Computer (before the agents): where they work, and where a plan signs in.
  const [computer, setComputer] = useState<Computer>(null);
  const [machine, setMachine] = useState<Machine | null>(null);
  // Team
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [sent, setSent] = useState<Set<string>>(new Set());
  // Done: the first message, written for whoever asks it when the step opens (`team`: the crew it was written for).
  // Its `clientId` changes with its text: sent again after an answer that never came back, it's posted once.
  const [firstAsk, setFirstAsk] = useState<{ team: string; asker: string; text: string; clientId: string } | null>(
    null,
  );

  const step = ONBOARDING_STEPS[index] ?? ONBOARDING_STEPS[0];
  const total = ONBOARDING_STEPS.length;
  // The steps to answer ("done" is where they end), and those answered: one opened again counts once it's
  // answered again, as the rail shows it.
  const toAnswer = total - 1;
  const answered = ONBOARDING_STEPS.filter((s) => s.id !== step.id && done.has(s.id)).length;
  const orgName = org.trim() || t("onboarding.yourCompany");
  const presetInfo = (p: Preset) => ({
    name: t(`onboarding.presets.${p}.name`),
    role: t(`onboarding.presets.${p}.role`),
    desc: t(`onboarding.presets.${p}.desc`),
  });
  // In the order they were made (`agentIds` keeps it), the order the workspace lists its agents in.
  const createdPresets = (Object.keys(agentIds) as Preset[]).filter((p) => agentIds[p]);
  /** The imported agents to choose in "Agentes e IA": the ones the plan creates or updates. */
  const importAgents = (flow.planned?.items ?? []).flatMap((i) => {
    const agent = i.kind === "agent" && choosable(i) ? flow.planned?.bundle.agents.find((a) => a.key === i.key) : null;
    return agent ? [{ id: itemId(i), agent, handle: i.renamedTo ?? agent.handle }] : [];
  });
  const pickedImports = importAgents.filter((x) => flow.pick.has(x.id)).map((x) => x.agent);
  const crew: CrewMember[] = [
    ...createdPresets.map((p) => ({
      key: p,
      id: agentIds[p] ?? "",
      handle: handles[p] ?? p,
      name: presetInfo(p).name,
      role: presetInfo(p).role,
      appearance: PRESET_LOOK[p],
      initials: p === "atlas" ? "At" : undefined,
    })),
    ...importedCrew,
  ];
  /**
   * The agents created so far, in the team's order: whom a plan thinks for (the first with no AI unless one is
   * picked, as Connect an AI picks in the app) and Who thinks' rows.
   */
  const crewAgents = crew.map(({ id, name, appearance, initials }) => ({ id, name, appearance, initials }));
  /** Still to create when the team is kept, besides the guide (it is "already here" in the copy). */
  const joiningLeft =
    PRESETS.filter((p) => p !== GUIDE && chosen.has(p) && !agentIds[p]).length +
    (flow.report ? 0 : pickedImports.length);
  const ready = validInvites(invites);
  const toSend = ready.filter((i) => !sent.has(i.email));

  // The host of this step meets you here the first time.
  const host = HOST[step.id];
  useEffect(() => {
    setMetAt((m) => (m[host] ? m : { ...m, [host]: step.id }));
  }, [host, step.id]);

  // Each step's column opens centered, then stays where it opened: what changes in it (the computer's progress,
  // a toggle) grows or shrinks it downward instead of moving the question and Back under the pointer.
  const column = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again for each step and each of its screens
  useLayoutEffect(() => {
    const el = column.current;
    if (!el) return;
    const place = () => {
      el.style.marginTop = "";
      el.style.marginTop = `${el.getBoundingClientRect().top - (el.parentElement?.getBoundingClientRect().top ?? 0)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [step.id, agentsPhase]);

  const saveWorkspace = useMutation({
    // Owning a workspace that waits for its first plan is said in place, with the way to that plan.
    meta: { silent: true },
    onError: (e) => {
      if (errorCode(e) !== "org.create_unpaid") toast.show(errorText(t, e), "error");
    },
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
        if (!available) setDraft((d) => (d.provider === "platform" ? { ...d, provider: "anthropic" } : d));
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
      return result.created.length;
    },
    onError: (e) => toast.show(errorText(t, e), "error"),
  });

  /**
   * The import picked in its step, in one apply: each agent keeps its own
   * model when a key the workspace has runs it (`runnable`), else starts on
   * "Automático"; the agents it brings join #general.
   */
  const applyImported = async (runnable: string[]) => {
    const crewSoFar = [...importedCrew];
    const bundle = flow.planned?.bundle;
    if (!created || !bundle) return crewSoFar;
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
        role: agent.role,
        appearance: normalizeAppearance(agent.appearance),
        model: agent.model ?? null,
      });
      setImportedCrew([...crewSoFar]);
    }
    return crewSoFar;
  };

  /** The models a key of this provider runs. */
  const modelsOf = async (provider: string) => {
    const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
    return list.models.filter((m) => m.provider === provider).map((m) => m.id);
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

  /**
   * "Fica com esse time?": the chosen presets (each on Automático, in #general) and the import, then, on a computer
   * connected a step before, every one of them works there. Created before the AI, so leaving the AI step for later
   * (or for good) leaves a whole team.
   */
  const createTeam = useMutation({
    mutationFn: async () => {
      if (!created) return;
      const ids = { ...agentIds };
      const named = { ...handles };
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
        named[p] = agent.handle;
        setAgentIds({ ...ids });
        setHandles({ ...named });
      }
      // Imported: one apply after the presets (a handle a preset took gets the next free one). A new workspace has
      // no key yet, so they start on Automático; saving one later gives back the models it runs.
      const crewSoFar = await applyImported([]);
      if ((computer !== "machine" && computer !== "host") || !machine) return;
      const all = [...PRESETS.flatMap((p) => (ids[p] ? [ids[p]] : [])), ...crewSoFar.map((c) => c.id)];
      for (const agentId of all) await api.sandbox.setTarget(created.orgId, agentId, machine.id);
    },
  });

  /** The AI step's big button: the key typed (the workspace's default) and the budget, or the computer's own sign-in. */
  const finishAi = useMutation({
    mutationFn: async () => {
      if (!created) return;
      const orgId = created.orgId;
      if (keyPending && draft.provider !== "platform") {
        const cred = await api.agents.addCredential(orgId, {
          provider: draft.provider,
          label: providerLabel(draft.provider),
          apiKey: draft.apiKey.trim(),
        });
        // Every agent, the router, summaries and reflection use the workspace default key.
        await api.orgs.updateSettings(orgId, { defaultCredentialId: cred.id });
        setKeySaved(true);
        const runnable = await modelsOf(draft.provider);
        for (const c of importedCrew) {
          if (c.model && runnable.includes(c.model)) await api.agents.update(orgId, c.id, { model: c.model });
        }
      }
      if (budget !== null && budgetOk && budget !== "" && Number(budget) !== settings.data?.defaultAgentBudgetUsd) {
        await api.orgs.updateSettings(orgId, { defaultAgentBudgetUsd: Number(budget) });
      }
      if (!ownChosen) return;
      // The computer's own sign-in thinks for every agent; each answers only the person (ADR 0059 §5).
      let failed = false;
      for (const c of crewAgents) {
        await api.agents.setBrain(orgId, c.id, { brain: kindOf(choice), fallback: true }).catch(() => {
          failed = true;
        });
      }
      if (failed)
        toast.show(
          t("onboarding.brain.failed", { brand: planLabel(t, choice), computer: machine?.name ?? "" }),
          "error",
        );
    },
  });

  const sandbox = useSandboxSettings(created?.orgId ?? "", Boolean(created) && step.id === "computer");
  // Daytona's sandboxes are a choice only on a server that has them.
  const daytona = sandbox.data?.available === true;
  // Where the workspace gets its own computer (ADR 0056 §10): no choice to make, only its progress (polled:
  // no socket is open here), and a hold put on the workspace meanwhile, which ends the countdown. While it is
  // on its way every step follows it (the rail, the AI step); the confirmation line follows `me` on focus.
  const computerPoll = step.id === "computer" ? COMPUTER_POLL_MS : false;
  const setup = useComputerSetup(created?.orgId ?? "", Boolean(created), (data) => {
    const view = setupView(data);
    if (view?.phase === "preparing" && view.secondsLeft === null && (view.waited ?? 0) < 60) return FIRST_TIME_POLL_MS;
    return computerPoll || (setupPending(view) ? COMPUTER_POLL_MS : false);
  });
  const workspaceComputer = setupView(setup.data, setup.dataUpdatedAt);
  const aiOpen = step.id === "agents" && agentsPhase === "ai";
  // The AI step's plan panel waits for that computer too, and says a hold instead once one is put on.
  const mePoll = computerPoll || (aiOpen && setupPending(workspaceComputer) ? COMPUTER_POLL_MS : false);
  const me = useQuery({ ...meQuery(api), refetchInterval: mePoll, refetchOnWindowFocus: "always" });
  // Whether a computer is a choice: the workspace's setup says, and the server before it exists; never a guess.
  const server = useAuthConfig().data;
  const edition = computerEdition(setup.data, server?.workspaceComputer);
  const standing = me.data?.organizations.find((o) => o.id === created?.orgId)?.standing;
  const hold = holdText(t, standing);
  // A new workspace waiting for its first plan (ADR 0071): its computer and its invitations come with the plan.
  const unpaid = billingHoldOf(standing) === "payment";
  // Creating another refused while one waits for its plan: the way to that one's plan.
  const refused = saveWorkspace.error;
  const unpaidElsewhere =
    refused instanceof ApiError && refused.code === "org.create_unpaid" && typeof refused.params?.orgId === "string"
      ? refused.params.orgId
      : null;
  // Someone who already has a workspace can give up on a new one: back to the one they were in (or any other).
  const others = (me.data?.organizations ?? []).filter((o) => o.id !== created?.orgId);
  const leaveTo = others.find((o) => o.id === storage.get(STORAGE_KEYS.lastOrg)) ?? others[0];
  const email = me.data?.user.email ?? "";
  // The address this tab's sign-up was emailed a link to confirm: the first step says where it went. Read once and
  // forgotten once confirmed or set up, so a later onboarding (another workspace) says nothing of it.
  const [sentTo] = useState(() => sessionStore.get(STORAGE_KEYS.confirmationSent));
  const verified = me.data?.user.emailVerified === true;
  // Confirmed, the line goes: the tab the link opened in says so.
  const confirmationSent = email !== "" && sentTo === email && !verified;
  useEffect(() => {
    if (verified) sessionStore.remove(STORAGE_KEYS.confirmationSent);
  }, [verified]);
  const resend = useMutation({ mutationFn: () => sendNewLink({ auth, t, show: toast.show }, email) });

  // The AI step. It opens on Claude's sign-in, or on the API key where no computer here can take a plan. Until
  // something is connected, the chosen agent's view and the accounts are asked again every few seconds (no socket
  // is open here), so a plan's panel turns on by itself once the computer is ready.
  const orgSummary = me.data?.organizations.find((o) => o.id === created?.orgId);
  const noComputer = edition === "selfhost" && (computer === null || computer === "cloud");
  const hasAi = (id: string) => planned[id] !== undefined || keySaved;
  const aiAgentId = aiAgent ?? firstAgent(crewAgents, hasAi)?.id;
  const gates = usePlanGates(
    created?.orgId ?? "",
    aiOpen ? aiAgentId : undefined,
    aiOpen && Object.keys(planned).length === 0 && !keySaved ? COMPUTER_POLL_MS : false,
  );
  const choice =
    aiPicked ??
    defaultChoice({
      ownsAgents: true,
      mayAddKey: true,
      claudeGate: noComputer ? { state: "missing" } : gates.gateOf("claude"),
    });
  const pickAi = (next: AiChoice) => {
    setAiPicked(next);
    // Another plan moves on to the next agent with no AI once this one thinks with a plan.
    if (next !== "key" && next !== choice && aiAgentId !== undefined && planned[aiAgentId])
      setAiAgent(firstAgent(crewAgents, hasAi)?.id);
  };
  // A computer the person connected: its own sign-in, unless they chose another account.
  const ownChosen =
    own &&
    (choice === "claude" || choice === "chatgpt") &&
    gates.view?.ownSignIn === true &&
    gates.gateOf(choice).state === "ready";
  const keyPending = choice === "key" && draft.provider !== "platform" && !keySaved && draft.apiKey.trim() !== "";
  const aiDone =
    Object.keys(planned).length > 0 || ownChosen || keySaved || (choice === "key" && draft.provider === "platform");
  const whoRows: WhoRow[] = crewAgents.map((a) => ({
    ...a,
    thinks:
      planned[a.id] ??
      (keySaved && draft.provider !== "platform"
        ? { label: t("connectAi.who.key", { provider: providerLabel(draft.provider) }), mark: draft.provider }
        : null),
  }));

  /** The Computer step left, `skipped` or with its choice. */
  const saveComputer = useMutation({
    mutationFn: async (skipped: boolean) => {
      if (!created) return;
      if (!skipped && computer === "cloud" && sandbox.data?.available && !sandbox.data.enabled) {
        const saved = await api.sandbox.saveSettings(created.orgId, { enabled: true });
        qc.setQueryData(keys.sandboxSettings(created.orgId), saved);
      }
      // The agents come next and go to the connected computer when they are created; ones made already (back here
      // from the AI step) follow the new choice now, off the computer they were on when there's none.
      if (edition !== "selfhost") return;
      const target = !skipped && (computer === "machine" || computer === "host") && machine ? machine.id : null;
      for (const c of crewAgents) await api.sandbox.setTarget(created.orgId, c.id, target);
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

  // Done. The computer as it is now (it may have gone to sleep since it was picked), and whether it gives the agents
  // a browser: a ready one does; one still being prepared and a Daytona sandbox don't.
  const machinesNow = useMachines(created?.orgId ?? "", step.id === "done" && machine !== null);
  const machineNow = machinesNow.data?.find((m) => m.id === machine?.id) ?? machine;
  const browser = workspaceComputer
    ? workspaceComputer.phase === "ready"
    : (computer === "machine" || computer === "host") && machineNow !== null && computerState(machineNow) === "online";
  const { eta } = useSetupWait(step.id === "done" ? workspaceComputer : null, hold !== null);
  const plate: ComputerPlate | null = workspaceComputer
    ? {
        kind: WORKSPACE_COMPUTER_KIND,
        state: setupPortrait(workspaceComputer, true),
        label: [t("computerSetup.title", { org: orgName }), t(workspaceComputer.chipKey), eta && etaLine(t, eta)]
          .filter(Boolean)
          .join(" · "),
      }
    : computer === "cloud"
      ? { kind: "cloud", state: "online", label: t("onboarding.computer.cloud") }
      : (computer === "machine" || computer === "host") && machineNow
        ? {
            kind: computerKind(machineNow.os),
            state: computerState(machineNow),
            label: computer === "host" ? t("machines.host.label") : machineNow.name,
          }
        : computer === "machine"
          ? {
              kind: "mac",
              state: "paused",
              label: `${t("onboarding.stepNames.computer")} · ${t("onboarding.done.computerPending")}`,
            }
          : null;

  // The first message: written as Done opens, so it never changes while it's read, and kept through edits and Back;
  // written again only when the ready-made agents, who offer it, change (an import retried on Done keeps it).
  const team = createdPresets.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: when Done opens, and when the team changes
  useLayoutEffect(() => {
    if (step.id !== "done" || firstAsk?.team === team) return;
    const preset = firstAskOrder(browser).find((p) => agentIds[p]);
    const asker = crew.find((c) => c.key === preset) ?? crew[0];
    setFirstAsk(
      asker
        ? {
            team,
            asker: asker.key,
            text: preset ? t(`onboarding.done.first.asks.${preset}`, { handle: asker.handle }) : "",
            clientId: newClientId(),
          }
        : null,
    );
  }, [step.id, team]);
  const askText = firstAsk?.text ?? "";
  const asking = askText.trim() !== "";
  // Whoever the text mentions first speaks, and gets it; with nobody named, the router picks who answers.
  const mentioned = firstMentioned(askText, crew);
  const speaker = mentioned ?? crew.find((c) => c.key === firstAsk?.asker);
  // No socket is open here: an agent waiting for its computer is asked about again until it can start.
  const aiNow = useAiStatus(created?.orgId ?? "", step.id === "done" && speaker !== undefined, (status) =>
    mentioned && aiStateOf(status, mentioned.id) === "waiting" ? COMPUTER_POLL_MS : false,
  );
  const lineState = !asking
    ? undefined
    : mentioned
      ? aiStateOf(aiNow.data, mentioned.id)
      : aiNow.data?.any === false
        ? "no_ai"
        : undefined;
  const askLine: AskLine | null = lineState
    ? {
        state: lineState,
        icon: LINE_ICON[lineState],
        text: t(`onboarding.done.first.${lineState === "no_ai" ? (mentioned ? "noAi" : "noAiAny") : lineState}`, {
          name: mentioned?.name,
          computer: computerName(t, orgName, machineNow),
        }),
      }
    : null;

  const finish = useMutation({
    mutationFn: async (message: { body: string; clientId: string } | null) => {
      if (!created) return;
      // A failed post stays on Done with its text: the app's toast says why.
      if (message) await api.chat.post(created.orgId, created.generalChannelId, message);
      sessionStore.remove(STORAGE_KEYS.confirmationSent);
      await qc.invalidateQueries({ queryKey: keys.me });
      await navigate({
        to: "/org/$orgId/c/$channelId",
        params: { orgId: created.orgId, channelId: created.generalChannelId },
      });
    },
  });

  const go = (i: number) => {
    const next = Math.max(0, Math.min(total - 1, i));
    // Done asks again whether the agents have an AI: one connected on a way back there counts.
    if (created && ONBOARDING_STEPS[next]?.id === "done")
      void qc.invalidateQueries({ queryKey: keys.aiStatus(created.orgId), refetchType: "none" });
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
   * `keyLater` ("Conectar depois") leaves the agents without an AI for now.
   */
  const advance = async (how?: "skip" | "keyLater") => {
    const skip = how === "skip";
    if (step.id === "done") {
      await finish.mutateAsync(
        !skip && asking && firstAsk ? { body: askText.trim(), clientId: firstAsk.clientId } : null,
      );
      return;
    }
    if (!skip) {
      if (step.id === "workspace") await saveWorkspace.mutateAsync();
      if (step.id === "context") {
        await saveContext.mutateAsync();
        // The vault goes in the background: the next steps don't wait for the attachments.
        if (vault.report && (importWiki.isIdle || importWiki.isError)) importWiki.mutate();
      }
      if (step.id === "agents") {
        // The team first, then what it thinks with, on its own screen.
        if (agentsPhase === "pick") {
          await createTeam.mutateAsync();
          setAgentsPhase("ai");
          return;
        }
        if (how !== "keyLater") await finishAi.mutateAsync();
      }
      if (step.id === "computer") await saveComputer.mutateAsync(false);
      if (step.id === "team") await sendInvites.mutateAsync();
    } else if (step.id === "computer") {
      await saveComputer.mutateAsync(true);
      setComputer(null);
      setMachine(null);
    } else if (step.id === "import") {
      flow.reset();
      flow.setCard(null);
    }
    setDone((d) => new Set(d).add(step.id));
    guide.cheer();
    go(index + 1);
  };
  const skip = () => void advance("skip").catch(() => {});

  const busy =
    saveWorkspace.isPending ||
    saveContext.isPending ||
    createTeam.isPending ||
    finishAi.isPending ||
    flow.busy !== null ||
    saveComputer.isPending ||
    sendInvites.isPending ||
    finish.isPending;
  const blocked =
    (step.id === "workspace" && !org.trim()) ||
    // Continue is what brings a vault into the wiki: it waits for the vault to be read.
    (step.id === "context" && vault.state.step === "reading") ||
    (aiOpen &&
      ((keyPending ? draft.provider === "platform" || !keyLooksValid(draft.provider, draft.apiKey) : !aiDone) ||
        (choice === "key" && !budgetOk))) ||
    (step.id === "import" && !flow.planned) ||
    (step.id === "computer" && !workspaceComputer && (computer === null || (computer === "machine" && !machine)));

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
    computer: workspaceComputer
      ? t(workspaceComputer.chipKey)
      : computer === "cloud"
        ? t("onboarding.computer.cloud")
        : computer === "host"
          ? t("machines.host.label")
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

  // The question: the step's, or the AI's on the agents' second screen.
  const ask =
    step.id === "done"
      ? null
      : aiOpen
        ? {
            title: t("onboarding.keyStep.title"),
            lead: t(noComputer ? "onboarding.keyStep.leadNoComputer" : "onboarding.keyStep.lead"),
          }
        : step.id === "computer" && workspaceComputer && unpaid
          ? { title: t("onboarding.computer.payment.title"), lead: t("onboarding.computer.payment.body") }
          : {
              title:
                step.id === "agents" && importAgents.length
                  ? t("onboarding.agents.importedTitle")
                  : t(`onboarding.${step.id}.title`),
              lead:
                step.id === "computer" && workspaceComputer
                  ? t(
                      workspaceComputer.phase === "paused"
                        ? "onboarding.computer.leadCloudPaused"
                        : "onboarding.computer.leadCloud",
                    )
                  : t(`onboarding.${step.id}.lead`),
            };
  const intro = metAt[host] === undefined || metAt[host] === step.id ? t(`onboarding.hosts.${host}`) : null;

  const primaryLabel =
    step.id === "done"
      ? !asking
        ? t("onboarding.done.open")
        : mentioned
          ? t("onboarding.done.first.send", { name: mentioned.name })
          : t("onboarding.done.first.sendGeneral")
      : step.id === "agents" && agentsPhase === "pick" && joiningLeft > 0
        ? t("onboarding.actions.create", { count: joiningLeft })
        : aiOpen && keyPending
          ? t("onboarding.actions.saveAndContinue")
          : step.id === "team" && toSend.length > 0
            ? t("onboarding.actions.invite", { count: toSend.length })
            : t("onboarding.actions.continue");
  // "Pular esta etapa" only on optional steps ("agents" never is, so its AI phase needs no exception); the
  // computer is one only where it is a choice, shown once its setup has answered. On Done the same place opens
  // #general without the first message, while there is one.
  const showSkip =
    step.id === "computer" ? !workspaceComputer && !setup.isLoading : step.id === "done" ? asking : step.optional;
  const back = () => {
    if (aiOpen) setAgentsPhase("pick");
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
            {answered >= toAnswer
              ? t("onboarding.progress.done")
              : t("onboarding.progress.left", { count: toAnswer - answered })}
          </span>
          <OnboardingProgress progress={answered / toAnswer} />
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
            // A computer is a choice only where people connect their own: the workspace's own says how far it is.
            optional: s.id === "computer" ? edition === "selfhost" : s.optional,
            value: railValue[s.id],
            ...(s.id === "computer" && workspaceComputer ? { note: t(workspaceComputer.chipKey) } : {}),
          }))}
        />
        <OnboardingHorizon progress={answered / toAnswer} />
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
        <div className="onb__body" key={`${step.id}-${agentsPhase}`} ref={column}>
          {index > 0 || aiOpen ? (
            <button type="button" className="onb__back" onClick={back} disabled={busy}>
              <Icon name="chevronLeft" size={16} />
              {t("onboarding.back")}
            </button>
          ) : leaveTo ? (
            <button
              type="button"
              className="onb__back"
              onClick={() => void navigate({ to: "/org/$orgId", params: { orgId: leaveTo.id } })}
              disabled={busy}
            >
              <Icon name="chevronLeft" size={16} />
              {t("onboarding.leave", { name: leaveTo.name })}
            </button>
          ) : null}

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
                  spellCheck={false}
                  autoFocus
                />
              </div>
              {zoneOpen ? (
                <Field
                  label={t("onboarding.workspace.timezone")}
                  id="org-zone"
                  hint={{
                    name: t("common.about", { label: t("onboarding.workspace.timezone") }),
                    text: t("onboarding.workspace.timezoneHelp"),
                  }}
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
                  <button type="button" className="ac-link onb__link" onClick={() => setZoneOpen(true)}>
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
              {unpaidElsewhere && (
                <>
                  <p className="onb__status ac-iconline" role="alert">
                    <Icon name="pause" size={14} />
                    <span>{t("standing.createUnpaid")}</span>
                  </p>
                  {server?.billingUrl && (
                    <div className="row">
                      <BillingLinkButton orgId={unpaidElsewhere} from="new_workspace" icon="external">
                        {t("standing.billing.cta.payment")}
                      </BillingLinkButton>
                    </div>
                  )}
                </>
              )}
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

          {step.id === "computer" && created && workspaceComputer && (
            <div className="onb__answer">
              <WorkspaceComputerStep
                view={workspaceComputer}
                orgName={orgName}
                reader={{ owner: true, email, held: hold !== null }}
                hold={unpaid ? null : hold}
              />
              {unpaid && server?.billingUrl && (
                <div className="row">
                  <BillingLinkButton orgId={created.orgId} from="onboarding" icon="external">
                    {t("standing.billing.cta.payment")}
                  </BillingLinkButton>
                </div>
              )}
            </div>
          )}

          {step.id === "computer" && created && setup.isLoading && (
            <div className="onb__answer">
              <Spinner />
            </div>
          )}

          {step.id === "computer" && created && !workspaceComputer && !setup.isLoading && (
            <div className="onb__answer">
              <ComputerStep
                orgId={created.orgId}
                computer={computer}
                daytona={daytona}
                machine={machine}
                onChoose={(c) => {
                  // Leaving the server's computer for "this computer": the pairing starts from nothing.
                  if (c !== "machine" || computer === "host") setMachine(null);
                  setComputer(c);
                }}
                onHost={(m) => {
                  setComputer("host");
                  setMachine(m);
                }}
                onPaired={setMachine}
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
                      pressed={chosen.has(p) || agentIds[p] !== undefined}
                      onClick={() =>
                        // One created already stays: it can be archived from its page.
                        agentIds[p] === undefined &&
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
            </div>
          )}

          {aiOpen && created && (
            <div className="onb__answer">
              {orgSummary && me.data ? (
                // The workspace exists: its panels read it like any of its pages.
                <OrgProvider org={orgSummary} me={me.data}>
                  <AiPicker
                    choice={choice}
                    onPick={pickAi}
                    dims={(c) => noComputer || gateDims(gates.gateOf(c))}
                    panel={
                      choice === "key" ? (
                        <KeyPanel draft={draft} onDraft={setDraft} platform={platform} saved={keySaved} />
                      ) : (
                        <PlanPanel
                          key={choice}
                          choice={choice}
                          gates={gates}
                          agents={crewAgents}
                          agentId={aiAgentId}
                          onAgent={setAiAgent}
                          own={{ chosen: own, onChoose: setOwn }}
                          hostConnecting={computer === "host"}
                          onKey={() => pickAi("key")}
                          onComputer={() => go(ONBOARDING_STEPS.findIndex((s) => s.id === "computer"))}
                          onDone={(agentId, account) => {
                            // The panel stays on that agent, saying it's done; another tile moves on to the next one.
                            setAiAgent(agentId);
                            if (account)
                              setPlanned((p) => ({
                                ...p,
                                [agentId]: { label: account.label, mark: account.provider ?? account.kind },
                              }));
                          }}
                        />
                      )
                    }
                  />
                  {choice === "key" && (
                    <BudgetCard
                      value={budgetValue}
                      invalid={!budgetOk}
                      platform={draft.provider === "platform"}
                      onChange={(v) => setBudget(v)}
                    />
                  )}
                  {Object.keys(planned).length > 0 && crewAgents.length > 1 && (
                    <WhoThinks rows={whoRows} onKey={() => pickAi("key")} />
                  )}
                </OrgProvider>
              ) : (
                <Spinner />
              )}
            </div>
          )}

          {step.id === "team" && created && (
            <div className="onb__answer">
              {unpaid ? (
                <p className="onb__help">{t("onboarding.team.payment")}</p>
              ) : (
                <TeamStep orgId={created.orgId} invites={invites} sent={sent} onChange={setInvites} agents={crew} />
              )}
            </div>
          )}

          {step.id === "done" && (
            <DoneStep
              orgName={orgName}
              agents={crew}
              computer={plate}
              invites={sent.size}
              wiki={importWiki.isPending ? null : importWiki.data}
            />
          )}
          {step.id === "done" && created && flow.report && (
            <Card as="div">
              <ImportReport
                flow={flow}
                orgId={created.orgId}
                onRetry={async () => {
                  await applyImported(keySaved && draft.provider !== "platform" ? await modelsOf(draft.provider) : []);
                }}
              />
            </Card>
          )}
          {step.id === "done" && speaker && (
            <FirstAsk
              speaker={speaker}
              read={savedContext.trim() !== ""}
              orgName={orgName}
              value={askText}
              onChange={(text) => setFirstAsk((a) => a && { ...a, text, clientId: newClientId() })}
              onSend={() => {
                if (!busy) void advance().catch(() => {});
              }}
              line={askLine}
              typing={guide.typing}
            />
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
              <Button variant="ghost" onClick={skip} disabled={busy}>
                {step.id === "done" ? t("onboarding.done.first.skip") : t("onboarding.skip")}
              </Button>
            )}
            {aiOpen && !aiDone && (
              <Button variant="ghost" onClick={() => void advance("keyLater").catch(() => {})} disabled={busy}>
                {t("connectAi.later")}
              </Button>
            )}
            {step.id === "workspace" && confirmationSent && (
              <p className="onb__help onb__note ac-iconline" role="status">
                <Icon name="mail" size={14} />
                <span>
                  {t("onboarding.confirmation.sent", { email })}
                  {!resend.data && (
                    <>
                      <br />
                      <button
                        type="button"
                        className="ac-link onb__link"
                        onClick={() => resend.mutate()}
                        disabled={resend.isPending}
                      >
                        {t("auth.sendNewLink")}
                      </button>
                    </>
                  )}
                </span>
              </p>
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
  lead: ReactNode;
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

/** The monthly budget of every agent: what the API usage may cost; who charges it is in the title's ⓘ. */
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
        hint={{
          name: t("common.about", { label: t("onboarding.budget.title") }),
          text: platform ? t("onboarding.budget.notePlatform") : t("onboarding.budget.noteKey"),
        }}
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
  daytona,
  machine,
  onChoose,
  onPaired,
  onHost,
}: {
  orgId: string;
  computer: Computer;
  /** This server has Daytona's sandboxes. */
  daytona: boolean;
  machine: Machine | null;
  onChoose: (c: Computer) => void;
  onPaired: (m: Machine) => void;
  /** The server's own computer, picked (first in the list, and picked already once it's connected). */
  onHost: (m: Machine) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const host = useMachines(orgId).data?.find((m) => m.kind === "host");
  // Picked by itself only once it's connected: a server whose computer never came up would leave agents waiting.
  useEffect(() => {
    if (host?.online && computer === null) onHost(host);
  }, [host, computer, onHost]);
  // The computers already there when "this computer" was picked: a new one is the one being connected.
  const [known, setKnown] = useState<Set<string> | null>(null);
  const waiting = computer === "machine" && known !== null && machine === null;
  const machines = useMachines(orgId, waiting, waiting ? PAIR_POLL_MS : false);
  const found = known ? (machines.data ?? []).find((m) => !known.has(m.id)) : undefined;
  useEffect(() => {
    if (found && !machine) onPaired(found);
  }, [found, machine, onPaired]);

  // In the app, where agents may work on this computer: picking "This Mac" asks in the app's own dialog, then
  // the app hands the runner's code over and we confirm it.
  const app = useAgentsHere();
  const orgName = useOrgName(orgId);
  const confirm = useConfirmDevice();
  const [linking, setLinking] = useState<"idle" | "connecting" | "failed">("idle");
  const [other, setOther] = useState(false);
  const linkThisMac = async () => {
    setLinking("connecting");
    try {
      const { userCode } = await thisMac.connect(orgId, orgName);
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
        {host && (
          <ChoiceCard
            art={<ComputerPortrait kind={computerKind(host.os)} state={host.online ? "online" : "offline"} />}
            title={t("machines.host.label")}
            desc={t(`machines.host.${hostDescKey(host.os)}`)}
            pressed={computer === "host"}
            onClick={() => onHost(host)}
          />
        )}
        <ChoiceCard
          art={<ComputerPortrait kind={machine ? computerKind(machine.os) : "mac"} state="online" />}
          title={app ? t("onboarding.computer.thisMac") : t("onboarding.computer.mine")}
          desc={app ? t("onboarding.computer.thisMacDesc") : t("onboarding.computer.mineDesc")}
          pressed={computer === "machine"}
          onClick={chooseMachine}
        />
        {daytona && (
          <ChoiceCard
            art={<ComputerPortrait kind="cloud" state="online" />}
            title={t("onboarding.computer.cloud")}
            desc={t("onboarding.computer.cloudDesc")}
            pressed={computer === "cloud"}
            onClick={() => onChoose("cloud")}
          />
        )}
      </div>

      {computer === "cloud" && (
        <p className="onb__status ac-iconline" role="status">
          <Icon name="check" />
          <span>{t("onboarding.computer.cloudReady")}</span>
        </p>
      )}

      {computer === "host" && (
        <p className="onb__status ac-iconline" role="status">
          <Icon name="check" />
          <span>{host?.online ? t("onboarding.computer.hostReady") : t("onboarding.computer.hostConnecting")}</span>
        </p>
      )}

      {computer === "machine" && app && (
        <Card as="div">
          {machine ? (
            <>
              <p className="onb__status ac-iconline" role="status">
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
            <span className="small muted ac-iconline" role="status">
              <Spinner />
              {t("onboarding.computer.thisMacConnecting")}
            </span>
          )}
        </Card>
      )}

      {computer === "machine" && !app && (
        <Card as="div">
          {machine ? (
            <p className="onb__status ac-iconline" role="status">
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
              <span className="small muted ac-iconline" role="status">
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

/**
 * Where the workspace gets its own computer: no choice, only its progress, live, with the time left and who
 * hears when it's ready (whoever creates the workspace owns it); the person goes on meanwhile. On hold, the hold
 * speaks instead of a time (its computer waits for the hold too).
 */
function WorkspaceComputerStep({
  view,
  orgName,
  reader,
  hold,
}: {
  view: SetupView;
  orgName: string;
  reader: WaitReader;
  hold: string | null;
}) {
  const { t } = useTranslation();
  const title = t("computerSetup.title", { org: orgName });
  return (
    <Card as="div" className="onb__workspace-computer">
      <div className="row" style={{ gap: 16, alignItems: "center" }}>
        <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state={setupPortrait(view, true)} size={96} />
        <span style={{ flex: "1 1 220px", minWidth: 0 }}>
          <ComputerTitle name={title}>
            <b>{title}</b>
          </ComputerTitle>
        </span>
      </div>
      {hold && (
        <p className="setup-line ac-iconline" role="status">
          <Icon name="pause" size={14} />
          <span>{hold}</span>
        </p>
      )}
      <SetupWait view={view} reader={reader} />
      {setupPending(view) && (
        <p className="onb__status ac-iconline">
          <Icon name="check" />
          <span>{t("computerSetup.continue")}</span>
        </p>
      )}
    </Card>
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
        <span className="ac-hintline onb__label">
          <label htmlFor="invite-emails">{t("onboarding.team.emails")}</label>
          <InfoHint id="invite-emails-hint" name={t("common.about", { label: t("onboarding.team.emails") })}>
            {t("onboarding.team.emailsHint")}
          </InfoHint>
        </span>
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
            aria-describedby={invalid ? "invite-emails-hint invite-emails-help" : "invite-emails-hint"}
            aria-invalid={invalid || undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => commit(draft)}
          />
        </div>
        {invalid && (
          <span id="invite-emails-help" className="small onb__error">
            {t("onboarding.team.invalidHelp")}
          </span>
        )}
      </Card>
      <Card as="div">
        <span className="ac-hintline onb__label">
          <span>{t("onboarding.team.link")}</span>
          <InfoHint id="invite-link-hint" name={t("common.about", { label: t("onboarding.team.link") })}>
            {t("onboarding.team.linkHint")}
          </InfoHint>
        </span>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Input
            readOnly
            value={link.data?.url ?? ""}
            aria-label={t("onboarding.team.link")}
            aria-describedby="invite-link-hint invite-link-help"
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button icon={copied ? "check" : "copy"} onClick={() => void copy()} disabled={!link.data}>
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
        {/* Visible, not in the ⓘ: it is what makes sharing the link in a group safe. */}
        <span id="invite-link-help" className="small muted">
          {t("onboarding.team.linkHelp")}
        </span>
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

/**
 * The last step's welcome, on a small sky: who is in #general, the invitations emailed and the wiki brought, if any,
 * and the crew's faces with their computer at the end.
 */
function DoneStep({
  orgName,
  agents,
  computer,
  invites,
  wiki,
}: {
  orgName: string;
  agents: CrewMember[];
  computer: ComputerPlate | null;
  invites: number;
  /** Pages imported from Obsidian; null while they're arriving, undefined when none are (none brought, or it failed). */
  wiki?: number | null;
}) {
  const { t } = useTranslation();
  const text = useRef<HTMLDivElement>(null);
  const crew = useRef<HTMLDivElement>(null);
  const names = joinNames(
    agents.map((a) => a.name),
    t("newAgent.and"),
  );
  const lead = [
    agents.length === 1
      ? t("onboarding.done.inGeneralOne", { names })
      : agents.length > 1
        ? t("onboarding.done.inGeneralMany", { names })
        : t("onboarding.done.textNone"),
    invites > 0 && t("onboarding.done.invited", { count: invites }),
    wiki === null ? t("onboarding.done.wikiImporting") : wiki ? t("onboarding.done.wikiPages", { count: wiki }) : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="onb__welcome" aria-labelledby="onb-welcome-title">
      <WelcomeSky calm={() => [text.current]} clear={() => [crew.current]} />
      <div className="onb__welcome-text" ref={text}>
        <h1 id="onb-welcome-title" className="onb__welcome-title">
          {t("onboarding.done.title", { org: orgName })}
        </h1>
        <p className="onb__welcome-lead">{lead}</p>
      </div>
      {agents.length > 0 && (
        // The faces are hidden from screen readers (the lead names them); the computer says what it is.
        <div className="onb__crew" ref={crew}>
          {agents.map((a) => (
            <AgentAvatar
              key={a.key}
              name={a.name}
              initials={a.initials}
              appearance={a.appearance}
              size="lg"
              title={a.role ? `${a.name} · ${a.role}` : a.name}
            />
          ))}
          {computer && (
            <span className="onb__crew-computer" title={computer.label}>
              <ComputerPortrait kind={computer.kind} state={computer.state} label={computer.label} />
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Done's first message: the agent best placed to start offers it in a speech bubble, the person can change it, and
 * the big button sends it to #general.
 */
function FirstAsk({
  speaker,
  read,
  orgName,
  value,
  onChange,
  onSend,
  line,
  typing,
}: {
  speaker: CrewMember;
  /** The person wrote about the company in the Context step. */
  read: boolean;
  orgName: string;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  line: AskLine | null;
  typing: boolean;
}) {
  const { t } = useTranslation();
  const said = useId();
  return (
    <section className="onb__answer" aria-labelledby={said}>
      {/* Another speaker pops in, as each step's host does. */}
      <div className="onb__ask" key={speaker.key}>
        <span className="onb__host" data-fresh>
          <AgentAvatar
            name={speaker.name}
            initials={speaker.initials}
            appearance={speaker.appearance}
            size="lg"
            state={typing ? "writing" : undefined}
            expression="happy"
          />
          <span className="onb__host-name">{speaker.name}</span>
        </span>
        <div className="onb__bubble">
          <p id={said} className="onb__say">
            {value.trim() === ""
              ? t("onboarding.done.first.empty")
              : read
                ? t("onboarding.done.first.read", { org: orgName })
                : t("onboarding.done.first.unread")}
          </p>
        </div>
      </div>
      <Textarea
        autoGrow
        rows={1}
        className="onb__first-text"
        aria-label={t("onboarding.done.first.label")}
        placeholder={t("onboarding.done.first.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends and Shift+Enter starts a line; the page's own Enter handler is kept out. On an on-screen
          // keyboard Enter is a new line, as in the chat: the big button sends.
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || onScreenKeyboard()) return;
          e.preventDefault();
          onSend();
        }}
      />
      {line && (
        <p className="onb__help onb__first-line ac-iconline" role="status" data-state={line.state}>
          <Icon name={line.icon} size={14} />
          <span>{line.text}</span>
        </p>
      )}
    </section>
  );
}
