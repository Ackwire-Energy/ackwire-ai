import { keys, useApi, useMe } from "@agenteschat/client";
import { settingUp } from "@agenteschat/client/lib/guards";
import { finishOnboarding, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signOut } from "@/features/account";
import { authClient } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { useOrgGate } from "@/providers/org";
import { AgentAvatar, Button, fieldText, Icon, type IconName, LineIcon, Text, textLineOf, useTheme } from "@/ui";
import { WholeAccount } from "@/ui/auth/WholeAccount";
import { leadBox } from "@/ui/type-scale";
import { fullLook } from "../agents/edit";
import { openPage } from "../ai/parts";
import { confirmationSentTo, forgetConfirmationSent } from "../auth/confirmation";
import { chatHref } from "../links/logic";
import { PHOTO_MAX_BASE64, photoContentType } from "../me/logic";
import { phoneTimezone, stepFailedText, zoneLabel } from "./logic";

/**
 * The first run on the phone, signed in with no workspace to open yet: one question, the workspace's name (its logo
 * optional, its time zone from the phone), asked by its right hand; then the right hand's DM, where the rest of the
 * setup is cards (ADR 0137), as on the web. A workspace still being set up (an older onboarding left at any step,
 * here or on the web) is finished and opened there, never a second one. `onLeave`: opened over a workspace being
 * deleted, it goes back to it until a new one is made.
 */
export function OnboardingFlow({ onLeave }: { onLeave?: () => void } = {}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const me = useMe();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [logo, setLogo] = useState<{ base64: string; type: "image/jpeg" | "image/png" | "image/webp" } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = phoneTimezone();
  const orgName = name.trim();

  // The address this sign-up was emailed a link to confirm (features/auth/confirmation.ts): the step says where it
  // went, until `me` says it's confirmed.
  const email = me.data?.user.email ?? "";
  const unconfirmed =
    email !== "" && confirmationSentTo() === email.toLowerCase() && me.data?.user.emailVerified !== true;

  /** Finishes it and opens its right hand's DM (the workspace's home when there is none), pushed over the tabs. */
  const open = async (orgId: string) => {
    const at = await finishOnboarding(api, orgId);
    const dm = at.agentId ? await api.dms.open(orgId, { agentId: at.agentId }).catch(() => null) : null;
    forgetConfirmationSent();
    await qc.invalidateQueries({ queryKey: keys.me });
    gate.choose(orgId);
    // The conversation finds its DM in the lists for its header.
    await qc.invalidateQueries({ queryKey: keys.dms(orgId), refetchType: "all" }).catch(() => {});
    if (dm) router.push(chatHref(dm.channelId));
  };

  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(stepFailedText(t, e, i18n.language));
    } finally {
      setPending(false);
    }
  };

  const save = () =>
    run(async () => {
      let orgId = created;
      if (!orgId) {
        const res = await api.orgs.create({ name: orgName });
        orgId = res.organization.id;
        setCreated(orgId);
        await Promise.all([
          zone ? api.orgs.updateSettings(orgId, { timezone: zone }) : null,
          zone ? api.orgs.updateMe(orgId, { timezone: zone }) : null,
        ]).catch(() => undefined);
      } else {
        await api.orgs.updateSettings(orgId, { name: orgName });
      }
      if (logo) await api.orgs.setLogo(orgId, { imageBase64: logo.base64, contentType: logo.type });
      await open(orgId);
    });

  // One being set up already (an older onboarding cut short, here or on the web): finished and opened, once.
  const unfinished = created ? undefined : me.data?.organizations.find(settingUp);
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (!unfinished || opening.current === unfinished.id) return;
    opening.current = unfinished.id;
    void run(() => open(unfinished.id));
  });

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

  if (unfinished)
    return (
      <View style={[styles.screen, styles.wait, { backgroundColor: c.bg }]}>
        {error ? (
          <>
            <Text tone="muted" style={styles.waitText}>
              {error}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => {
                opening.current = null;
                setError(null);
              }}
            />
          </>
        ) : null}
      </View>
    );

  return (
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: c.bg }]} behavior="padding">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.body, { paddingTop: insets.top + 32 }]}
      >
        {/* Its right hand asks: the face the person meets again in its DM. */}
        <View style={styles.host}>
          <AgentAvatar
            agent={{ ...fullLook(RIGHT_HAND_DEFAULT.appearance), id: "right-hand" }}
            size={52}
            expression="happy"
          />
          <Text variant="body" style={styles.bold}>
            {RIGHT_HAND_DEFAULT.name}
          </Text>
        </View>
        <Text variant="display" accessibilityRole="header">
          {t("onboarding.workspace.title")}
        </Text>
        <Text variant="callout" tone="muted">
          {t("onboarding.workspace.lead")}
        </Text>
        <View style={styles.answer}>
          <Field
            value={name}
            onChangeText={setName}
            placeholder={t("onboarding.workspace.namePlaceholder")}
            label={t("onboarding.workspace.name")}
            autoFocus
            onSubmitEditing={orgName ? () => void save() : undefined}
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
        </View>
      </ScrollView>
      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {error ? (
          <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button
          variant="primary"
          wide
          label={t("onboarding.actions.continue")}
          disabled={orgName.length === 0 || pending}
          onPress={() => void save()}
        />
        {/* Until a workspace is set up this is the only screen: the way out of a workspace made by mistake is here, and
            of the account for someone with no other workspace that opens (deleting either on the website). */}
        {onLeave && !created ? (
          <Button variant="ghost" wide label={t("mobile.common.back")} disabled={pending} onPress={onLeave} />
        ) : null}
        {created ? (
          <Button
            variant="ghost"
            wide
            label={t("onboarding.deleteLink")}
            disabled={pending}
            onPress={() => openPage(`${serverUrl()}/onboarding?delete=1`)}
          />
        ) : null}
        <Button
          variant="ghost"
          wide
          label={t("mobile.org.signOut")}
          disabled={pending}
          onPress={() => void signOut()}
        />
        {me.data ? (
          <WholeAccount
            orgs={me.data.organizations}
            disabled={pending}
            onDelete={() => openPage(`${serverUrl()}/onboarding?account=delete`)}
          />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * The note that the sign-up's confirmation link went to the person's address, with a new link a tap away; gone once
 * `me` says the address is confirmed.
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
            // A 20-point line: 12 of slop around it reaches the 44-point target.
            hitSlop={12}
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
  end?: string;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  // A help line that wraps: the icon and the word on the right stay on the title's line, not the row's middle.
  const line = sub ? textLineOf("body", fontScale) : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.line,
        line ? styles.lineTall : null,
        { borderColor: c.line },
        pressed ? { backgroundColor: c.sunken } : null,
      ]}
    >
      <View style={[styles.lead, line ? leadBox(line, 18) : null]}>{lead}</View>
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
        <View style={line ? [styles.end, { minHeight: line.height }] : null}>
          <Text variant="small" style={styles.bold}>
            {end}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Note({ icon, text }: { icon: IconName; text: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.note}>
      <LineIcon name={icon} size={14} color={c.faint} variant="small" />
      <Text variant="small" tone="muted" style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wait: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  waitText: { textAlign: "center" },
  body: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 24, gap: 10 },
  host: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  answer: { gap: 12, marginTop: 12 },
  dock: { gap: 8, paddingHorizontal: 24, paddingTop: 8 },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...fieldText("body"),
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lineTall: { alignItems: "flex-start", paddingVertical: 12 },
  lead: { width: 38, alignItems: "center" },
  end: { justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  linkButton: { alignSelf: "flex-start", marginTop: 2 },
});
