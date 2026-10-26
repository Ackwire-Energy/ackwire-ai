import {
  ApiError,
  type AskToJoinResult,
  type InvitationPreview,
  keys,
  useApi,
  useAuthConfig,
  useMe,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { ANSWER_POLL_MS, askView, JOIN_NAME_MAX, JOIN_NOTE_MAX } from "@agenteschat/client/lib/join-requests";
import { emailTypoFix, isEmail } from "@agenteschat/client/lib/text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { agentLook, joinNames } from "@/features/shared/logic";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { AgentAvatar, Button, haptics, LineIcon, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { forgetInvite, rememberInvite } from "./invite";

/**
 * An invitation's link opened in the app: who invited, the org, the
 * role and who already works there; the e-mail locked. Signed out: Apple, a password, or "Já tenho conta"
 * (the invitation waits and is accepted once the person is in). Signed in: one tap to join. Expired:
 * "Pedir um novo convite" (the person who invited gets the request at once). A workspace's invitation link only
 * lets people ask to join (`AskToJoin`).
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

  if (preview.isPending || (session.signedIn && me.isPending)) {
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
        <LeaveButton />
      </AuthScaffold>
    );
  }
  if (invitation.kind === "link") return <AskToJoin token={token} preview={invitation} />;

  const org = invitation.orgName;
  const title = invitation.invitedBy
    ? t("mobile.invite.invitedBy", { name: invitation.invitedBy.split(/\s+/)[0], org })
    : t("mobile.invite.invited", { org });
  const role = t(`roles.${invitation.role}Lower`);
  const user = me.data?.user;
  const matches = user ? user.email.toLowerCase() === invitation.email.toLowerCase() : false;

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
    rememberInvite(token, "email");
    router.push({ pathname: path, params: { email: invitation.email } });
  };

  return (
    <AuthScaffold title={title} subtitle={t("mobile.invite.joinAs", { role })}>
      <AgentsThere agents={invitation.agents ?? []} />
      <View style={[styles.locked, { backgroundColor: c.sunken }]}>
        <Text variant="body" numberOfLines={1} style={styles.grow}>
          {invitation.email}
        </Text>
        <Text variant="small" tone="muted" style={CENTER}>
          {t("mobile.invite.onlyEmail")}
        </Text>
      </View>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
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
            <Text variant="small" tone="muted" style={CENTER}>
              {t("mobile.invite.wrongAccount", { email: invitation.email })}
            </Text>
            <Button
              variant="secondary"
              wide
              label={t("mobile.invite.otherAccount")}
              onPress={() => {
                rememberInvite(token, "email");
                void signOut();
              }}
            />
          </>
        )
      ) : (
        <>
          {apple.length > 0 ? (
            <View onTouchStart={() => rememberInvite(token, "email")}>
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

/** Leaves an invitation that leads nowhere: home when signed in, else the sign-in. */
function LeaveButton() {
  const { t } = useTranslation();
  const session = useSession();
  return (
    <Button
      variant="ghost"
      wide
      label={t("mobile.invite.otherAccount")}
      onPress={() => router.replace(session.signedIn ? "/" : "/sign-in")}
    />
  );
}

/** The faces leading "who already works there": as tall as that line, so they sit on it. */
const FACE = 22;

/** "Ada, Theo e Lia já trabalham lá", their faces leading the first line. */
function AgentsThere({ agents }: { agents: NonNullable<InvitationPreview["agents"]> }) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  return (
    <View style={styles.lead}>
      <LineIcon variant="small" size={FACE}>
        <View style={styles.faces}>
          {agents.map((a, i) => (
            <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
              <AgentAvatar agent={{ ...agentLook(a), id: a.id }} size={FACE} live={false} />
            </View>
          ))}
        </View>
      </LineIcon>
      <Text variant="small" tone="muted" style={styles.grow}>
        {t("mobile.invite.agentsThere", {
          count: agents.length,
          names: joinNames(
            agents.map((a) => a.name),
            t("newAgent.and"),
          ),
        })}
      </Text>
    </View>
  );
}

/**
 * A workspace's invitation link (ADR 0068): whoever opens it asks, and an admin of the workspace approves each
 * person. Signed out they type a name and an email, and no account is made: the answer comes by email. Signed in
 * their account asks, and the screen checks for the answer while it is open. The same states as the web's page
 * (`askView`).
 */
function AskToJoin({ token, preview }: { token: string; preview: InvitationPreview }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const gate = useOrgGate();
  const me = useMe();
  const config = useAuthConfig();
  const user = session.signedIn ? (me.data?.user ?? null) : null;
  const [sent, setSent] = useState<AskToJoinResult | null>(null);
  const view = askView(preview, sent !== null);
  useQuery({
    queryKey: keys.invitation(token),
    queryFn: () => api.orgs.previewInvitation(token),
    retry: false,
    refetchInterval: user && (view.state === "sent" || view.state === "approvedEmail") ? ANSWER_POLL_MS : false,
  });
  // Let in by an approval: the account's workspaces are fetched again at once, since the root shows the first run to
  // an account with none, and leaving by Back (not "Open {org}") would otherwise lead there.
  const joined = view.state === "in" && !view.already;
  useEffect(() => {
    if (joined) void qc.invalidateQueries({ queryKey: keys.me });
  }, [joined, qc]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const emailField = useRef<ComponentRef<typeof AuthField>>(null);

  const org = preview.orgName;
  const address = sent?.email ?? preview.you?.email ?? user?.email ?? "";
  const emailsGoOut = sent?.emailed ?? config.data?.passwordReset ?? true;
  const fix = user ? null : emailTypoFix(email);
  const ready = user !== null || (name.trim() !== "" && isEmail(email));
  const refresh = () => qc.invalidateQueries({ queryKey: keys.invitation(token) });

  const ask = async () => {
    if (!ready || asking) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.invites.ask(token, {
        ...(user ? {} : { name: name.trim(), email: email.trim() }),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      haptics.success();
      setSent(result);
      if (user) await refresh();
    } catch (e) {
      haptics.warning();
      setError(
        e instanceof ApiError
          ? (knownErrorText(t, e) ?? t("mobile.auth.errors.generic"))
          : t("mobile.auth.errors.network"),
      );
      // A link turned off, or an answer already given, then shows as its own state.
      void refresh();
    } finally {
      setAsking(false);
    }
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace(session.signedIn ? "/" : "/sign-in");
  };

  let title: string;
  let subtitle: string | undefined;
  let expression: "happy" | "closed" | undefined;
  let body: ReactNode = null;
  switch (view.state) {
    case "closed":
      title = t("invite.ask.closedTitle");
      subtitle = t("invite.ask.closedText");
      expression = "closed";
      body = <LeaveButton />;
      break;
    case "in": {
      const orgId = view.orgId;
      title = view.already ? t("invite.ask.memberTitle", { org }) : t("invite.ask.inTitle", { org });
      expression = "happy";
      body = orgId ? (
        <Button
          variant="primary"
          wide
          label={t("invite.ask.open", { org })}
          onPress={() =>
            void qc.invalidateQueries({ queryKey: keys.me }).then(() => {
              gate.choose(orgId);
              router.replace("/");
            })
          }
        />
      ) : null;
      break;
    }
    case "approvedEmail":
      title = t("invite.ask.approvedTitle");
      subtitle = emailsGoOut ? t("invite.ask.approvedEmail", { email: address }) : t("invite.ask.approvedNoEmail");
      expression = "happy";
      break;
    case "denied":
      title = t("invite.ask.deniedTitle");
      expression = "closed";
      if (view.reason)
        body = (
          <>
            <Said text={t("invite.ask.reason", { reason: view.reason })} />
            <Text variant="callout" tone="muted" style={CENTER}>
              {t("invite.ask.deniedText", { org })}
            </Text>
          </>
        );
      else subtitle = t("invite.ask.deniedText", { org });
      break;
    case "sent":
      title = t("invite.ask.sentTitle");
      subtitle = user?.emailVerified
        ? t("invite.ask.sentAccount", { org })
        : emailsGoOut
          ? t("invite.ask.sentEmail", { org, email: address })
          : t("invite.ask.sentNoEmail", { org });
      expression = "happy";
      body = (
        <Text variant="small" tone="muted" style={CENTER}>
          {t("mobile.invite.sentLeave")}
        </Text>
      );
      break;
    case "form":
      title = t("invite.ask.title", { org });
      subtitle = preview.invitedBy
        ? t("invite.ask.lead", { name: preview.invitedBy.split(/\s+/)[0], org })
        : t("invite.ask.leadNoName", { org });
      body = (
        <>
          <AgentsThere agents={preview.agents ?? []} />
          {user ? (
            <View style={styles.as}>
              <Text variant="subhead" tone="muted">
                {t("invite.ask.as", { email: user.email })}
              </Text>
              <Pressable onPress={() => void signOut()} accessibilityRole="link" hitSlop={8}>
                <Text variant="subhead" style={styles.link}>
                  {t("invite.ask.notYou")}
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <AuthField
                value={name}
                onChangeText={setName}
                placeholder={t("invite.ask.name")}
                accessibilityLabel={t("invite.ask.name")}
                maxLength={JOIN_NAME_MAX}
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                returnKeyType="next"
                onSubmitEditing={() => emailField.current?.focus()}
              />
              <View style={styles.field}>
                <AuthField
                  ref={emailField}
                  value={email}
                  onChangeText={setEmail}
                  placeholder={t("invite.ask.email")}
                  accessibilityLabel={t("invite.ask.email")}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="done"
                />
                {fix ? (
                  <Pressable onPress={() => setEmail(fix)} accessibilityRole="button" hitSlop={6}>
                    <Text variant="subhead" style={styles.link}>
                      {t("auth.flow.didYouMean", { email: fix })}
                    </Text>
                  </Pressable>
                ) : null}
                <Text variant="small" tone="muted" style={CENTER}>
                  {t("invite.ask.emailHelp")}
                </Text>
              </View>
            </>
          )}
          <View style={styles.field}>
            <AuthField
              value={note}
              onChangeText={setNote}
              placeholder={t("invite.ask.note")}
              accessibilityLabel={t("invite.ask.note")}
              maxLength={JOIN_NOTE_MAX}
              multiline
              textAlignVertical="top"
              minHeight={84}
            />
            <Text variant="small" tone="muted" style={CENTER}>
              {t("invite.ask.noteHelp")}
            </Text>
          </View>
          {error ? (
            <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
              {error}
            </Text>
          ) : null}
          <Button
            variant="primary"
            wide
            label={t("invite.ask.send")}
            disabled={!ready || asking}
            onPress={() => void ask()}
          />
          {user ? null : (
            <AuthLink
              lead={t("invite.ask.haveAccount")}
              label={t("auth.signIn")}
              onPress={() => {
                rememberInvite(token, "link");
                router.push("/sign-in");
              }}
            />
          )}
        </>
      );
      break;
  }

  return (
    <AuthScaffold
      title={title}
      subtitle={subtitle}
      stepKey={view.state}
      onBack={leave}
      agentMode={asking ? "run" : "idle"}
      expression={expression}
    >
      {body}
    </AuthScaffold>
  );
}

/** Someone else's words, as they wrote them (an admin's note to someone turned down). */
function Said({ text }: { text: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.said, { backgroundColor: c.sunken }]}>
      <Text variant="body">{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  lead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
  grow: { flex: 1, minWidth: 0 },
  locked: { gap: 2, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
  field: { gap: 6 },
  as: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 6, rowGap: 2 },
  link: { fontWeight: "600" },
  said: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
});
