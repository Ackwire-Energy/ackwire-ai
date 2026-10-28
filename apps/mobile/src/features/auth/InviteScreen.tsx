import {
  ApiError,
  type AskToJoinResult,
  type InvitationPreview,
  keys,
  useApi,
  useAuthConfig,
  useMe,
} from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { errorCode, invitedErrorText } from "@agenteschat/client/lib/errors";
import { type HumanCheck, withHumanCheck } from "@agenteschat/client/lib/human-check";
import {
  ANSWER_POLL_MS,
  askView,
  JOIN_CODE_LENGTH,
  JOIN_NAME_MAX,
  JOIN_NOTE_MAX,
  joinCode,
  sendsEmail,
} from "@agenteschat/client/lib/join-requests";
import { emailTypoFix, isEmail } from "@agenteschat/client/lib/text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ComponentRef, type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { useNow } from "@/features/shared/hooks";
import { agentLook, joinNames } from "@/features/shared/logic";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { AgentAvatar, Button, haptics, Icon, InfoHint, LineIcon, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, failureText } from "./human-check";
import { forgetInvite, rememberInvite } from "./invite";
import { boldParts } from "./links";

/**
 * An invitation's link opened in the app: who invited, the org, the
 * role and who already works there; the e-mail locked. Signed out: Apple, a password, or "Já tenho conta"
 * (the invitation waits and is accepted once the person is in). Signed in: one tap to join. Expired:
 * "Pedir um novo convite" (the person who invited gets the request at once), or, on a server that sends no
 * email, whom to ask. A workspace's invitation link only lets people ask to join (`AskToJoin`).
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
  // Asking for a new one is an email to whoever invited.
  const emails = sendsEmail(useAuthConfig().data);
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
      <AuthScaffold
        title={t("invite.expiredTitle")}
        subtitle={emails ? t("invite.expiredText") : `${t("invite.expiredText")} ${t("invite.ask.closedText")}`}
        expression="closed"
      >
        {emails ? (
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
        ) : null}
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
      setError(
        invitedErrorText(t, e) ??
          (wrong ? t("mobile.invite.wrongAccount", { email: invitation.email }) : t("mobile.invite.failed")),
      );
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
      <AgentsThere agents={invitation.agents ?? []} more={invitation.moreAgents ?? 0} />
      <View style={[styles.locked, { backgroundColor: c.sunken }]}>
        <InfoHint name={t("common.about", { label: t("auth.email") })} text={t("invite.emailHelp")}>
          <Text variant="body" numberOfLines={1}>
            {invitation.email}
          </Text>
        </InfoHint>
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

/** "Ada, Theo, Lia e mais 2 já trabalham lá", their faces leading the first line. */
function AgentsThere({ agents, more }: { agents: NonNullable<InvitationPreview["agents"]>; more: number }) {
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
        {t("invite.ask.agents", {
          count: agents.length + more,
          names: joinNames(
            [...agents.map((a) => a.name), ...(more ? [t("invite.ask.moreAgents", { count: more })] : [])],
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
  const [proof, setProof] = useState<{ email: string; code: string } | null>(null);
  const emailField = useRef<ComponentRef<typeof AuthField>>(null);
  const noteField = useRef<ComponentRef<typeof AuthField>>(null);

  const org = preview.orgName;
  const address = sent?.email ?? preview.you?.email ?? user?.email ?? "";
  const emailsGoOut = sent?.emailed ?? sendsEmail(config.data);
  // On a server that sends email, an address that isn't a confirmed account's proves itself first (ADR 0072).
  const proofNeeded = emailsGoOut && !user?.emailVerified;
  const typedEmail = user ? user.email : email;
  const proven = proof !== null && proof.email === typedEmail.trim().toLowerCase();
  const human = useHumanCheck(view.state === "form" && proofNeeded ? "ask-code" : null);
  const fix = user ? null : emailTypoFix(email);
  const ready = (user !== null || (name.trim() !== "" && isEmail(email))) && (!proofNeeded || proven);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.invitation(token) });
  const onProven = (code: string) => {
    setProof({ email: typedEmail.trim().toLowerCase(), code });
    noteField.current?.focus();
  };

  const ask = async () => {
    if (!ready || asking) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.invites.ask(token, {
        ...(user ? {} : { name: name.trim(), email: email.trim() }),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(proofNeeded && proof ? { code: proof.code } : {}),
      });
      haptics.success();
      setSent(result);
      if (user) await refresh();
    } catch (e) {
      haptics.warning();
      // The proof ran out (30 minutes) or was used: Verify again.
      if (errorCode(e)?.startsWith("join.code_")) setProof(null);
      setError((e instanceof ApiError ? invitedErrorText(t, e) : null) ?? failureText(t, e));
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
            <Said reason={view.reason} />
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
      break;
    case "form":
      title = t("invite.ask.title", { org });
      subtitle = preview.invitedBy
        ? t("invite.ask.lead", { name: preview.invitedBy.split(/\s+/)[0], org })
        : t("invite.ask.leadNoName", { org });
      body = (
        <>
          <AgentsThere agents={preview.agents ?? []} more={preview.moreAgents ?? 0} />
          {user && !proofNeeded ? (
            <View style={styles.as}>
              <Text variant="subhead" tone="muted">
                {t("invite.ask.as", { email: user.email })}
              </Text>
              <NotYou />
            </View>
          ) : null}
          {user ? null : (
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
          )}
          {proofNeeded ? (
            // Signed in, the account's own address, read-only, takes the place of "You'll ask as".
            <EmailProof
              token={token}
              email={typedEmail}
              onEmail={user ? undefined : setEmail}
              emailRef={emailField}
              proven={proven}
              onProven={onProven}
              check={human.check}
            >
              {fix ? <DidYouMean fix={fix} onFix={setEmail} /> : null}
              {user ? (
                <View style={styles.as}>
                  <NotYou />
                </View>
              ) : null}
            </EmailProof>
          ) : user ? null : (
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
              {fix ? <DidYouMean fix={fix} onFix={setEmail} /> : null}
            </View>
          )}
          <View style={styles.field}>
            <Text variant="subhead" tone="muted">
              {t("invite.ask.note")}
            </Text>
            <AuthField
              ref={noteField}
              value={note}
              onChangeText={setNote}
              placeholder={t("invite.ask.noteHelp")}
              accessibilityLabel={t("invite.ask.note")}
              maxLength={JOIN_NOTE_MAX}
              multiline
              textAlignVertical="top"
              minHeight={84}
            />
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
                // The address typed here goes along, so the sign-in starts at the password.
                router.push({ pathname: "/sign-in", params: isEmail(email) ? { email: email.trim() } : {} });
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
      overlay={human.view}
    >
      {body}
    </AuthScaffold>
  );
}

/** "Not you? Sign out", for the account the page asks as. */
function NotYou() {
  const { t } = useTranslation();
  return (
    <Pressable onPress={() => void signOut()} accessibilityRole="link" hitSlop={8}>
      <Text variant="subhead" style={styles.link}>
        {t("invite.ask.notYou")}
      </Text>
    </Pressable>
  );
}

/** "Did you mean …?" under an address with a common typo. */
function DidYouMean({ fix, onFix }: { fix: string; onFix: (email: string) => void }) {
  const { t } = useTranslation();
  return (
    <Pressable onPress={() => onFix(fix)} accessibilityRole="button" hitSlop={6}>
      <Text variant="subhead" style={styles.link}>
        {t("auth.flow.didYouMean", { email: fix })}
      </Text>
    </Pressable>
  );
}

/** What the slot inside the email's right edge shows: every one is laid out, so the slot never changes width. */
const SLOTS = ["verify", "wait", "resend", "verified"] as const;
type Slot = (typeof SLOTS)[number];

/**
 * The ask's email with Verify inside its right edge (ADR 0072): a code goes to the address, and typed back here it
 * proves it. Verify, the countdown, Resend and Verified share one slot as wide as the longest, so the address never
 * moves. A code and a proof belong to the address they were for: editing the email starts over. `onEmail` absent:
 * the signed-in account's own address, read-only. `children` go under the email.
 */
function EmailProof({
  token,
  email,
  onEmail,
  emailRef,
  proven,
  onProven,
  check,
  children,
}: {
  token: string;
  email: string;
  onEmail?: (email: string) => void;
  emailRef?: Ref<ComponentRef<typeof AuthField>>;
  proven: boolean;
  onProven: (code: string) => void;
  check: HumanCheck | null;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { colors: c } = useTheme();
  const key = email.trim().toLowerCase();
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<{ email: string; text: string } | null>(null);
  // Past the address's hourly or daily cap, each press is a sure 429 that still spends the link's shared budget.
  const [capped, setCapped] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [slotWidth, setSlotWidth] = useState(0);
  const codeField = useRef<ComponentRef<typeof AuthField>>(null);
  const out = sent?.email === key;
  const left = out && sent ? Math.max(0, sent.resendAt - Date.now()) : 0;
  // A repaint every second while the countdown runs; the time itself is read just above.
  useNow(left > 0 && !proven ? 1000 : 60_000);
  const said = error?.email === key ? error.text : null;
  const body = onEmail ? { email: email.trim() } : {};
  const showCode = out && !proven;
  const slot: Slot = proven ? "verified" : !out ? "verify" : left > 0 ? "wait" : "resend";

  // Each code that goes out takes the focus once.
  useEffect(() => {
    if (sent) codeField.current?.focus();
  }, [sent]);

  const codeOut = (to: string, resendIn: number) => {
    setSent({ email: to, resendAt: Date.now() + resendIn * 1000 });
    setCode("");
    setError(null);
  };
  const send = async () => {
    const to = key;
    setSending(true);
    try {
      const r = await withHumanCheck(check, (humanCheck) => api.invites.sendCode(token, body, humanCheck));
      codeOut(to, r.resendIn);
    } catch (e) {
      if (e instanceof CheckCancelled) return;
      // A code went out a moment ago (another try, another device): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "join.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(to, retryIn);
      else setError({ email: to, text: failureText(t, e) });
      if (errorCode(e) === "join.code_limit") setCapped(to);
    } finally {
      setSending(false);
    }
  };
  const checkCode = async (typed: string) => {
    const to = key;
    setChecking(true);
    try {
      await api.invites.checkCode(token, { ...body, code: typed });
      setError(null);
      haptics.success();
      AccessibilityInfo.announceForAccessibility(t("invite.ask.verified"));
      onProven(typed);
    } catch (e) {
      haptics.warning();
      setCode("");
      setError({ email: to, text: failureText(t, e) });
      codeField.current?.focus();
    } finally {
      setChecking(false);
    }
  };
  const typed = (value: string) => {
    if (checking) return;
    const digits = joinCode(value);
    setCode(digits);
    if (digits.length === JOIN_CODE_LENGTH) void checkCode(digits);
  };

  const errorLine = (text: string) => (
    <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
      {text}
    </Text>
  );
  return (
    <>
      <View style={styles.field}>
        <View style={styles.inside}>
          <AuthField
            ref={emailRef}
            value={email}
            onChangeText={onEmail}
            editable={onEmail !== undefined}
            placeholder={t("invite.ask.email")}
            accessibilityLabel={t("invite.ask.email")}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="done"
            paddingRight={slotWidth + 12}
          />
          <View style={styles.slot} onLayout={(e) => setSlotWidth(Math.ceil(e.nativeEvent.layout.width))}>
            {SLOTS.map((s) => {
              const shown = s === slot;
              const press = s === "verify" || s === "resend";
              const off = capped === key || (s === "verify" && !isEmail(email));
              return (
                <Pressable
                  key={s}
                  onPress={() => void send()}
                  disabled={!shown || !press || off || sending}
                  hitSlop={6}
                  accessibilityRole={press ? "button" : "text"}
                  accessibilityLabel={
                    s === "wait"
                      ? t("invite.ask.resendIn", { count: Math.ceil(left / 1000) })
                      : s === "verified"
                        ? t("invite.ask.verified")
                        : undefined
                  }
                  accessibilityState={press ? { disabled: off || sending, busy: sending } : undefined}
                  accessibilityElementsHidden={!shown}
                  importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
                  style={[styles.slotItem, shown ? null : styles.slotHidden]}
                >
                  {s === "verified" ? (
                    <Icon name="check" size={20} color={c.ok} />
                  ) : s === "wait" ? (
                    <Text variant="subhead" tone="muted" style={styles.tabular}>
                      {formatTimeLeft(left)}
                    </Text>
                  ) : (
                    <>
                      {/* Sending, the label keeps its width under the spinner. */}
                      <Text
                        variant="subhead"
                        tone={off ? "faint" : "ink"}
                        style={[styles.link, shown && sending ? styles.ghost : null]}
                      >
                        {t(s === "verify" ? "invite.ask.verify" : "invite.ask.resend")}
                      </Text>
                      {shown && sending ? <ActivityIndicator color={c.muted} style={StyleSheet.absoluteFill} /> : null}
                    </>
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
        {said && !showCode ? errorLine(said) : null}
        {children}
      </View>
      {showCode ? (
        <View style={styles.field}>
          <AuthField
            ref={codeField}
            code
            value={code}
            onChangeText={typed}
            placeholder={t("invite.ask.code")}
            accessibilityLabel={t("invite.ask.code")}
            accessibilityState={{ busy: checking }}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            returnKeyType="done"
            onSubmitEditing={() => {
              if (code.length === JOIN_CODE_LENGTH && !checking) void checkCode(code);
            }}
          />
          {said ? errorLine(said) : null}
        </View>
      ) : null}
    </>
  );
}

/** Stands in for the person's words while the sentence is split into its bold label and the rest. */
const WORDS = "\u2063";

/** Someone else's words, as they wrote them (an admin's note to someone turned down), after the label in bold. */
function Said({ reason }: { reason: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={[styles.said, { backgroundColor: c.sunken }]}>
      <Text variant="body">
        {boldParts(t("invite.ask.reasonSaid", { reason: WORDS })).map((part, i) =>
          part.bold ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence, in order
            <Text key={i} variant="body" style={styles.link}>
              {part.text.replace(WORDS, reason)}
            </Text>
          ) : (
            part.text.replace(WORDS, reason)
          ),
        )}
      </Text>
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
  // Verify's slot sits inside the email's right edge, as the password's eye does.
  inside: { justifyContent: "center" },
  slot: { position: "absolute", right: 4, alignItems: "center" },
  slotItem: { minHeight: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  // Laid out for its width, with no height: the slot is as wide as its longest label.
  slotHidden: { height: 0, minHeight: 0, opacity: 0, overflow: "hidden" },
  ghost: { opacity: 0 },
  tabular: { fontVariant: ["tabular-nums"] },
});
