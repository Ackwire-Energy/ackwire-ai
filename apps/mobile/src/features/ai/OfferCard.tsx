import {
  type Message,
  useAllInvitations,
  useCatalog,
  useConnections,
  useCustomServers,
  useMembers,
  useSkills,
} from "@agenteschat/client";
import {
  actionCardOf,
  connectAppDone,
  installSkillDone,
  inviteDone,
  skillUpdateState,
} from "@agenteschat/client/lib/action-cards";
import { connectedItems } from "@agenteschat/client/lib/connected";
import { hostOf } from "@agenteschat/client/lib/import/shared";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text, useTheme } from "@/ui";
import { AskDone } from "../chat/asks";

/**
 * The web's cards to connect an app or an MCP server (`offer_connect_app`) and to invite people (`offer_invites`) in
 * place of their text: the button opens the app's own screen, filled in (Conectores at the service or at connecting by
 * address with the address typed in; Convidar pessoas with the addresses). Done from live data, one quiet line.
 */
export function OfferCard({ message: m }: { message: Message }) {
  const card = actionCardOf(m.meta);
  if (m.author.type !== "agent" || !card) return null;
  if (card.kind === "connect_app") return <ConnectApp card={card} />;
  if (card.kind === "invite_people") return <Invite card={card} />;
  if (card.kind === "install_skill") return <InstallSkill card={card} />;
  if (card.kind === "update_skills") return <UpdateSkills card={card} postedAt={m.createdAt} />;
  return null;
}

type Card = NonNullable<ReturnType<typeof actionCardOf>>;

function ConnectApp({ card }: { card: Extract<Card, { kind: "connect_app" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const defs = catalog.data?.connectors ?? [];
  const def = defs.find((d) => d.id === card.connector);
  const name = def ? connectorName(t, def) : card.url ? hostOf(card.url) : "";
  const title = name ? t("actionCard.connect_app.title", { name }) : t("actionCard.connect_app.mcp");
  const done = connectAppDone(card, connectedItems(connections.data ?? [], servers.data ?? [], defs));
  const query = def ? `connect=${encodeURIComponent(def.id)}` : `mcp=${encodeURIComponent(card.url ?? "")}`;
  return (
    <Shell
      icon="globe"
      title={title}
      why={card.why}
      detail={card.url}
      done={done ? `${t("actionCard.connected")}: ${title}` : null}
      action={can(org, "manage_connectors") ? t("actionCard.connect") : null}
      onAction={() => router.push(`/connectors?${query}` as never)}
      blocked={t("actionCard.connect_app.adminOnly")}
    />
  );
}

function Invite({ card }: { card: Extract<Card, { kind: "invite_people" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const may = can(org, "invite_people");
  const invitations = useAllInvitations(orgId, may);
  const members = useMembers(orgId);
  const known = [
    ...(invitations.data ?? []).filter((i) => i.status === "pending").map((i) => i.email),
    ...(members.data ?? []).map((p) => p.email),
  ];
  const emails = card.emails.join(", ");
  return (
    <Shell
      icon="person"
      title={t("actionCard.invite.title", { count: card.emails.length })}
      why={card.why}
      detail={emails}
      done={inviteDone(card, known) ? `${t("actionCard.invite.done")}: ${emails}` : null}
      action={may ? t("actionCard.invite.open") : null}
      onAction={() => router.push(`/invite-people?emails=${encodeURIComponent(card.emails.join(","))}` as never)}
      blocked={t("actionCard.invite.adminOnly")}
    />
  );
}

function InstallSkill({ card }: { card: Extract<Card, { kind: "install_skill" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const may = can(org, "manage_agents");
  const skills = useSkills(orgId, may);
  return (
    <Shell
      icon="brain"
      title={t("actionCard.install_skill.title")}
      why={card.why}
      detail={card.url}
      done={installSkillDone(card, skills.data ?? []) ? `${t("actionCard.install_skill.done")}: ${card.url}` : null}
      action={may ? t("actionCard.install_skill.open") : null}
      onAction={() => router.push(`/settings/skills/new?url=${encodeURIComponent(card.url)}` as never)}
      blocked={t("actionCard.install_skill.adminOnly")}
    />
  );
}

/** The web's update card: the skills by name, Revisar opening the first one not done (its waiting update first). */
function UpdateSkills({ card, postedAt }: { card: Extract<Card, { kind: "update_skills" }>; postedAt: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const skills = useSkills(orgId, true);
  const rows = card.skillIds.map((id) => {
    const skill = skills.data?.find((s) => s.id === id);
    return { id, name: skill?.name ?? "", state: skillUpdateState(skill, postedAt) };
  });
  const next = rows.find((r) => r.state === "waiting") ?? rows.find((r) => r.state === "open");
  const names = rows
    .map((r) => r.name)
    .filter(Boolean)
    .join(", ");
  return (
    <Shell
      icon="brain"
      title={t("actionCard.update_skills.title", { count: rows.length })}
      why={card.why}
      detail={names}
      done={skills.data && !next ? `${t("actionCard.update_skills.done")}: ${names}` : null}
      action={can(org, "manage_agents") ? t("actionCard.update_skills.review") : null}
      onAction={() => router.push(`/settings/skills/${next?.id ?? ""}` as never)}
      blocked={t("actionCard.update_skills.adminOnly")}
    />
  );
}

function Shell({
  icon,
  title,
  why,
  detail,
  done,
  action,
  onAction,
  blocked,
}: {
  icon: "globe" | "person" | "brain";
  title: string;
  why: string;
  detail?: string;
  done: string | null;
  action: string | null;
  onAction: () => void;
  blocked: string;
}) {
  const { colors } = useTheme();
  if (done) {
    return (
      <View style={styles.done}>
        <AskDone done words={done} />
      </View>
    );
  }
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }]}>
      <View style={styles.row}>
        <Icon name={icon} size={16} color={colors.ink2} />
        <Text variant="subhead" style={styles.title}>
          {title}
        </Text>
      </View>
      {why ? <Text variant="body">{why}</Text> : null}
      {detail ? (
        <Text variant="small" tone="muted">
          {detail}
        </Text>
      ) : null}
      {action ? (
        <Button variant="primary" size="sm" label={action} onPress={onAction} />
      ) : (
        <Text variant="small" tone="muted">
          {blocked}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  done: { marginTop: 6 },
  card: { marginTop: 10, borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
});
