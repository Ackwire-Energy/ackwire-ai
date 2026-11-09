import { keys, useApi, useMe, type WorkspaceMode } from "@agenteschat/client";
import { settingUp } from "@agenteschat/client/lib/guards";
import { finishOnboarding } from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { authClient } from "@/lib/auth";
import { useOrgGate } from "@/providers/org";
import { Button, LineIcon, Locked, OptionTile, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { confirmationSentTo, forgetConfirmationSent } from "../auth/confirmation";
import { chatHref } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { ZoneList } from "../me/AccountPage";
import { chooseAction } from "../settings/parts";
import { orgNameFromEmail, PURPOSES, phoneTimezone, stepFailedText, workspaceAnswer, zoneLabel } from "./logic";

/**
 * The first run on the phone, signed in with no workspace to open yet, on the sign-in's own screen: what the workspace
 * is for (ADR 0159), two choices and Continue; "For me" makes a personal workspace at once, named in the person's
 * language with the phone's time zone. A company or team then names it (its time zone from the phone, said in one
 * line; its logo later, in Settings), the keyboard's return key as the action. Then the right hand's DM, where the rest
 * of the setup happens (ADR 0137), as on the web. A workspace still being set up (an older onboarding left at any
 * step, here or on the web) is finished and opened there, never a second one. Nothing destructive lives here: leaving
 * the account is a quiet line, deleting it stays on the website. `onLeave`: opened over a workspace being deleted, or
 * from Add workspace (ADR 0154), which asks the same question, it goes back until a new one is made; `another`: the
 * name of the workspace the person is still in meanwhile.
 */
export function OnboardingFlow({ onLeave, another }: { onLeave?: () => void; another?: string | null } = {}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const me = useMe();
  const { colors: c } = useTheme();
  const [created, setCreated] = useState<string | null>(null);
  // Who it is for, then, for a team, its name: one question at a time.
  const [purpose, setPurpose] = useState<WorkspaceMode | null>(null);
  const [step, setStep] = useState<"purpose" | "name">("purpose");
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
      // "For me" asks no name: the word for it in the person's language; a company or team, the name typed.
      const answer = workspaceAnswer(t, purpose ?? "team", orgName);
      let orgId = created;
      if (!orgId) {
        const res = await api.orgs.create(answer);
        orgId = res.organization.id;
        setCreated(orgId);
        await Promise.all([
          zone ? api.orgs.updateSettings(orgId, { timezone: zone }) : null,
          zone ? api.orgs.updateMe(orgId, { timezone: zone }) : null,
        ]).catch(() => undefined);
      } else {
        // Made here already (a step after it failed): the answer as it is now, the mode included.
        await api.orgs.updateSettings(orgId, answer);
      }
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
  // Continue on the first question: "For me" makes the workspace now; a company or team names it first.
  const next = () => {
    if (!purpose || pending) return;
    if (purpose === "team") setStep("name");
    else void save();
  };
  const naming = step === "name";

  return (
    <AuthScaffold
      sky="low"
      stepKey={step}
      title={
        naming
          ? another
            ? t("mobile.onb.anotherTitle")
            : t("onboarding.workspace.title")
          : another
            ? t("mobile.onb.anotherPurpose")
            : t("onboarding.purpose.title")
      }
      subtitle={
        another
          ? t("mobile.onb.anotherLead", { org: another })
          : !naming
            ? t("onboarding.purpose.lead")
            : suggested && name === suggested
              ? t("mobile.onb.suggested", { domain: email.split("@")[1] ?? "", org: suggested })
              : t("onboarding.workspace.lead")
      }
      onBack={
        naming
          ? () => {
              if (!pending) setStep("purpose");
            }
          : onLeave && !created
            ? onLeave
            : undefined
      }
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
      {naming ? (
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
      ) : (
        // The first question (ADR 0159): two raised choices, the picked one sunk with its check, then Continue.
        <Locked when={pending} style={styles.purposes}>
          {PURPOSES.map((mode) => {
            const on = purpose === mode;
            const title = t(`onboarding.purpose.${mode}`);
            const text = t(`onboarding.purpose.${mode}Text`);
            return (
              <OptionTile
                key={mode}
                pressed={on}
                label={`${title}. ${text}`}
                onPress={() => {
                  setPurpose(mode);
                  setError(null);
                }}
              >
                <View style={styles.tile}>
                  <LineIcon
                    name={mode === "personal" ? "person" : "members"}
                    size={20}
                    color={c.ink2}
                    variant="subhead"
                  />
                  <View style={[styles.grow, on && styles.room]}>
                    <Text variant="subhead" tone="ink" style={styles.bold}>
                      {title}
                    </Text>
                    <Text variant="small" tone="muted">
                      {text}
                    </Text>
                  </View>
                </View>
              </OptionTile>
            );
          })}
          <Button
            variant="primary"
            wide
            label={t("onboarding.actions.continue")}
            loading={pending}
            disabled={!purpose}
            onPress={next}
          />
        </Locked>
      )}
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}
      {/* Naming it, the keyboard's blue key is the only action, as on the sign-in; the agent above works while it
          saves. "For me" uses the phone's zone without a word (changed in Settings like any other). */}
      {naming && zone ? (
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
  // The first question's choices, 8 apart, Continue under them on the same rhythm.
  purposes: { gap: 8 },
  // A choice's icon on its title's line, the words beside it.
  tile: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  // Room for the check in the chosen tile's corner.
  room: { paddingRight: 22 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 8 },
  zone: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingTop: 8, maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  linkButton: { alignSelf: "flex-start", marginTop: 2 },
  pressed: { opacity: 0.6 },
});
