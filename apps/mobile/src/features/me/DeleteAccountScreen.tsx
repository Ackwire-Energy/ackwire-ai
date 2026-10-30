import { useAccountDeletionPlan, useApi, useAuthConfig, useMe } from "@agenteschat/client";
import {
  type AccountDeletionLine,
  accountDeletionLines,
  proofNeeded,
  soleOwnerWaysOut,
} from "@agenteschat/client/lib/deletion";
import { REAUTH_PASSWORD, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { settingUp } from "@agenteschat/client/lib/guards";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { deleteAccount } from "@/features/account";
import { serverUrl } from "@/lib/server";
import { Button, Card, HoldButton, Icon, type IconName, Text, useToast } from "@/ui";
import { PasswordField } from "@/ui/auth/PasswordField";
import { SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { openPage } from "../ai/parts";
import { useColors } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { preflightMissing } from "./logic";

const LINE_ICON: Record<AccountDeletionLine["kind"], IconName> = {
  closes: "x",
  leaves: "out",
  computers: "laptop",
  staysBehind: "lock",
  messages: "chat",
  serverOwner: "server",
};

/**
 * Apagar conta (App Store 5.1.1(v)): what goes and what stays, from the preflight (what closes, what they leave, the
 * computers removed, what stays behind with where to disconnect it on the website), then a hold. A workspace that
 * still needs this person as its only owner comes first, with its two ways out on the website (People, or deleting
 * it; its onboarding, while it's still being set up). Then the proof that it's them, unless this session signed in
 * lately: the password, or signing in again with a provider the server offers (Apple's included); with neither, the
 * website adds a password first. A server from before the preflight gets the fixed lines and the hold, as it always
 * did.
 */
export function DeleteAccountScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const plan = useAccountDeletionPlan();
  const me = useMe().data;
  const config = useAuthConfig().data;
  // The account this screen is about: signing in again to another one deletes nothing.
  const account = useRef(me?.user.id);
  account.current ??= me?.user.id;
  const providers = useSocialProviders();
  const [password, setPassword] = useState("");
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  // An older server's own refusal: the workspaces it names.
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const legacy = plan.isError && preflightMissing(plan.error);
  const needs = legacy ? "none" : plan.data ? proofNeeded(plan.data, refused) : null;
  const blockers = plan.data?.soleOwner ?? [];
  const ready = needs === "none" || (needs === "password" && password !== "");
  const web = (path: string) => openPage(`${serverUrl()}${path}`);
  const lines = plan.data
    ? accountDeletionLines(t, i18n.language, plan.data, { cloud: config?.workspaceComputer === true })
    : [];
  const inSetup = (id: string) => me?.organizations.some((o) => o.id === id && settingUp(o)) === true;
  // Where the website's account menu adds a password: a workspace of theirs that is open.
  const shell = me?.organizations.find((o) => !o.deletion && o.standing?.state !== "suspended" && !settingUp(o));

  const confirm = async () => {
    if (busy || !ready) return;
    setBusy(true);
    const now = await api.account.me().catch(() => null);
    if (now && now.user.id !== account.current) {
      setBusy(false);
      toast({ title: t("mobile.delete.otherAccount"), icon: "x" });
      return;
    }
    const result = await deleteAccount(needs === "password" ? password : undefined);
    setBusy(false);
    // Deleted: the session ends and the gate shows sign-in.
    if (result.ok) toast({ title: t("mobile.account.deleted") });
    else if (result.reason === "sole_owner") {
      if (legacy) setBlockedBy(result.organizations);
      else void plan.refetch();
    } else if (result.reason === "reauth") {
      setRefused(result.proof === "password" ? REAUTH_PASSWORD : REAUTH_SIGN_IN);
      setPassword("");
    } else
      toast({
        title: t(result.reason === "rate_limited" ? "common.tooMany" : "mobile.account.deleteFailed"),
        icon: "x",
      });
  };

  const line = (key: string, icon: IconName, text: string, links?: AccountDeletionLine["links"]) => (
    <View key={key} style={styles.line}>
      <View style={styles.item}>
        <Icon name={icon} size={16} color={c.muted} />
        <Text variant="small" tone="ink2" style={styles.grow}>
          {text}
        </Text>
      </View>
      {links?.length ? (
        <View style={styles.acts}>
          {links.map((l) => (
            <Button
              key={l.label}
              variant="secondary"
              size="sm"
              label={l.label}
              onPress={() => web(`/org/${l.orgId}/settings/${l.section}`)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={t("mobile.me.deleteAccount")} solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <Text variant="display">{t("mobile.delete.title")}</Text>
        <Text variant="body" tone="muted">
          {t("mobile.delete.intro")}
        </Text>
        <Card>
          <View style={styles.list}>
            {line("account", "x", t("mobile.delete.goes.account"))}
            {legacy ? (
              <>
                {line("orgs", "x", t("mobile.delete.goes.orgs"))}
                {line("stays", "chat", t("mobile.delete.stays"))}
              </>
            ) : (
              lines.map((l) => line(`${l.kind}:${l.text}`, LINE_ICON[l.kind], l.text, l.links))
            )}
            {line("phones", "x", t("mobile.delete.goes.phones"))}
          </View>
        </Card>
        {plan.isError && !legacy ? (
          <Button variant="secondary" label={t("mobile.common.retry")} onPress={() => void plan.refetch()} />
        ) : !plan.data && !legacy ? (
          <ActivityIndicator color={c.muted} />
        ) : blockers.length > 0 || blockedBy.length > 0 ? (
          <Card>
            <View style={styles.list}>
              <Text variant="title">{t("deleteAccount.blockers")}</Text>
              {blockers.map((o) => {
                const setup = inSetup(o.id);
                const out = soleOwnerWaysOut(o.id, setup);
                return (
                  <View key={o.id} style={styles.line}>
                    <Text variant="small" tone="ink2">
                      {t(setup ? "deleteAccount.soleOwnerSettingUp" : "deleteAccount.soleOwner", { name: o.name })}
                    </Text>
                    <View style={styles.acts}>
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t(setup ? "deleteAccount.finishSetup" : "deleteAccount.openPeople")}
                        onPress={() => web(out.people)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t("deleteAccount.deleteOrg", { name: o.name })}
                        onPress={() => web(out.delete)}
                      />
                    </View>
                  </View>
                );
              })}
              {blockedBy.length > 0 ? (
                <Text variant="small" tone="ink2">
                  {t("mobile.delete.blocked", { names: joinNames(blockedBy, t("newAgent.and")) })}
                </Text>
              ) : null}
            </View>
          </Card>
        ) : (
          <>
            {needs === "password" ? (
              <View style={styles.proof}>
                <PasswordField label={t("proof.password")} value={password} onChangeText={setPassword} />
                {refused === REAUTH_PASSWORD ? (
                  <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
                    {t("errors.reauth.password")}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {needs === "signIn" && providers.length > 0 ? (
              <View style={styles.proof}>
                <Text variant="body" tone="ink2">
                  {t("errors.reauth.signIn")}
                </Text>
                <SocialButtons
                  providers={providers}
                  divider={false}
                  callbackURL="/account-delete"
                  onError={(message) => toast({ title: message, icon: "x" })}
                  onSignedIn={() => {
                    setRefused(undefined);
                    void plan.refetch();
                  }}
                />
              </View>
            ) : null}
            {needs === "signIn" && providers.length === 0 ? (
              <View style={styles.proof}>
                <Text variant="body" tone="ink2">
                  {t("mobile.delete.addPasswordFirst")}
                </Text>
                <Button
                  variant="secondary"
                  label={t("mobile.delete.addPasswordWeb")}
                  onPress={() => web(shell ? `/org/${shell.id}?account=password` : "/")}
                />
                <Button variant="ghost" label={t("mobile.common.retry")} onPress={() => void plan.refetch()} />
              </View>
            ) : null}
            <HoldButton
              label={t("mobile.delete.hold")}
              holdLabel={t("mobile.delete.holding")}
              disabled={!ready || busy}
              onConfirm={() => void confirm()}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 20, paddingTop: 8, gap: 16 },
  list: { padding: 14, gap: 10 },
  line: { gap: 8 },
  item: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1 },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  proof: { gap: 10 },
});
