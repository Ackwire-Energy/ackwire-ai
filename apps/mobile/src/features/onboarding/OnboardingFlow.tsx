import { keys, useApi } from "@agenteschat/client";
import { AUTO } from "@agenteschat/client/lib/providers";
import { handleFrom } from "@agenteschat/client/lib/text";
import { useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { type ComponentProps, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrgGate } from "@/providers/org";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Sky } from "@/sky/Sky";
import { AgentAvatar, Button, Icon, IconButton, type IconName, LineIcon, systemText, Text, useTheme } from "@/ui";
import { chatHref } from "../links/logic";
import { PHOTO_MAX_BASE64, photoContentType } from "../me/logic";
import { TextArea } from "../shared/TextArea";
import {
  emailsFrom,
  GUIDE,
  HOST,
  introducesAt,
  nextStep,
  OPTIONAL,
  PRESET_LOOK,
  PRESET_ROLE,
  PRESETS,
  type Preset,
  phoneTimezone,
  prevStep,
  progressAt,
  STEPS,
  type StepId,
  stepText,
  zoneCity,
} from "./logic";

/**
 * The first run on the phone: signed in with no workspace yet, one
 * question per full screen, hosted by an agent of the team, the progress a strip of sky with a small agent
 * walking at its front. Workspace (logo optional, time zone from the phone) → Contexto → Trazer agentes
 * (optional; brought from the web) → Agentes (they think with an AI plan or a key, connected on the web; nothing
 * to pay or paste on the phone) → Pessoas (optional: share a link or type e-mails) → Pronto, which opens the DM
 * with Ada. No computer step.
 */
export function OnboardingFlow() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const { colors: c } = useTheme();
  const [step, setStep] = useState<StepId>("workspace");
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  const [name, setName] = useState("");
  const [logo, setLogo] = useState<{ base64: string; type: "image/jpeg" | "image/png" | "image/webp" } | null>(null);
  const [context, setContext] = useState("");
  const [savedContext, setSavedContext] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<Preset>>(() => new Set<Preset>(["ada", "theo", "lia"]));
  const [agentIds, setAgentIds] = useState<Partial<Record<Preset, string>>>({});
  const [emails, setEmails] = useState<string[]>([]);
  const [typing, setTyping] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = phoneTimezone();
  const orgName = name.trim();

  const run = async (work: () => Promise<void>, then: StepId) => {
    setPending(true);
    setError(null);
    try {
      await work();
      setStep(then);
    } catch {
      setError(t("mobile.onb.failed"));
    } finally {
      setPending(false);
    }
  };

  const saveWorkspace = () =>
    run(async () => {
      let target = created;
      if (!target) {
        const res = await api.orgs.create({ name: orgName });
        target = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
        setCreated(target);
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

  const saveAgents = () =>
    run(async () => {
      if (!created) return;
      const ids = { ...agentIds };
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
        setAgentIds({ ...ids });
      }
    }, "team");

  const sendInvites = () =>
    run(async () => {
      if (!created) return;
      for (const email of emails)
        await api.orgs.invite(created.orgId, { email, role: "member" }).catch(() => undefined);
    }, "done");

  const shareLink = async () => {
    if (!created) return;
    try {
      const { url } = await api.invites.createLink(created.orgId);
      await Share.share({ message: t("mobile.onb.shareMessage", { org: orgName, url }) });
    } catch {
      setError(t("mobile.onb.failed"));
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

  /** Pronto: the workspace becomes the current one and the conversation with Ada opens. */
  const finish = async () => {
    if (!created) return;
    setPending(true);
    await qc.invalidateQueries({ queryKey: keys.me });
    gate.choose(created.orgId);
    const adaId = agentIds[GUIDE];
    const channelId = adaId
      ? await api.dms
          .open(created.orgId, { agentId: adaId })
          .then((r) => r.channelId)
          .catch(() => null)
      : null;
    setPending(false);
    router.replace(channelId ? chatHref(channelId) : chatHref(created.generalChannelId));
  };

  const host = HOST[step];
  const count = [...chosen].filter((p) => !agentIds[p]).length;
  const [title, lead] = stepText(t, step, orgName, chosen);

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
    team: {
      label: emails.length ? t("onboarding.actions.invite", { count: emails.length }) : t("mobile.onb.later"),
      onPress: () => void (emails.length ? sendInvites() : setStep("done")),
      ready: true,
    },
    done: {
      label: t("mobile.onb.talk", { name: t(`onboarding.presets.${GUIDE}.name`) }),
      onPress: () => void finish(),
      ready: true,
    },
  };
  const action = primary[step];
  const back = prevStep(step);

  return (
    <StepFrame
      step={step}
      title={title}
      lead={lead}
      host={host}
      onBack={back && !pending ? () => setStep(back) : undefined}
      onSkip={OPTIONAL.has(step) && !pending ? () => setStep(nextStep(step)) : undefined}
      footer={
        <>
          {error ? (
            <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
              {error}
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
          {step === "import" ? (
            <Button variant="ghost" wide label={t("mobile.onb.importSkip")} onPress={() => setStep("agents")} />
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
          {zone ? <Note icon="clock" text={t("mobile.onb.zone", { zone: zoneCity(zone) })} /> : null}
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

      {step === "team" ? (
        <>
          <Button
            variant="secondary"
            wide
            icon="share"
            label={t("mobile.onb.share")}
            onPress={() => void shareLink()}
          />
          <Note icon="shield" text={t("mobile.onb.shareNote")} />
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
    </StepFrame>
  );
}

/** Each source's official logo (assets/images/brands/README.md). */
const IMPORT_LOGO = {
  OpenMausBot: require("../../../assets/images/brands/openmausbot.png"),
  OpenBot: require("../../../assets/images/brands/openbot.png"),
} as const;

/** Trazer agentes: the two sources it brings from (on the web: the lead says where). */
function ImportStep() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <>
      {(["OpenMausBot", "OpenBot"] as const).map((source) => (
        <Line
          key={source}
          lead={
            <View style={[styles.logoTile, { backgroundColor: c.sunken, borderColor: c.line }]}>
              <Image source={IMPORT_LOGO[source]} contentFit="contain" style={styles.logo} />
            </View>
          }
          title={t(`mobile.onb.import${source}`)}
        />
      ))}
    </>
  );
}

/** Agentes: the ready team (Ada always), and how they think (an AI plan or a key, connected on the web). */
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
      {PRESETS.map((p) => {
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
      <Line lead={<Icon name="bolt" size={18} />} title={t("mobile.onb.thinkOwn")} sub={t("mobile.onb.thinkOwnSub")} />
    </>
  );
}

/** The frame of every step: the strip of sky on top, the host, the question, the answer, the buttons. */
function StepFrame({
  step,
  title,
  lead,
  host,
  onBack,
  onSkip,
  footer,
  children,
}: {
  step: StepId;
  title: string;
  lead?: string | undefined;
  host: Preset;
  onBack?: (() => void) | undefined;
  onSkip?: (() => void) | undefined;
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
        {onBack ? <IconButton icon="back" label={t("mobile.onb.back")} onPress={onBack} plate /> : null}
        <Strip progress={progressAt(step)} />
        <Text variant="footnote" tone="muted">
          {done ? t("mobile.onb.done") : t("mobile.onb.progress", { n, total })}
        </Text>
        {onSkip ? (
          <Pressable onPress={onSkip} accessibilityRole="button" hitSlop={8}>
            <Text variant="footnote" style={styles.bold}>
              {t("mobile.onb.skip")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Animated.View key={step} entering={FadeIn.duration(220)} style={styles.stack}>
          <Host host={host} intro={introducesAt(step)} happy={done} />
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
function Host({ host, intro, happy }: { host: Preset; intro: boolean; happy: boolean }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={styles.host}>
      <AgentAvatar
        agent={{ ...PRESET_LOOK[host], id: host }}
        size={52}
        {...(happy ? { expression: "happy" as const } : {})}
      />
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
  onPress,
}: {
  lead: ReactNode;
  title: string;
  sub?: string;
  end?: string | undefined;
  onPress?: (() => void) | undefined;
}) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      style={({ pressed }) => [
        styles.line,
        { borderColor: c.line },
        pressed && onPress ? { backgroundColor: c.sunken } : null,
      ]}
    >
      <View style={styles.lead}>{lead}</View>
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold}>
          {title}
        </Text>
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
    </Pressable>
  );
}

function Note({ icon, text, danger = false }: { icon: IconName; text: string; danger?: boolean }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.note}>
      <LineIcon name={icon} size={14} color={danger ? c.danger : c.faint} variant="small" />
      <Text variant="small" tone={danger ? "danger" : "muted"} style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  doneSky: { position: "absolute", left: 0, right: 0, top: 0, height: 320 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
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
    ...systemText("body"),
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
});
