import { addDm, keys, useApi, useMe } from "@agenteschat/client";
import { settingUp } from "@agenteschat/client/lib/guards";
import { createWorkspace, finishOnboarding, type OpenedAt } from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { authClient } from "@/lib/auth";
import { useOrgGate } from "@/providers/org";
import { Button, LineIcon, Locked, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { confirmationSentTo, forgetConfirmationSent } from "../auth/confirmation";
import { chatHref } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { ZoneList } from "../me/AccountPage";
import { chooseAction } from "../settings/parts";
import { orgNameFromEmail, phoneTimezone, stepFailedText, zoneLabel } from "./logic";

/**
 * The first run on the phone, signed in with no workspace to open yet: one question on the sign-in's own screen, the
 * workspace's name (its time zone from the phone, said in one line; its logo later, in Configurações), the keyboard's
 * return key as the action; then the right hand's DM, where the rest of the setup happens (ADR 0137), as on the web.
 * A workspace still being set up (an older onboarding left at any step, here or on the web) is finished and opened
 * there, never a second one. Nothing destructive lives here: leaving the account is a quiet line, deleting it stays
 * on the website. `onLeave`: opened over a workspace being deleted, or from Adicionar workspace (ADR 0154), it goes
 * back until a new one is made; `another`: the name of the workspace the person is still in meanwhile.
 */
export function OnboardingFlow({ onLeave, another }: { onLeave?: () => void; another?: string | null } = {}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const me = useMe();
  const { colors: c } = useTheme();
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The phone's zone, said in one line with Trocar beside it; the person may pick another before the workspace exists.
  const [zone, setZone] = useState<string | null>(phoneTimezone);
  const [pickingZone, setPickingZone] = useState(false);
  const orgName = name.trim();
  // A work address names its company: the field starts with it, selected, so typing replaces it (`suggested`).
  const [suggested, setSuggested] = useState<string | null>(null);

  // The address this sign-up was emailed a link to confirm (features/auth/confirmation.ts): the step says where it
  // went, until `me` says it's confirmed.
  const email = me.data?.user.email ?? "";
  useEffect(() => {
    if (another || created || name !== "" || suggested !== null || !email) return;
    const guess = orgNameFromEmail(email);
    setSuggested(guess ?? "");
    if (guess) setName(guess);
  }, [another, created, name, suggested, email]);
  const unconfirmed =
    email !== "" && confirmationSentTo() === email.toLowerCase() && me.data?.user.emailVerified !== true;

  /**
   * Opens a workspace whose onboarding just ended in its right hand's DM (the workspace's home when there is none),
   * pushed over the tabs; `/me` from the answer that finished it, so nothing is asked again.
   */
  const open = async ({ orgId, agentId, me: now }: OpenedAt) => {
    const dm = agentId ? await api.dms.open(orgId, { agentId }).catch(() => null) : null;
    forgetConfirmationSent();
    if (now) qc.setQueryData(keys.me, now);
    else await qc.invalidateQueries({ queryKey: keys.me });
    gate.choose(orgId);
    // The conversation finds its DM in the lists for its header, from the open's own answer.
    if (dm?.dm) addDm(qc, orgId, dm.dm);
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

  // One call makes it with its zone (the owner's too), finished, and says where it opens.
  const save = () =>
    run(async () => {
      if (created) {
        await api.orgs.updateSettings(created, { name: orgName });
        return open(await finishOnboarding(api, created));
      }
      const at = await createWorkspace(api, {
        name: orgName,
        ...(zone ? { timezone: zone, memberTimezone: zone } : {}),
      });
      setCreated(at.orgId);
      await open(at);
    });

  // One being set up already (an older onboarding cut short, here or on the web): finished and opened, once.
  const unfinished = created ? undefined : me.data?.organizations.find(settingUp);
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (!unfinished || opening.current === unfinished.id) return;
    opening.current = unfinished.id;
    void run(async () => open(await finishOnboarding(api, unfinished.id)));
  });

  if (unfinished)
    return (
      <View style={[styles.screen, styles.wait, { backgroundColor: c.bg }]}>
        {error ? (
          <>
            <Text tone="muted" style={CENTER}>
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

  const submit = () => {
    if (orgName && !pending) void save();
  };

  return (
    <AuthScaffold
      sky="low"
      title={another ? t("mobile.onb.anotherTitle") : t("onboarding.workspace.title")}
      subtitle={
        another
          ? t("mobile.onb.anotherLead", { org: another })
          : suggested && name === suggested
            ? t("mobile.onb.suggested", { domain: email.split("@")[1] ?? "", org: suggested })
            : t("onboarding.workspace.lead")
      }
      onBack={onLeave && !created ? onLeave : undefined}
      agentMode={pending ? "run" : "idle"}
      // Nothing destroys on screen: until a workspace is set up this is the only screen, so the way out of the account
      // is one quiet "Sair", which offers Sair and, in red, Apagar conta in the system's list (a person must always
      // reach deleting their account, App Store 5.1.1(v); the web's first run takes it from there).
      footer={
        pending ? null : (
          <AuthLink
            label={t("mobile.org.signOut")}
            onPress={() =>
              chooseAction(
                email,
                [
                  { label: t("mobile.org.signOut"), onPress: () => void signOut() },
                  {
                    label: t("deleteAccount.menu"),
                    destructive: true,
                    onPress: () => openWebPath("/onboarding?account=delete"),
                  },
                ],
                t("mobile.common.cancel"),
              )
            }
          />
        )
      }
    >
      <Locked when={pending} keepKeyboard style={{ gap: 8 }}>
        <AuthField
          // Mounted again once the suggestion lands, so its focus selects it (`selectTextOnFocus`).
          key={suggested ? "suggested" : "empty"}
          value={name}
          onChangeText={(value) => {
            setName(value);
            setError(null);
          }}
          placeholder={t("onboarding.workspace.namePlaceholder")}
          accessibilityLabel={t("onboarding.workspace.name")}
          autoCapitalize="words"
          autoCorrect={false}
          // The keyboard's blue key is the action ("continuar"); gray until a name is typed.
          returnKeyType="go"
          enablesReturnKeyAutomatically
          onSubmitEditing={submit}
          // The suggested name comes selected: one keystroke replaces it, the blue key keeps it.
          selectTextOnFocus={Boolean(suggested)}
          autoFocus
        />
      </Locked>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}
      {/* The keyboard's blue key is the only action, as on the sign-in; the agent above works while it saves. */}
      {zone ? (
        <Pressable
          onPress={() => setPickingZone(true)}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel={`${t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })}. ${t("mobile.onb.zoneChange")}`}
          hitSlop={12}
          style={({ pressed }) => [styles.zone, pressed && styles.pressed]}
        >
          <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.shrink}>
            {`${t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })} · `}
          </Text>
          <Text variant="footnote" tone="ink2" style={styles.bold}>
            {t("mobile.onb.zoneChange")}
          </Text>
        </Pressable>
      ) : null}
      {/* Outside the navigator (this screen covers it), so the list comes in a sheet of its own. */}
      <Modal
        visible={pickingZone}
        animationType="slide"
        presentationStyle="pageSheet"
        supportedOrientations={["portrait", "landscape"]}
        onRequestClose={() => setPickingZone(false)}
      >
        <ZoneList
          title={t("mobile.onb.zoneTitle")}
          value={zone}
          onClose={() => setPickingZone(false)}
          onPick={(picked) => {
            if (picked) setZone(picked);
            setPickingZone(false);
          }}
        />
      </Modal>
      {unconfirmed ? <ConfirmationNote email={email} /> : null}
    </AuthScaffold>
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
      <LineIcon name="mail" size={15} color={c.faint} variant="small" />
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
            style={({ pressed }) => [styles.linkButton, pressed ? styles.pressed : null]}
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wait: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 8 },
  zone: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingTop: 8, maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  linkButton: { alignSelf: "flex-start", marginTop: 2 },
  pressed: { opacity: 0.6 },
});
