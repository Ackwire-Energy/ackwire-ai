import { useAccountDeletionPlan, useApi, useMe } from "@agenteschat/client";
import { proofNeeded } from "@agenteschat/client/lib/deletion";
import { REAUTH_PASSWORD, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { deleteAccount } from "@/features/account";
import { serverUrl } from "@/lib/server";
import { Button, Card, HoldButton, Icon, Text, useToast } from "@/ui";
import { PasswordField } from "@/ui/auth/PasswordField";
import { SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { openPage } from "../ai/parts";
import { useColors } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";

/**
 * Apagar conta (App Store 5.1.1(v)): what goes and what stays, then a hold. A workspace that still needs this person
 * as its only owner comes first, with its two ways out on the website (People, or deleting it). Then the proof that
 * it's them, unless this session signed in lately: the password, or signing in again with the account's provider
 * (Apple's included).
 */
export function DeleteAccountScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const plan = useAccountDeletionPlan();
  const me = useMe().data;
  // The account this screen is about: signing in again to another one deletes nothing.
  const account = useRef(me?.user.id);
  account.current ??= me?.user.id;
  const providers = useSocialProviders();
  const [password, setPassword] = useState("");
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needs = plan.data ? proofNeeded(plan.data, refused) : null;
  const blockers = plan.data?.soleOwner ?? [];
  const ready = needs === "none" || (needs === "password" && password !== "");
  const web = (path: string) => openPage(`${serverUrl()}${path}`);

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
    else if (result.reason === "sole_owner") void plan.refetch();
    else if (result.reason === "reauth") {
      setRefused(result.proof === "password" ? REAUTH_PASSWORD : REAUTH_SIGN_IN);
      setPassword("");
    } else
      toast({
        title: t(result.reason === "rate_limited" ? "common.tooMany" : "mobile.account.deleteFailed"),
        icon: "x",
      });
  };

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
            {(["account", "orgs", "phones"] as const).map((k) => (
              <View key={k} style={styles.item}>
                <Icon name="x" size={16} color={c.muted} />
                <Text variant="small" tone="ink2" style={styles.grow}>
                  {t(`mobile.delete.goes.${k}`)}
                </Text>
              </View>
            ))}
            <View style={styles.item}>
              <Icon name="chat" size={16} color={c.muted} />
              <Text variant="small" tone="ink2" style={styles.grow}>
                {t("mobile.delete.stays")}
              </Text>
            </View>
          </View>
        </Card>
        {plan.isError ? (
          <Button variant="secondary" label={t("mobile.common.retry")} onPress={() => void plan.refetch()} />
        ) : !plan.data ? (
          <ActivityIndicator color={c.muted} />
        ) : blockers.length > 0 ? (
          <Card>
            <View style={styles.list}>
              <Text variant="title">{t("deleteAccount.blockers")}</Text>
              {blockers.map((o) => (
                <View key={o.id} style={styles.blocker}>
                  <Text variant="small" tone="ink2">
                    {t("deleteAccount.soleOwner", { name: o.name })}
                  </Text>
                  <View style={styles.acts}>
                    <Button
                      variant="secondary"
                      size="sm"
                      label={t("deleteAccount.openPeople")}
                      onPress={() => web(`/org/${o.id}/settings/members`)}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      label={t("deleteAccount.deleteOrg", { name: o.name })}
                      onPress={() => web(`/org/${o.id}/settings/general?delete=1`)}
                    />
                  </View>
                </View>
              ))}
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
            {needs === "signIn" ? (
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
  item: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1 },
  blocker: { gap: 8 },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  proof: { gap: 10 },
});
