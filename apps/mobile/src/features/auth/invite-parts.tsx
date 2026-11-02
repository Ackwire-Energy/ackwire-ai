import { type InvitationPreview, useAuthConfig } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { agentLook } from "@/features/shared/logic";
import { useSession } from "@/providers/session";
import { AgentAvatar, Button, Icon, LineIcon, Text, useTheme } from "@/ui";
import { CENTER } from "@/ui/auth/AuthScaffold";
import { Terms } from "./AuthFlow";
import { boldParts } from "./links";

/** What an invitation's screens show of who works there. */
export type InvitedAgents = NonNullable<InvitationPreview["agents"]>;

/** Back from an invitation's first screen: the previous one, else home when signed in, else the sign-in. */
export function useLeaveInvite() {
  const session = useSession();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(session.signedIn ? "/" : "/sign-in");
  };
}

/** Leaves an invitation that leads nowhere: home when signed in, else the sign-in. */
export function LeaveButton() {
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

/** The sentence naming who works there, or null with nobody: "Ada e Theo trabalham lá" in the given key's words. */
export function useAgentsLine(key: "invite.crew" | "invite.ask.agents", agents: InvitedAgents, more: number) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  const names = [...agents.map((a) => a.name), ...(more ? [t("invite.ask.moreAgents", { count: more })] : [])];
  return t(key, { count: agents.length + more, names: joinNames(names, t) });
}

/** The faces leading "who already works there": as tall as that line, so they sit on it. */
const FACE = 22;

/** "Ada, Theo, Lia e mais 2 já trabalham lá", their faces leading the first line. */
export function AgentsThere({ agents, more }: { agents: InvitedAgents; more: number }) {
  const line = useAgentsLine("invite.ask.agents", agents, more);
  if (!line) return null;
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
        {line}
      </Text>
    </View>
  );
}

/** The workspace's first agent beside who it's from: "**Acme** · Ana compartilhou este link". */
export function OrgLine({ agent, strong, text }: { agent?: InvitedAgents[number]; strong: string; text?: string }) {
  return (
    <View style={styles.org}>
      {agent ? <AgentAvatar agent={{ ...agentLook(agent), id: agent.id }} size={30} live={false} /> : null}
      <Text variant="small" tone="muted" style={styles.grow}>
        <Text variant="small" tone="ink2" style={styles.link}>
          {strong}
        </Text>
        {text ? ` · ${text}` : null}
      </Text>
    </View>
  );
}

/** The address an invitation is locked to: no field, nothing to change. */
export function LockedEmail({ email }: { email: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={[styles.locked, { backgroundColor: c.sunken }]} accessible accessibilityHint={t("invite.emailHelp")}>
      <Icon name="lock" size={16} color={c.muted} />
      <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.grow}>
        {email}
      </Text>
    </View>
  );
}

/** A refusal in words, under the field it's about. */
export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
      {error}
    </Text>
  );
}

/** "Did you mean …?" under an address with a common typo. */
export function DidYouMean({ fix, onFix }: { fix: string; onFix: (email: string) => void }) {
  const { t } = useTranslation();
  return (
    <Pressable onPress={() => onFix(fix)} accessibilityRole="button" hitSlop={6}>
      <Text variant="subhead" style={[CENTER, styles.link]}>
        {t("auth.flow.didYouMean", { email: fix })}
      </Text>
    </Pressable>
  );
}

/** The Terms and the Privacy policy, where the server has both. */
export function InviteTerms() {
  const config = useAuthConfig().data;
  if (!config?.termsUrl || !config.privacyUrl) return null;
  return <Terms termsUrl={config.termsUrl} privacyUrl={config.privacyUrl} />;
}

/** Stands in for the person's words while the sentence is split into its bold label and the rest. */
const WORDS = "⁣";

/** Someone else's words, as they wrote them (an admin's note to someone turned down), after the label in bold. */
export function Said({ reason }: { reason: string }) {
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
  lead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
  grow: { flex: 1, minWidth: 0 },
  org: { flexDirection: "row", alignItems: "center", gap: 10 },
  locked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
  },
  link: { fontWeight: "600" },
  said: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
});
