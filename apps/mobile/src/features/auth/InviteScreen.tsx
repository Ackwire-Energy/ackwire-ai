import { ApiError, keys, useApi, useMe } from "@agenteschat/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { agentLook } from "@/features/shared/logic";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { AgentAvatar, Button, Text, useTheme } from "@/ui";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { forgetInvite, rememberInvite } from "./invite";

/**
 * An invitation's link opened in the app (telas/OnboardingMobile.html, 5 · Convite): who invited, the org, the
 * role and who already works there; the e-mail locked. Signed out: Apple, a password, or "Já tenho conta"
 * (the invitation waits and is accepted once the person is in). Signed in: one tap to join. Expired:
 * "Pedir um novo convite" (the person who invited gets the request at once).
 */
export function InviteScreen({ token }: { token: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const gate = useOrgGate();
  const me = useMe();
  const { colors: c } = useTheme();
  const apple = useSocialProviders(["apple"]);
  const preview = useQuery({
    queryKey: keys.invitation(token),
    queryFn: () => api.orgs.previewInvitation(token),
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [asked, setAsked] = useState(false);

  if (preview.isPending) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <ActivityIndicator color={c.muted} />
      </View>
    );
  }

  const invitation = preview.data;
  if (!invitation) {
    return (
      <AuthScaffold title={t("invite.expiredTitle")} subtitle={t("invite.expiredText")} expression="closed">
        <Button
          variant="primary"
          wide
          label={asked ? t("invite.askedNew") : t("invite.askNew")}
          disabled={asked}
          onPress={() =>
            void api.invites
              .requestNew(token)
              .catch(() => undefined)
              .finally(() => setAsked(true))
          }
        />
        <Button
          variant="ghost"
          wide
          label={t("mobile.invite.otherAccount")}
          onPress={() => router.replace(session.signedIn ? "/" : "/sign-in")}
        />
      </AuthScaffold>
    );
  }

  const org = invitation.orgName;
  const title = invitation.invitedBy
    ? t("mobile.invite.invitedBy", { name: invitation.invitedBy.split(/\s+/)[0], org })
    : t("mobile.invite.invited", { org });
  const role = t(`roles.${invitation.role}Lower`);
  const agents = invitation.agents ?? [];
  const user = me.data?.user;
  const byEmail = invitation.email !== "";
  const matches = !byEmail || (user ? user.email.toLowerCase() === invitation.email.toLowerCase() : false);

  const join = async () => {
    setJoining(true);
    setError(null);
    try {
      const { orgId } = await api.orgs.acceptInvitation(token);
      forgetInvite();
      await qc.invalidateQueries({ queryKey: keys.me });
      gate.choose(orgId);
      router.replace("/");
    } catch (e) {
      const wrong = e instanceof ApiError && e.status === 403;
      setError(wrong ? t("mobile.invite.wrongAccount", { email: invitation.email }) : t("mobile.invite.failed"));
    } finally {
      setJoining(false);
    }
  };

  /** Signed out: the invitation waits, then the chosen way in. */
  const signUpWith = (path: "/sign-up" | "/sign-in") => {
    rememberInvite(token);
    router.push({ pathname: path, params: byEmail ? { email: invitation.email } : {} });
  };

  return (
    <AuthScaffold title={title} subtitle={t("mobile.invite.joinAs", { role })}>
      {agents.length > 0 ? (
        <View style={styles.who}>
          <View style={styles.faces}>
            {agents.map((a, i) => (
              <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
                <AgentAvatar agent={{ ...agentLook(a), id: a.id }} size={30} live={false} />
              </View>
            ))}
          </View>
          <Text variant="small" tone="muted" style={styles.grow}>
            {t("mobile.invite.agentsThere", { count: agents.length, names: agents.map((a) => a.name).join(", ") })}
          </Text>
        </View>
      ) : null}
      {byEmail ? (
        <View style={[styles.locked, { backgroundColor: c.sunken }]}>
          <Text variant="body" numberOfLines={1} style={styles.grow}>
            {invitation.email}
          </Text>
          <Text variant="small" tone="muted">
            {t("mobile.invite.onlyEmail")}
          </Text>
        </View>
      ) : (
        <Text variant="small" tone="muted">
          {t("mobile.invite.link", { role })}
        </Text>
      )}
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {session.signedIn ? (
        matches ? (
          <Button
            variant="primary"
            wide
            label={t("mobile.invite.accept", { org })}
            disabled={joining}
            onPress={() => void join()}
          />
        ) : (
          <>
            <Text variant="small" tone="muted">
              {t("mobile.invite.wrongAccount", { email: invitation.email })}
            </Text>
            <Button
              variant="secondary"
              wide
              label={t("mobile.invite.otherAccount")}
              onPress={() => {
                rememberInvite(token);
                void signOut();
              }}
            />
          </>
        )
      ) : (
        <>
          {apple.length > 0 ? (
            <View onTouchStart={() => rememberInvite(token)}>
              <SocialButtons providers={apple} divider={false} onError={setError} />
            </View>
          ) : null}
          <Button
            variant={apple.length > 0 ? "secondary" : "primary"}
            wide
            label={t("mobile.invite.createPassword")}
            onPress={() => signUpWith("/sign-up")}
          />
          <Button variant="ghost" wide label={t("mobile.invite.haveAccount")} onPress={() => signUpWith("/sign-in")} />
        </>
      )}
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -8 },
  grow: { flex: 1, minWidth: 0 },
  locked: { gap: 2, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
});
