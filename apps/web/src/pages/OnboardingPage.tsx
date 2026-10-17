import type { Machine, MachinePairing, Role } from "@agenteschat/client";
import { keys, useMachines, useModels, useSandboxSettings } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import {
  addInvites,
  type InviteDraft,
  ONBOARDING_STEPS,
  type OnboardingStepId,
  validInvites,
} from "@agenteschat/client/lib/onboarding";
import {
  keyLooksValid,
  PROVIDERS,
  type ProviderId,
  providerLabel,
  suggestModel,
} from "@agenteschat/client/lib/providers";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { handleFrom } from "@agenteschat/client/lib/text";
import {
  type AgentAppearance,
  Avatar,
  Button,
  Card,
  Field,
  Icon,
  type IconName,
  Input,
  Logo,
  OptionCard,
  Segmented,
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
import { CommandBlock, countdown, NO_EXEC_FLAG, osOf, PAIR_POLL_MS, useNow } from "@/components/Machines";
import { type ImportChoice, OnboardingImport } from "@/components/OnboardingImport";
import { ImageCropDialog, OrgMark } from "@/components/ProfilePhoto";
import { OnboardingHorizon, WelcomeSky } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import { VaultCard } from "@/components/wiki/VaultCard";
import { useVaultReader } from "@/components/wiki/WikiImport";
import { ZonePicker } from "@/components/ZoneSelect";
import {
  IMPORT_MAX_BYTES,
  ImportError,
  type ImportResult,
  importedModel,
  parseImport,
  uniqueHandle,
} from "@/lib/agent-import";
import { importVault } from "@/lib/obsidian";
import { useToast } from "@/lib/toast";

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
/** The agent guiding the onboarding from the rail. */
const GUIDE: Preset = "ada";
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
/** An imported agent once created: its source key (per file), id and handle. */
interface ImportedCrew extends CrewMember {
  id: string;
  handle: string;
}
type InstallOs = "darwin" | "linux" | "windows";
const INSTALL_OSES: InstallOs[] = ["darwin", "linux", "windows"];

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

/** docs/design/telas/OnboardingV2.html — the steps on a rail; the guide on the sky rising from its bottom. */
export function OnboardingPage() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const models = useModels();
  const guide = useGuideMood();

  const [index, setIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [done, setDone] = useState<Set<OnboardingStepId>>(new Set());
  // Workspace
  const [org, setOrg] = useState("");
  const [zone, setZone] = useState(() => browserTimezone() ?? "UTC");
  const [logo, setLogo] = useState<{ imageBase64: string; contentType: string } | null>(null);
  const [logoDirty, setLogoDirty] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  // Context
  const [context, setContext] = useState("");
  const [savedContext, setSavedContext] = useState("");
  // An Obsidian vault for the wiki: read in step 2, imported when it continues.
  const vault = useVaultReader([]);
  const [vaultPages, setVaultPages] = useState<number | null>(null);
  // Import (OpenMausBot / OpenBot): the parsed file, the agents to bring, the ones created.
  const [importFrom, setImportFrom] = useState<ImportChoice>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [importPick, setImportPick] = useState<Set<string>>(new Set());
  const [importedCrew, setImportedCrew] = useState<ImportedCrew[]>([]);
  // Agents and key
  const [chosen, setChosen] = useState<Set<Preset>>(new Set([GUIDE]));
  const [agentIds, setAgentIds] = useState<Partial<Record<Preset, string>>>({});
  // The workspace key: a provider's key (required), or the platform key where the server offers one.
  const [key, setKey] = useState<ProviderId | "platform">("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [openaiOrg, setOpenaiOrg] = useState("");
  const [openaiProject, setOpenaiProject] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [platform, setPlatform] = useState(false);
  // Computer
  const [computer, setComputer] = useState<Computer>(null);
  const [machine, setMachine] = useState<Machine | null>(null);
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
  /** The import in use (none after "Começar do zero" or picking another source). */
  const active = imported && importFrom === imported.source ? imported : null;
  /** An imported agent's identity across files: the source, the files and its key. */
  const importKey = (key: string) => `${active?.source}:${active?.files.join(",")}:${key}`;
  const pickedImports = active ? active.agents.filter((a) => importPick.has(a.key)) : [];
  const chosenCount = chosen.size + pickedImports.length;
  const crew: CrewMember[] = [
    ...createdPresets.map((p) => ({
      key: p,
      name: presetInfo(p).name,
      appearance: PRESET_LOOK[p],
      initials: p === "atlas" ? "At" : undefined,
    })),
    ...importedCrew,
  ];
  const crewIds = [...createdPresets.map((p) => agentIds[p]), ...importedCrew.map((c) => c.id)].filter(
    (id): id is string => Boolean(id),
  );
  const ready = validInvites(invites);
  const toSend = ready.filter((i) => !sent.has(i.email));

  const saveWorkspace = useMutation({
    mutationFn: async () => {
      let target = created;
      if (!target) {
        const res = await api.orgs.create({ name: org.trim() });
        target = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
        setCreated(target);
        await api.orgs.updateSettings(target.orgId, { timezone: zone });
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

  const readImport = useMutation({
    mutationFn: async (input: { files: File[] } | { url: string }) => {
      if (!created || importFrom === null || importFrom === "none") return null;
      const source = importFrom;
      const files =
        "files" in input
          ? await Promise.all(
              input.files.map(async (f) => {
                if (f.size > IMPORT_MAX_BYTES) throw new ImportError("tooLarge");
                return { name: f.webkitRelativePath || f.name, text: await f.text() };
              }),
            )
          : (await api.agents.importFromGithub(created.orgId, input.url)).files.map((f) => ({
              name: f.path,
              text: f.text,
            }));
      const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
      return parseImport(source, files, { models: list.models.map((m) => m.id) });
    },
    meta: { silent: true },
    onSuccess: (result) => {
      if (!result) return;
      setImported(result);
      setImportPick(new Set(result.agents.map((a) => a.key)));
    },
  });
  const importError = readImport.isError
    ? readImport.error instanceof ImportError
      ? t(`onboarding.import.errors.${readImport.error.code}`)
      : readImport.variables && "url" in readImport.variables
        ? t("onboarding.import.errors.link")
        : t("onboarding.import.errors.read")
    : null;
  const resetImport = () => {
    setImported(null);
    setImportPick(new Set());
    readImport.reset();
  };

  const saveAgents = useMutation({
    mutationFn: async () => {
      if (!created) return;
      const provider = key === "platform" ? "anthropic" : key;
      if (key !== "platform" && !keySaved) {
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
          instructions: role ? t(`newAgent.roles.${role}.instructions`) : info.desc,
          model: suggestModel(list.models, provider, list.defaultModel),
          // null = the workspace default key.
          credentialId: null,
          appearance: PRESET_LOOK[p],
        });
        await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: agent.id });
        ids[p] = agent.id;
        setAgentIds({ ...ids });
      }
      // Imported agents: their own name, role and instructions; our model unless theirs is in the catalog.
      const crewSoFar = [...importedCrew];
      const used = new Set([
        ...PRESETS.filter((p) => ids[p]).map((p) => handleFrom(presetInfo(p).name)),
        ...crewSoFar.map((c) => c.handle),
      ]);
      const modelIds = list.models.map((m) => m.id);
      for (const a of pickedImports) {
        const key = importKey(a.key);
        if (crewSoFar.some((c) => c.key === key)) continue;
        const handle = uniqueHandle(a.handle, used);
        used.add(handle);
        const agent = await api.agents.create(created.orgId, {
          name: a.name,
          handle,
          role: a.role || undefined,
          instructions: a.instructions || undefined,
          model: importedModel(a, modelIds, suggestModel(list.models, provider, list.defaultModel)),
          credentialId: null,
          appearance: a.appearance,
        });
        await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: agent.id });
        crewSoFar.push({ key, id: agent.id, handle, name: a.name, appearance: a.appearance });
        setImportedCrew([...crewSoFar]);
      }
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
      // The chosen agents work on the connected computer (else they keep the cloud one).
      if (computer === "machine" && machine) {
        for (const agentId of crewIds) await api.sandbox.setTarget(created.orgId, agentId, machine.id);
      }
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
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      try {
        window.scrollTo({ top: 0 });
      } catch {
        // jsdom/happy-dom without scrolling.
      }
    }
  };

  /** Saves what the step needs, marks it done and moves on. `skip` leaves an optional step as it is. */
  const advance = async (skip = false) => {
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
      if (step.id === "agents") await saveAgents.mutateAsync();
      if (step.id === "computer") await saveComputer.mutateAsync();
      if (step.id === "team") await sendInvites.mutateAsync();
    } else if (step.id === "computer") {
      setComputer(null);
    } else if (step.id === "import") {
      setImportFrom(null);
      resetImport();
    }
    setDone((d) => new Set(d).add(step.id));
    guide.cheer();
    go(index + 1);
  };

  const busy =
    saveWorkspace.isPending ||
    saveContext.isPending ||
    saveAgents.isPending ||
    readImport.isPending ||
    saveComputer.isPending ||
    sendInvites.isPending ||
    finish.isPending;
  const keyOk = key === "platform" || keySaved || keyLooksValid(key, apiKey);
  const blocked =
    (step.id === "workspace" && !org.trim()) ||
    (step.id === "agents" && (chosenCount === 0 || !keyOk)) ||
    (step.id === "computer" && computer === null);

  /** The heading's step (the last one has its own welcome card). */
  const head = step.id === "done" ? null : step.id;
  const eyebrow = step.optional
    ? t("onboarding.stepOfOptional", { n: index + 1, total })
    : t("onboarding.stepOf", { n: index + 1, total });

  const primaryLabel =
    step.id === "done"
      ? t("onboarding.done.open")
      : step.id === "team" && toSend.length > 0
        ? t("onboarding.team.inviteAndContinue")
        : t("common.continue");
  const showSkip =
    step.id === "computer" ||
    (step.id === "import" && importFrom !== null && importFrom !== "none") ||
    (step.id === "team" && toSend.length > 0);
  const hint =
    step.id === "workspace"
      ? t("onboarding.workspace.hint")
      : step.id === "context"
        ? t("onboarding.context.hint")
        : step.id === "import" && active
          ? t("onboarding.import.hint")
          : step.id === "agents"
            ? chosenCount > 0
              ? t("onboarding.agents.count", { count: chosenCount })
              : t("onboarding.agents.none")
            : step.id === "team" && ready.length > 0
              ? t("onboarding.team.ready", { count: ready.length })
              : "";

  return (
    <div className="onb">
      <aside className="onb__rail">
        <span className="onb__brand">
          <Logo size={22} />
        </span>
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
          }))}
        />
        <div className="onb__guide">
          <p className="onb__bubble" role="status" aria-live="polite">
            {t(`onboarding.guide.${step.id}`)}
          </p>
          <AgentAvatar
            name={t(`onboarding.presets.${GUIDE}.name`)}
            appearance={PRESET_LOOK[GUIDE]}
            size="lg"
            className="onb__guide-agent"
            state={guide.typing ? "writing" : undefined}
            expression={guide.happy ? "happy" : undefined}
          />
        </div>
        <OnboardingHorizon progress={done.size / (total - 1)} />
      </aside>

      <main className="onb__main" onInput={guide.onTyping}>
        <div className="onb__body">
          {head && (
            <header className="onb__head">
              <p className="onb__eyebrow">{eyebrow}</p>
              <h1 className="onb__title">
                {head === "agents" && active?.agents.length
                  ? t("onboarding.agents.importedTitle")
                  : t(`onboarding.${head}.title`)}
              </h1>
              <p className="onb__lead">{t(`onboarding.${head}.lead`)}</p>
            </header>
          )}

          {step.id === "workspace" && (
            <Card as="div">
              <div className="row" style={{ gap: 14, alignItems: "center", flexWrap: "nowrap" }}>
                <button
                  type="button"
                  className="onb__logo"
                  aria-label={logo ? t("onboarding.workspace.logoChange") : t("onboarding.workspace.logoPick")}
                  onClick={() => setLogoOpen(true)}
                >
                  {logo ? (
                    <OrgMark logo={`data:${logo.contentType};base64,${logo.imageBase64}`} size={56} />
                  ) : (
                    <Icon name="upload" />
                  )}
                </button>
                <span className="stack-4" style={{ minWidth: 0 }}>
                  <span className="onb__label">{t("onboarding.workspace.logo")}</span>
                  <span className="small muted">{t("onboarding.workspace.logoHelp")}</span>
                </span>
              </div>
              <Field label={t("onboarding.workspace.name")} id="org-name">
                <Input
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder={t("onboarding.workspace.namePlaceholder")}
                  autoFocus
                />
              </Field>
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
            </Card>
          )}

          {step.id === "context" && (
            <Card as="div">
              <Field label={t("onboarding.context.label")} id="org-ctx" help={t("onboarding.context.help")}>
                <Textarea
                  rows={7}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder={t("onboarding.context.placeholder", { org: orgName })}
                />
              </Field>
            </Card>
          )}
          {step.id === "context" && <VaultCard reader={vault} />}

          {step.id === "import" && (
            <OnboardingImport
              source={importFrom}
              onSource={(s) => {
                setImportFrom(s);
                if (s !== imported?.source) readImport.reset();
              }}
              result={imported}
              picked={importPick}
              onPick={(key, on) =>
                setImportPick((p) => {
                  const next = new Set(p);
                  if (on) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
              reading={readImport.isPending}
              error={importError}
              onFiles={(files) => readImport.mutate({ files })}
              onLink={(url) => readImport.mutate({ url })}
              onReset={resetImport}
            />
          )}

          {step.id === "agents" && (
            <>
              {active && active.agents.length > 0 && (
                <>
                  <h2 className="onb__group">{t("onboarding.agents.imported")}</h2>
                  {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
                  <div className="grid-options" role="group" aria-label={t("onboarding.agents.importedLabel")}>
                    {active.agents.map((a) => (
                      <OptionCard
                        key={a.key}
                        agent
                        pressed={importPick.has(a.key)}
                        onClick={() =>
                          setImportPick((p) => {
                            const next = new Set(p);
                            if (next.has(a.key)) next.delete(a.key);
                            else next.add(a.key);
                            return next;
                          })
                        }
                      >
                        <AgentAvatar name={a.name} appearance={a.appearance} />
                        <span className="ac-option__text">
                          <span className="ac-option__title">{a.role ? `${a.name} · ${a.role}` : a.name}</span>
                          {a.description && <span className="ac-option__desc">{a.description}</span>}
                        </span>
                      </OptionCard>
                    ))}
                  </div>
                  <h2 className="onb__group">{t("onboarding.agents.ready")}</h2>
                </>
              )}
              {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
              <div className="grid-options" role="group" aria-label={t("onboarding.agents.listLabel")}>
                {PRESETS.map((p) => {
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
              <KeySection
                title={t("onboarding.workspaceKeyTitle")}
                help={t("onboarding.workspaceKeyHelp")}
                saved={keySaved}
              >
                {/* Once saved (back from a later step), the key stays; Settings changes it. */}
                {!keySaved && (
                  // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
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
                )}
                {key !== "platform" && !keySaved && (
                  <>
                    <Field
                      label={t("onboarding.keyFor", { provider: providerLabel(key) })}
                      id="key-value"
                      error={keyTouched && !keyOk ? t(`onboarding.keyInvalid.${key}`) : undefined}
                    >
                      <Input
                        type="password"
                        placeholder={PROVIDERS.find((p) => p.id === key)?.placeholder}
                        autoComplete="off"
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
                        <Input
                          value={workspaceId}
                          onChange={(e) => setWorkspaceId(e.target.value)}
                          autoComplete="off"
                        />
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
                {models.data && (
                  <span className="small muted">
                    {t("onboarding.suggestedModel", {
                      model:
                        models.data.models.find(
                          (m) =>
                            m.id ===
                            suggestModel(
                              models.data.models,
                              key === "platform" ? "anthropic" : key,
                              models.data.defaultModel,
                            ),
                        )?.label ?? "",
                    })}
                  </span>
                )}
              </KeySection>
            </>
          )}

          {step.id === "computer" && created && (
            <ComputerStep
              orgId={created.orgId}
              computer={computer}
              cloudAvailable={cloudAvailable}
              machine={machine}
              onChoose={(c) => {
                setComputer(c);
                if (c !== "machine") setMachine(null);
              }}
              onPaired={setMachine}
            />
          )}

          {step.id === "team" && created && (
            <TeamStep orgId={created.orgId} invites={invites} sent={sent} onChange={setInvites} agents={crew} />
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
        </div>

        <footer className="onb__foot">
          {hint && <span className="onb__hint">{hint}</span>}
          {index > 0 && (
            <Button variant="ghost" onClick={() => go(index - 1)} disabled={busy}>
              {t("common.back")}
            </Button>
          )}
          {showSkip && (
            <Button variant="ghost" onClick={() => void advance(true).catch(() => {})} disabled={busy}>
              {t("onboarding.skip")}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => void advance().catch(() => {})}
            disabled={blocked || busy}
            loading={busy}
          >
            {primaryLabel}
          </Button>
        </footer>
      </main>
    </div>
  );
}

/** The model key, under the agents. */
function KeySection({
  title,
  help,
  saved,
  children,
}: {
  title: string;
  help: string;
  saved: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card as="section" aria-labelledby="key-title">
      <div className="stack-4">
        <h2 id="key-title" className="section-title">
          {title}
        </h2>
        <span className="small muted">{saved ? t("onboarding.keySaved") : help}</span>
      </div>
      {children}
    </Card>
  );
}

/** A choice card with an icon (computer step). */
function ChoiceCard({
  icon,
  title,
  desc,
  pressed,
  tag,
  disabled,
  onClick,
}: {
  icon: IconName;
  title: string;
  desc: string;
  pressed: boolean;
  tag?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const body = (
    <>
      {tag && <span className="onb__tag">{tag}</span>}
      <span className="onb__ic" aria-hidden="true">
        <Icon name={icon} />
      </span>
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
 * server paired with the runner (the install command, live until it connects).
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
  const [os, setOs] = useState<InstallOs>(() =>
    typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent ?? "")
      ? "darwin"
      : typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent ?? "")
        ? "windows"
        : "linux",
  );
  const [pairing, setPairing] = useState<{ pairing: MachinePairing; known: Set<string> } | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const before = await api.machines.list(orgId).catch(() => [] as Machine[]);
      const p = await api.machines.createPairing(orgId, { name: t("onboarding.computer.defaultName") });
      return { pairing: p, known: new Set(before.map((m) => m.id)) };
    },
    meta: { silent: true },
    onSuccess: setPairing,
  });
  const waiting = computer === "machine" && pairing !== null && machine === null;
  const now = useNow(waiting);
  const left = pairing ? countdown(pairing.pairing.expiresAt, now) : null;
  const machines = useMachines(orgId, waiting, waiting && left ? PAIR_POLL_MS : false);
  const found = pairing ? (machines.data ?? []).find((m) => !pairing.known.has(m.id)) : undefined;
  useEffect(() => {
    if (found && !machine) onPaired(found);
  }, [found, machine, onPaired]);

  const chooseMachine = () => {
    onChoose("machine");
    if (!pairing && !create.isPending) create.mutate();
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
      <div className="onb__choices" role="group" aria-label={t("onboarding.computer.title")}>
        <ChoiceCard
          icon="cloud"
          title={t("onboarding.computer.cloud")}
          desc={cloudAvailable ? t("onboarding.computer.cloudDesc") : t("onboarding.computer.cloudUnavailable")}
          tag={cloudAvailable ? t("onboarding.computer.recommended") : undefined}
          pressed={computer === "cloud"}
          disabled={!cloudAvailable}
          onClick={() => onChoose("cloud")}
        />
        <ChoiceCard
          icon="computer"
          title={t("onboarding.computer.mine")}
          desc={t("onboarding.computer.mineDesc")}
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

      {computer === "machine" && (
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
          ) : create.isError ? (
            <div className="row" role="alert">
              <span className="small">{errorText(t, create.error)}</span>
              <Button size="sm" onClick={() => create.mutate()}>
                {t("onboarding.computer.again")}
              </Button>
            </div>
          ) : !pairing ? (
            <span className="row small muted" role="status" style={{ gap: 8 }}>
              <Spinner />
              {t("onboarding.computer.creating")}
            </span>
          ) : (
            <>
              <Segmented
                value={os}
                onValueChange={setOs}
                label={t("onboarding.computer.osLabel")}
                size="sm"
                options={INSTALL_OSES.map((o) => ({ value: o, label: t(`machines.os.${o}`) }))}
              />
              <span className="onb__label">{t("onboarding.computer.run")}</span>
              {os === "windows" && <span className="small muted">{t("onboarding.computer.windowsHint")}</span>}
              <CommandBlock command={pairing.pairing.installCommand} />
              <span className="small muted">{t("machines.step.noExec", { flag: NO_EXEC_FLAG })}</span>
              <span className="small muted tabular">
                {left
                  ? t("machines.expiresIn", { time: left, code: pairing.pairing.code })
                  : t("machines.expired", { code: pairing.pairing.code })}
              </span>
              {left ? (
                <span className="row small muted" role="status" style={{ gap: 8 }}>
                  <Spinner />
                  {t("machines.waiting")}
                </span>
              ) : (
                <div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setPairing(null);
                      create.mutate();
                    }}
                  >
                    {t("onboarding.computer.again")}
                  </Button>
                </div>
              )}
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
