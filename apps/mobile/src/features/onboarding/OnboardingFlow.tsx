import {
  keys,
  type Me,
  newClientId,
  useAiStatus,
  useApi,
  useAuthConfig,
  useComputerSetup,
  useMachines,
  useMe,
} from "@agenteschat/client";
import { computerEdition, computerName } from "@agenteschat/client/lib/computer";
import { settingUp } from "@agenteschat/client/lib/guards";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { firstMentioned } from "@agenteschat/client/lib/markdown";
import { type AiChoice, aiStateOf } from "@agenteschat/client/lib/no-ai";
import { aheadOf, stepIndex } from "@agenteschat/client/lib/onboarding";
import { AUTO } from "@agenteschat/client/lib/providers";
import { handleFrom } from "@agenteschat/client/lib/text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signOut } from "@/features/account";
import { useConnectKey } from "@/features/ai/ConnectAi";
import { authClient } from "@/lib/auth";
import { useOrgGate } from "@/providers/org";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Sky } from "@/sky/Sky";
import {
  AgentAvatar,
  Button,
  fieldText,
  Icon,
  IconButton,
  type IconName,
  InfoHint,
  LineIcon,
  Text,
  useTheme,
} from "@/ui";
import { confirmationSentTo, forgetConfirmationSent } from "../auth/confirmation";
import { chatHref } from "../links/logic";
import { PHOTO_MAX_BASE64, photoContentType } from "../me/logic";
import { TextArea } from "../shared/TextArea";
import { AiStep } from "./AiStep";
import {
  askLineOf,
  type CrewMember,
  DEFAULT_TEAM,
  emailsFrom,
  firstAskOf,
  GUIDE,
  HOST,
  IMPORT_BRAND,
  IMPORT_ROWS,
  type ImportRow,
  introducesAt,
  inviteEach,
  joiningLeft,
  noComputerOf,
  OPTIONAL,
  PRESET_LOOK,
  PRESET_ROLE,
  PRESET_ROWS,
  PRESETS,
  type Preset,
  phoneTimezone,
  presetsMade,
  prevStep,
  progressAt,
  resumeOf,
  STEPS,
  type StepId,
  serverStepOf,
  setUpElsewhere,
  stepFailedText,
  stepText,
  stepToSave,
  zoneLabel,
} from "./logic";

/**
 * The first run on the phone: signed in with no workspace to open yet (none, or one still being set up, which it
 * resumes), one question per full screen, hosted by an agent of the team, the progress a strip of sky with a small agent
 * walking at its front. Workspace (logo optional, time zone from the phone) → Contexto → Trazer agentes
 * (optional; brought from the web) → Agentes → IA (optional: an AI plan or an API key, skipped when the agents
 * already think with one) → Pessoas (optional: type e-mails or share a link) → Pronto: the team's welcome and the
 * first message, offered by the agent best placed to start, sent to #general. No computer step.
 */
export function OnboardingFlow() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const me = useMe();
  const { colors: c } = useTheme();
  const [step, setStep] = useState<StepId>("workspace");
  // The furthest step reached here, as the server counts them (`stepIndex`).
  const [reached, setReached] = useState(0);
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  const [name, setName] = useState("");
  const [logo, setLogo] = useState<{ base64: string; type: "image/jpeg" | "image/png" | "image/webp" } | null>(null);
  const [context, setContext] = useState("");
  const [savedContext, setSavedContext] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<Preset>>(() => new Set<Preset>(DEFAULT_TEAM));
  const [agentIds, setAgentIds] = useState<Partial<Record<Preset, string>>>({});
  const [handles, setHandles] = useState<Partial<Record<Preset, string>>>({});
  const [emails, setEmails] = useState<string[]>([]);
  const [typing, setTyping] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const [invited, setInvited] = useState(0);
  const [pending, setPending] = useState(false);
  // A failure belongs to the step it happened on: going on or back leaves it there.
  const [error, setError] = useState<{ at: StepId; text: string } | null>(null);
  const zone = phoneTimezone();
  const orgName = name.trim();
  // The AI step's key, for the workspace just created (no workspace is chosen yet: it gets the id).
  const ai = useConnectKey(created?.orgId ?? "");
  // The AI step's option (the plans first, as on the web) and the agents a plan was connected for there.
  const [aiShown, setAiShown] = useState<AiChoice | null>(null);
  const [planned, setPlanned] = useState<string[]>([]);
  const [aiSaved, setAiSaved] = useState(false);
  const authConfig = useAuthConfig().data;
  // Whether a computer is a choice: the workspace's setup says, and the server before it exists; never a guess.
  const setup = useComputerSetup(created?.orgId ?? "", Boolean(created));
  const edition = computerEdition(setup.data, authConfig?.workspaceComputer);
  const machines = useMachines(created?.orgId ?? "", Boolean(created) && edition === "selfhost");
  const noComputer = noComputerOf(edition, machines.data);
  // A server that sends no email invites by link only.
  const emailsGoOut = sendsEmail(authConfig);
  // Done's first message, written for whoever asks it when the step opens (`team`: the crew it was written for).
  // Its `clientId` changes with its text: sent again after an answer that never came back, it's posted once.
  const [firstAsk, setFirstAsk] = useState<{ team: string; asker: Preset; text: string; clientId: string } | null>(
    null,
  );

  // The address this sign-up was emailed a link to confirm (features/auth/confirmation.ts): the first step says
  // where it went, until `me` says it's confirmed.
  const email = me.data?.user.email ?? "";
  const unconfirmed =
    email !== "" && confirmationSentTo() === email.toLowerCase() && me.data?.user.emailVerified !== true;

  // The agents created so far, in the team's order: who Done shows and who may offer the first message.
  const crew: CrewMember[] = PRESETS.flatMap((p) => {
    const id = agentIds[p];
    const presetName = t(`onboarding.presets.${p}.name`);
    return id ? [{ key: p, id, handle: handles[p] ?? handleFrom(presetName), name: presetName }] : [];
  });
  const team = crew.map((m) => m.key).join(" ");
  const askText = firstAsk?.text ?? "";
  const asking = askText.trim() !== "";
  // Whoever the text mentions first speaks, and gets it; with nobody named, the router picks who answers.
  const mentioned = firstMentioned(askText, crew);
  const speaker = mentioned ?? crew.find((m) => m.key === firstAsk?.asker);
  // No socket is open here: an agent waiting for its computer is asked about again until it can start.
  const aiNow = useAiStatus(created?.orgId ?? "", step === "done" && speaker !== undefined, (status) =>
    mentioned && aiStateOf(status, mentioned.id) === "waiting" ? AI_POLL_MS : false,
  );
  const askLine = askLineOf(t, {
    text: askText,
    mentioned,
    status: aiNow.data,
    computer: computerName(t, orgName, null),
  });

  // Done: the AI status is asked again (one connected on the way counts), and the first message is written once for
  // the team it opens with, kept through edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when Done opens, and when the team changes
  useEffect(() => {
    if (step !== "done" || !created) return;
    void qc.invalidateQueries({ queryKey: keys.aiStatus(created.orgId) });
    if (firstAsk?.team === team) return;
    const offer = firstAskOf(t, crew);
    setFirstAsk(offer ? { team, ...offer, clientId: newClientId() } : null);
  }, [step, team]);

  // Each step reached is saved, so the web, or the app opened again, resumes there (creating the workspace passed the
  // first one).
  const reach = async (next: StepId) => {
    const saving = created ? stepToSave(next, reached) : null;
    const at = created && saving ? await api.orgs.saveOnboarding(created.orgId, { step: saving }) : null;
    // Further on, or finished, on the web or another device: `me` again, which the app follows (finished, it opens).
    if (at && saving && aheadOf(at, saving)) await qc.invalidateQueries({ queryKey: keys.me });
    if (at?.finished) return;
    setReached((r) => Math.max(r, stepIndex(serverStepOf(next))));
    setStep(next);
  };

  const run = async (work: () => Promise<void>, then: StepId | (() => StepId)) => {
    setPending(true);
    setError(null);
    try {
      await work();
      await reach(typeof then === "function" ? then() : then);
    } catch (e) {
      setError({ at: step, text: stepFailedText(t, e, i18n.language) });
    } finally {
      setPending(false);
    }
  };
  const skipTo = (next: StepId) => void run(async () => {}, next);

  const saveWorkspace = () =>
    run(async () => {
      let target = created;
      if (!target) {
        const res = await api.orgs.create({ name: orgName });
        target = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
        setCreated(target);
        setName(res.organization.name);
        // One being set up comes back instead of a new one: `me` says how far it got, and the resume opens it there.
        await qc.invalidateQueries({ queryKey: keys.me });
        if (setUpElsewhere(qc.getQueryData<Me | null>(keys.me)?.organizations, target.orgId)) return;
        await Promise.all([
          zone ? api.orgs.updateSettings(target.orgId, { timezone: zone }) : null,
          zone ? api.orgs.updateMe(target.orgId, { timezone: zone }) : null,
          api.account.updateMe({ locale: i18n.language.startsWith("en") ? "en" : "pt-BR" }),
        ]).catch(() => undefined);
      } else {
        await api.orgs.updateSettings(target.orgId, { name: orgName });
      }
      if (logo) await api.orgs.setLogo(target.orgId, { imageBase64: logo.base64, contentType: logo.type });
    }, "context");

  const saveContext = () =>
    run(async () => {
      if (!created || context.trim() === savedContext) return;
      await api.orgs.updateSettings(created.orgId, { context: context.trim() });
      setSavedContext(context.trim());
    }, "import");

  const saveAgents = () => {
    let next: StepId = "ai";
    return run(
      async () => {
        if (!created) return;
        // One made already (on the web, or by a create cut short) is kept, never made twice, and put in #general,
        // where mentions reach it (once more is harmless).
        const made = presetsMade(t, await api.agents.list(created.orgId));
        for (const p of PRESETS) {
          const id = made.ids[p];
          if (id) await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: id });
        }
        const ids = { ...agentIds, ...made.ids };
        const named = { ...handles, ...made.handles };
        setAgentIds({ ...ids });
        setHandles({ ...named });
        for (const p of PRESETS) {
          if (!chosen.has(p) || ids[p]) continue;
          const role = PRESET_ROLE[p];
          const agent = await api.agents.create(created.orgId, {
            name: t(`onboarding.presets.${p}.name`),
            handle: handleFrom(t(`onboarding.presets.${p}.name`)),
            role: t(`onboarding.presets.${p}.role`),
            instructions: role ? t(`newAgent.roles.${role}.instructions`) : t("onboarding.presets.lia.instructions"),
            // "Automático": each task gets its model and effort.
            model: AUTO,
            // null = the workspace's default key (or a subscription, connected on the computer).
            credentialId: null,
            appearance: PRESET_LOOK[p],
          });
          await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: agent.id });
          ids[p] = agent.id;
          // As the server made it (a taken handle gets another): the first message mentions this one.
          named[p] = agent.handle;
          setAgentIds({ ...ids });
          setHandles({ ...named });
        }
        // The AI step only when the agents have nothing to think with yet (a platform key on Cloud, a key
        // saved going back and forth).
        const status = await api.agents.aiStatus(created.orgId).catch(() => null);
        if (status?.any) next = "team";
      },
      () => next,
    );
  };

  const saveAi = async () => {
    setError(null);
    if (await ai.save()) {
      setAiSaved(true);
      skipTo("team");
    }
  };

  // An invitation that fails keeps its address on the step, with the line that says so: only those go again.
  const sendInvites = async () => {
    if (!created) return;
    setPending(true);
    setError(null);
    const failed = await inviteEach(emails, (email) => api.orgs.invite(created.orgId, { email, role: "member" }));
    setPending(false);
    setInvited((n) => n + emails.length - failed.length);
    setEmails(failed);
    if (failed.length) setError({ at: "team", text: t("mobile.onb.invitesFailed") });
    else skipTo("done");
  };

  const shareLink = async () => {
    if (!created) return;
    try {
      const { url } = await api.invites.createLink(created.orgId);
      await Share.share({ message: t("mobile.onb.shareMessage", { org: orgName, url }) });
    } catch (e) {
      setError({ at: step, text: stepFailedText(t, e) });
    }
  };

  const pickLogo = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
      base64: true,
    });
    const a = res.canceled ? null : res.assets[0];
    if (!a?.base64 || a.base64.length > PHOTO_MAX_BASE64) return;
    setLogo({ base64: a.base64, type: photoContentType(a.mimeType, a.fileName) });
  };

  const addTyped = (text = typing) => {
    const { valid, invalid } = emailsFrom(text, emails);
    if (valid.length) setEmails([...emails, ...valid]);
    setBad(invalid);
    setTyping(invalid.join(" "));
  };

  /**
   * Pronto: the first message goes to #general (if there is one), the workspace becomes the current one and
   * #general opens. A failed post stays on Done with its text.
   */
  const finish = async (message: { body: string; clientId: string } | null) => {
    if (!created) return;
    setPending(true);
    setError(null);
    try {
      // Finished on the web or another device, its first message went from there: none again here.
      const at = await api.orgs.saveOnboarding(created.orgId, { step: "done" });
      if (message && !at?.finished) await api.chat.post(created.orgId, created.generalChannelId, message);
      await api.orgs.saveOnboarding(created.orgId, { finished: true });
    } catch {
      setPending(false);
      setError({ at: "done", text: t("mobile.app.failed") });
      return;
    }
    forgetConfirmationSent();
    await qc.invalidateQueries({ queryKey: keys.me });
    gate.choose(created.orgId);
    // The lists were loaded (prefetched) before the first message: the conversation finds #general in them for its
    // header. Pushed over the tabs, so its back button leads home.
    await qc.invalidateQueries({ queryKey: keys.channels(created.orgId), refetchType: "all" }).catch(() => {});
    setPending(false);
    router.push(chatHref(created.generalChannelId));
  };

  // The workspace being set up, as the server keeps it (made here or on the web): opened at the furthest step
  // reached with what was saved, and followed when the web gets further.
  const mine = created
    ? me.data?.organizations.find((o) => o.id === created.orgId)
    : me.data?.organizations.find(settingUp);
  const saved = mine?.onboarding ? { orgId: mine.id, ...mine.onboarding } : null;
  const behind = saved !== null && stepIndex(saved.step) > reached;
  const resume = useQuery({
    queryKey: ["onboarding", "resume", saved?.orgId, saved?.step],
    enabled: behind,
    gcTime: 0,
    queryFn: async () => {
      if (!saved) return null;
      const [settings, agents, sources] = await Promise.all([
        api.orgs.settings(saved.orgId),
        api.agents.list(saved.orgId),
        saved.step === "import" ? api.imports.sources(saved.orgId).catch(() => []) : [],
      ]);
      return { settings, ...resumeOf(t, saved, agents, sources.length > 0) };
    },
  });
  useEffect(() => {
    const r = resume.data;
    if (!r || pending || r.reached <= reached) return;
    setCreated(r.created);
    setName(r.settings.name);
    setContext(r.settings.context);
    setSavedContext(r.settings.context);
    setAgentIds(r.ids);
    setHandles(r.handles);
    if (r.chosen) setChosen(r.chosen);
    setReached(r.reached);
    setStep(r.step);
  }, [resume.data, pending, reached]);

  const host = HOST[step];
  const count = joiningLeft(chosen, agentIds);
  const [title, lead] = stepText(t, step, { org: orgName, chosen, aiSaved, invited, noComputer });

  const primary: Partial<Record<StepId, { label: string; onPress: () => void; ready: boolean }>> = {
    workspace: {
      label: t("onboarding.actions.continue"),
      onPress: () => void saveWorkspace(),
      ready: orgName.length > 0,
    },
    context: { label: t("onboarding.actions.continue"), onPress: () => void saveContext(), ready: true },
    agents: {
      label: count > 0 ? t("onboarding.actions.create", { count }) : t("onboarding.actions.continue"),
      onPress: () => void saveAgents(),
      ready: true,
    },
    // A key is saved by the step's button; a plan is connected in its panel, then the step goes on.
    ...(aiShown === "key"
      ? {
          ai: {
            label: ai.saving ? t("mobile.ai.saving") : t("mobile.ai.save"),
            onPress: () => void saveAi(),
            ready: ai.ready && ai.looksRight && !ai.saving,
          },
        }
      : planned.length > 0
        ? { ai: { label: t("onboarding.actions.continue"), onPress: () => skipTo("team"), ready: true } }
        : {}),
    // With no e-mails the step has no main action: "Agora não" is the quiet way on, below.
    ...(emails.length
      ? {
          team: {
            label: t("onboarding.actions.invite", { count: emails.length }),
            onPress: () => void sendInvites(),
            ready: true,
          },
        }
      : {}),
    done: {
      label: !asking
        ? t("onboarding.done.open")
        : mentioned
          ? t("onboarding.done.first.send", { name: mentioned.name })
          : t("onboarding.done.first.sendGeneral"),
      onPress: () => void finish(asking && firstAsk ? { body: askText.trim(), clientId: firstAsk.clientId } : null),
      ready: true,
    },
  };
  const action = primary[step];
  const back = prevStep(step);

  // Never the form that would make another workspace while one is being set up: its saved state loads first.
  if (created === null && behind)
    return (
      <View style={[styles.screen, styles.wait, { backgroundColor: c.bg }]}>
        {resume.isError ? (
          <>
            <Text tone="muted" style={styles.waitText}>
              {t("common.loadFailed")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => void resume.refetch()}
            />
          </>
        ) : null}
      </View>
    );

  return (
    <StepFrame
      step={step}
      title={title}
      lead={lead}
      head={step === "done" ? <TeamFaces crew={crew} /> : <Host host={host} intro={introducesAt(step)} />}
      onBack={back && !pending ? () => setStep(back) : undefined}
      footer={
        <>
          {error?.at === step ? (
            <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
              {error.text}
            </Text>
          ) : null}
          {action ? (
            <Button
              variant="primary"
              wide
              label={action.label}
              disabled={!action.ready || pending}
              onPress={action.onPress}
            />
          ) : null}
          {/* Until a workspace is set up this is the only screen: the way out of the account is on its first step. */}
          {step === "workspace" ? (
            <Button
              variant="ghost"
              wide
              label={t("mobile.org.signOut")}
              disabled={pending}
              onPress={() => void signOut()}
            />
          ) : null}
          {step === "import" ? (
            <Button variant="ghost" wide label={t("mobile.onb.importSkip")} onPress={() => skipTo("agents")} />
          ) : null}
          {step === "ai" ? (
            <Button variant="ghost" wide label={t("connectAi.later")} onPress={() => skipTo("team")} />
          ) : null}
          {step === "team" ? (
            <Button variant="ghost" wide label={t("mobile.onb.later")} onPress={() => skipTo("done")} />
          ) : null}
          {/* On Done the quiet way opens #general without the first message, while there is one. */}
          {step === "done" && asking ? (
            <Button
              variant="ghost"
              wide
              label={t("onboarding.done.first.skip")}
              disabled={pending}
              onPress={() => void finish(null)}
            />
          ) : null}
        </>
      }
    >
      {step === "workspace" ? (
        <>
          <Field
            value={name}
            onChangeText={setName}
            placeholder={t("onboarding.workspace.namePlaceholder")}
            label={t("onboarding.workspace.name")}
            autoFocus
            onSubmitEditing={orgName ? () => void saveWorkspace() : undefined}
          />
          <Line
            lead={<Icon name="image" size={18} />}
            title={t("mobile.onb.logo")}
            sub={logo ? t("onboarding.workspace.logoChange") : t("mobile.onb.logoHelp")}
            end={t("mobile.onb.logoPick")}
            onPress={() => void pickLogo()}
          />
          {zone ? <Note icon="clock" text={t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })} /> : null}
          {unconfirmed ? <ConfirmationNote email={email} /> : null}
        </>
      ) : null}

      {step === "context" ? (
        <>
          <TextArea
            value={context}
            onChangeText={setContext}
            placeholder={t("onboarding.context.placeholder", { org: orgName || t("onboarding.yourCompany") })}
            accessibilityLabel={t("onboarding.context.label")}
            minHeight={140}
          />
          <View style={styles.chips}>
            {(["sell", "who", "rules"] as const).map((k) => (
              <Pressable
                key={k}
                onPress={() =>
                  setContext((v) => {
                    const gap = v && !v.endsWith("\n") ? "\n" : "";
                    return `${v}${gap}${t(`onboarding.context.starters.${k}.text`)}`;
                  })
                }
                accessibilityRole="button"
                style={[styles.chip, { borderColor: c.line2 }]}
              >
                <Icon name="plus" size={14} />
                <Text variant="small">{t(`onboarding.context.starters.${k}.label`)}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      {step === "import" ? <ImportStep /> : null}

      {step === "agents" ? (
        <AgentsStep
          chosen={chosen}
          created={agentIds}
          onToggle={(p) =>
            setChosen((prev) => {
              const next = new Set(prev);
              if (next.has(p)) next.delete(p);
              else next.add(p);
              return next;
            })
          }
        />
      ) : null}

      {step === "ai" && created ? (
        <AiStep
          orgId={created.orgId}
          orgName={orgName}
          agents={crew.map((m) => ({ id: m.id, name: m.name }))}
          form={ai}
          planned={planned}
          onPlanned={(id) => setPlanned((l) => (l.includes(id) ? l : [...l, id]))}
          onShown={setAiShown}
        />
      ) : null}

      {step === "team" ? (
        <>
          {emailsGoOut ? (
            <>
              <View style={styles.emails}>
                {emails.map((e) => (
                  <Pressable
                    key={e}
                    onPress={() => setEmails(emails.filter((x) => x !== e))}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.onb.removeEmail", { email: e })}
                    style={[styles.chip, { borderColor: c.line2, backgroundColor: c.sunken }]}
                  >
                    <Text variant="small">{e}</Text>
                    <Icon name="x" size={12} />
                  </Pressable>
                ))}
              </View>
              <Field
                value={typing}
                onChangeText={(v) => {
                  setBad([]);
                  if (/[\s,;]$/.test(v)) addTyped(v);
                  else setTyping(v);
                }}
                onSubmitEditing={() => addTyped()}
                onBlur={() => addTyped()}
                placeholder={t("mobile.onb.emailsPlaceholder")}
                label={t("onboarding.team.emails")}
                keyboardType="email-address"
              />
              {bad.length ? <Note icon="help" text={t("mobile.onb.invalidEmail")} danger /> : null}
              <Note icon="agent" text={t("mobile.onb.membersNote")} />
            </>
          ) : null}
          <Button
            variant="secondary"
            wide
            icon="share"
            label={t("mobile.onb.share")}
            onPress={() => void shareLink()}
          />
          <Note icon="shield" text={t("mobile.onb.shareNote")} />
        </>
      ) : null}

      {step === "done" && speaker ? (
        <FirstAsk
          speaker={speaker}
          said={
            !asking
              ? t("onboarding.done.first.empty")
              : savedContext
                ? t("onboarding.done.first.read", { org: orgName })
                : t("onboarding.done.first.unread")
          }
          value={askText}
          onChange={(text) => setFirstAsk((a) => a && { ...a, text, clientId: newClientId() })}
          line={askLine}
        />
      ) : null}
    </StepFrame>
  );
}

/** How often Done asks again about an agent waiting for its computer (no socket is open here), as the web does. */
const AI_POLL_MS = 5000;

/** Each app's official logo (assets/images/brands/README.md); a dark file where the maker has one. */
const IMPORT_LOGO: Record<ImportRow, { light: number; dark?: number }> = {
  "grok-bot": {
    light: require("../../../assets/images/brands/grok-bot.png"),
    dark: require("../../../assets/images/brands/grok-bot-dark.png"),
  },
  "chatgpt-dots": { light: require("../../../assets/images/brands/chatgpt-dots.png") },
  openbotrun: { light: require("../../../assets/images/brands/openbotrun.png") },
};

/**
 * Trazer agentes: the three most used apps the web brings agents from, with where the file is behind the ⓘ. Grok Bot
 * and ChatGPT dots have none: on the web they answer a request, not a file.
 */
function ImportStep() {
  const { t } = useTranslation();
  const { colors: c, scheme } = useTheme();
  return (
    <>
      {IMPORT_ROWS.map((row) => {
        const logo = IMPORT_LOGO[row];
        return (
          <Line
            key={row}
            lead={
              <View style={[styles.logoTile, { backgroundColor: c.sunken, borderColor: c.line }]}>
                <Image
                  source={scheme === "dark" ? (logo.dark ?? logo.light) : logo.light}
                  contentFit="contain"
                  style={styles.logo}
                />
              </View>
            }
            title={IMPORT_BRAND[row]}
            hint={row === "openbotrun" ? t("onboarding.import.where.openbotrun") : undefined}
          />
        );
      })}
    </>
  );
}

/** Agentes: the ready team, Ada always (what they think with is the next step's). */
function AgentsStep({
  chosen,
  created,
  onToggle,
}: {
  chosen: ReadonlySet<Preset>;
  created: Partial<Record<Preset, string>>;
  onToggle: (p: Preset) => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <>
      {PRESET_ROWS.map((p) => {
        const locked = p === GUIDE || Boolean(created[p]);
        const on = chosen.has(p);
        return (
          <Pressable
            key={p}
            onPress={locked ? undefined : () => onToggle(p)}
            disabled={locked}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled: locked }}
            style={[styles.line, { borderColor: c.line }]}
          >
            <AgentAvatar agent={{ ...PRESET_LOOK[p], id: p }} size={38} />
            <View style={styles.grow}>
              <Text variant="body" style={styles.bold}>
                {t(`onboarding.presets.${p}.name`)}{" "}
                <Text variant="body" tone="faint">
                  · {t(`onboarding.presets.${p}.role`)}
                </Text>
              </Text>
              <Text variant="small" tone="muted">
                {p === GUIDE ? t("mobile.onb.agentsAda") : t(`onboarding.presets.${p}.desc`)}
              </Text>
            </View>
            <View
              style={[styles.box, { borderColor: on ? c.ink : c.line2, backgroundColor: on ? c.ink : "transparent" }]}
            >
              {on ? <Icon name={locked ? "lock" : "check"} size={14} color={c.bg} /> : null}
            </View>
          </Pressable>
        );
      })}
    </>
  );
}

/** Done's welcome: the team's faces, each with its name and role (the screen reader reads them from the lead). */
function TeamFaces({ crew }: { crew: CrewMember[] }) {
  const { t } = useTranslation();
  if (crew.length === 0) return null;
  return (
    <View style={styles.faces} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {crew.map((m) => (
        <View key={m.key} style={styles.face}>
          <AgentAvatar agent={{ ...PRESET_LOOK[m.key], id: m.id }} size={48} expression="happy" />
          <Text variant="caption" style={styles.bold} numberOfLines={1}>
            {m.name}
          </Text>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {t(`onboarding.presets.${m.key}.role`)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Done's first message: the agent best placed to start offers it in a bubble, the person can change it, and the big
 * button sends it to #general. Under it, whether the agent it names can start now.
 */
function FirstAsk({
  speaker,
  said,
  value,
  onChange,
  line,
}: {
  speaker: CrewMember;
  said: string;
  value: string;
  onChange: (text: string) => void;
  line: { icon: IconName; text: string } | null;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <>
      {/* Another speaker pops in, as each step's host does. */}
      <Animated.View key={speaker.key} entering={FadeIn.duration(220)} style={styles.host}>
        <AgentAvatar agent={{ ...PRESET_LOOK[speaker.key], id: speaker.id }} size={44} expression="happy" />
        <View style={[styles.bubble, { backgroundColor: c.raised, borderColor: c.line }]}>
          <Text variant="small">{said}</Text>
        </View>
      </Animated.View>
      <TextArea
        value={value}
        onChangeText={onChange}
        placeholder={t("onboarding.done.first.placeholder")}
        accessibilityLabel={t("onboarding.done.first.label")}
        minHeight={52}
      />
      {line ? <Note icon={line.icon} text={line.text} live /> : null}
    </>
  );
}

/**
 * The workspace step's note that the sign-up's confirmation link went to the person's address, with a new link a
 * tap away; gone once `me` says the address is confirmed.
 */
function ConfirmationNote({ email }: { email: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const [sent, setSent] = useState<"no" | "sending" | "sent" | "failed">("no");
  const resend = async () => {
    setSent("sending");
    const res = await authClient()
      .sendVerificationEmail({ email })
      .catch(() => null);
    setSent(res && !res.error ? "sent" : "failed");
  };
  return (
    <View style={styles.note} accessibilityLiveRegion="polite">
      <LineIcon name="mail" size={14} color={c.faint} variant="small" />
      <View style={styles.grow}>
        <Text variant="small" tone="muted">
          {sent === "sent" ? t("auth.newLinkSent", { email }) : t("onboarding.confirmation.sent", { email })}
        </Text>
        {sent === "sent" ? null : (
          <Pressable
            onPress={() => void resend()}
            disabled={sent === "sending"}
            accessibilityRole="button"
            hitSlop={8}
            style={styles.linkButton}
          >
            <Text variant="small" style={styles.bold}>
              {t("auth.sendNewLink")}
            </Text>
          </Pressable>
        )}
        {sent === "failed" ? (
          <Text variant="small" tone="danger">
            {t("mobile.app.failed")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** The frame of every step: the strip of sky on top, the host, the question, the answer, the buttons. */
function StepFrame({
  step,
  title,
  lead,
  head,
  onBack,
  footer,
  children,
}: {
  step: StepId;
  title: string;
  lead?: string | undefined;
  /** Above the question: the step's host, or Done's team. */
  head: ReactNode;
  onBack?: (() => void) | undefined;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const total = STEPS.length - 1;
  const n = Math.min(STEPS.indexOf(step) + 1, total);
  const done = step === "done";
  return (
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: c.bg }]} behavior="padding">
      {done ? <Sky color="sky" depth={0.8} fade={0.4} style={styles.doneSky} /> : null}
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        {/* The first step has no way back: its place stays, so the strip doesn't shift on the next one. */}
        {onBack ? (
          <IconButton icon="back" label={t("mobile.onb.back")} onPress={onBack} plate />
        ) : done ? null : (
          <View style={styles.backSpace} />
        )}
        <Strip progress={progressAt(step)} />
        <Text variant="footnote" tone="muted">
          {done ? t("mobile.onb.done") : t("mobile.onb.progress", { n, total })}
        </Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Animated.View key={step} entering={FadeIn.duration(220)} style={styles.stack}>
          {head}
          <Text variant="display" accessibilityRole="header">
            {title}
            {OPTIONAL.has(step) ? (
              <Text variant="footnote" tone="faint">
                {"  "}
                {t("mobile.onb.optional")}
              </Text>
            ) : null}
          </Text>
          {lead ? (
            <Text variant="callout" tone="muted">
              {lead}
            </Text>
          ) : null}
          <View style={styles.answer}>{children}</View>
        </Animated.View>
      </ScrollView>
      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) }]}>{footer}</View>
    </KeyboardAvoidingView>
  );
}

/** The progress: a strip of sky that fills, with a small agent walking at its front. */
function Strip({ progress }: { progress: number }) {
  const { colors: c } = useTheme();
  const [width, setWidth] = useState(0);
  const x = Math.max(0, Math.min(width - 18, progress * width - 9));
  return (
    <View style={styles.strip} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Dither
        kind="bar"
        tones={softTones("sky", c.bg)}
        pixel={2}
        extra={{ value: Math.max(0.04, progress) }}
        animated={false}
        style={[StyleSheet.absoluteFill, styles.stripFill]}
      />
      <View style={[styles.walker, { left: x }]}>
        <AgentAvatar agent={{ color: "sky", eyes: "round", id: "guide" }} size={18} mode="run" framed={false} />
      </View>
    </View>
  );
}

/** The step's host: says hi the first time, then its name and role. */
function Host({ host, intro }: { host: Preset; intro: boolean }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={styles.host}>
      <AgentAvatar agent={{ ...PRESET_LOOK[host], id: host }} size={52} />
      {intro ? (
        <View style={[styles.bubble, { backgroundColor: c.raised, borderColor: c.line }]}>
          <Text variant="small">{t(`onboarding.hosts.${host}`)}</Text>
        </View>
      ) : (
        <View>
          <Text variant="body" style={styles.bold}>
            {t(`onboarding.presets.${host}.name`)}
          </Text>
          <Text variant="small" tone="muted">
            {t(`onboarding.presets.${host}.role`)}
          </Text>
        </View>
      )}
    </View>
  );
}

function Field({ label, ...props }: { label: string } & ComponentProps<typeof TextInput>) {
  const { colors: c } = useTheme();
  return (
    <TextInput
      placeholderTextColor={c.faint}
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="done"
      {...props}
      style={[styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line2 }]}
    />
  );
}

function Line({
  lead,
  title,
  sub,
  end,
  hint,
  onPress,
}: {
  lead: ReactNode;
  title: string;
  sub?: string;
  end?: string | undefined;
  /** An ⓘ after the title ("About <title>"), this text under the row's words. */
  hint?: string | undefined;
  onPress?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const name = (
    <Text variant="body" style={styles.bold}>
      {title}
    </Text>
  );
  const content = (
    <>
      <View style={styles.lead}>{lead}</View>
      <View style={styles.grow}>
        {hint ? (
          <InfoHint name={t("common.about", { label: title })} text={hint} variant="body">
            {name}
          </InfoHint>
        ) : (
          name
        )}
        {sub ? (
          <Text variant="small" tone="muted">
            {sub}
          </Text>
        ) : null}
      </View>
      {end ? (
        <Text variant="small" style={styles.bold}>
          {end}
        </Text>
      ) : null}
    </>
  );
  // Without an action it's a plain row: a Pressable with nothing to do reads as a dimmed button to VoiceOver.
  if (!onPress) return <View style={[styles.line, { borderColor: c.line }]}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.line, { borderColor: c.line }, pressed ? { backgroundColor: c.sunken } : null]}
    >
      {content}
    </Pressable>
  );
}

function Note({
  icon,
  text,
  danger = false,
  live = false,
}: {
  icon: IconName;
  text: string;
  danger?: boolean;
  /** Said as it changes (Done's line under the first message). */
  live?: boolean;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.note} {...(live ? { accessibilityLiveRegion: "polite" as const } : {})}>
      <LineIcon name={icon} size={14} color={danger ? c.danger : c.faint} variant="small" />
      <Text variant="small" tone={danger ? "danger" : "muted"} style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wait: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  waitText: { textAlign: "center" },
  doneSky: { position: "absolute", left: 0, right: 0, top: 0, height: 320 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  backSpace: { width: 40, height: 40 },
  strip: { flex: 1, height: 22, justifyContent: "center" },
  stripFill: { top: 8, bottom: 8, borderRadius: 3, overflow: "hidden" },
  walker: { position: "absolute", top: 0 },
  body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 },
  stack: { gap: 10 },
  host: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  bubble: {
    flexShrink: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  answer: { gap: 12, marginTop: 12 },
  dock: { gap: 8, paddingHorizontal: 24, paddingTop: 8 },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...fieldText("body"),
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  emails: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lead: { width: 38, alignItems: "center" },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  // The web's `.imp-mark` tile (apps/web/src/components/import-flow.css).
  logoTile: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: { width: 22, height: 22 },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  linkButton: { alignSelf: "flex-start", marginTop: 2 },
  faces: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 6 },
  face: { width: 68, alignItems: "center", gap: 2 },
});
