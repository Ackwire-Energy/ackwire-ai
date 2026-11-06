import {
  type Message,
  useAgents,
  useAllInvitations,
  useApprovals,
  useCatalog,
  useChannels,
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
  memberRowDone,
  skillUpdateState,
} from "@agenteschat/client/lib/action-cards";
import { APP_PAGES, appPagePath } from "@agenteschat/client/lib/app-pages";
import { connectedItems } from "@agenteschat/client/lib/connected";
import { hostOf } from "@agenteschat/client/lib/import/shared";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { Button, type IconName, LineIcon, Text, useTheme } from "@/ui";
import { AskDone } from "../chat/asks";
import { useCardTop } from "../chat/look";
import { PersonLimitNote } from "../usage/people";
import { openPage } from "./parts";

/**
 * The web's cards to connect an app or an MCP server (`offer_connect_app`) and to invite people (`offer_invites`) in
 * place of their text: the button opens the app's own screen, filled in (Conectores at the service or at connecting by
 * address with the address typed in; Convidar pessoas with the addresses). Done from live data, one quiet line.
 * The right hand's approvals, people and "Abrir" cards (ADR 0137 §4) open the matching screen here (an approval, the
 * members), or the page on the website where the phone has none.
 */
export function OfferCard({ message: m }: { message: Message }) {
  const card = actionCardOf(m.meta);
  if (m.author.type !== "agent" || !card) return null;
  if (card.kind === "connect_app") return <ConnectApp card={card} />;
  if (card.kind === "invite_people") return <Invite card={card} />;
  if (card.kind === "install_skill") return <InstallSkill card={card} />;
  if (card.kind === "update_skills") return <UpdateSkills card={card} postedAt={m.createdAt} />;
  if (card.kind === "approvals") return <Approvals card={card} />;
  if (card.kind === "member_changes") return <People card={card} />;
  if (card.kind === "open_page") return <OpenScreen card={card} />;
  if (card.kind === "person_limit") return <PersonLimitNote card={card} />;
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

function Approvals({ card }: { card: Extract<Card, { kind: "approvals" }> }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const approvals = useApprovals(orgId);
  const rows = card.approvalIds.map((id) => approvals.data?.find((a) => a.id === id));
  const next = rows.find((a) => a?.status === "pending");
  const titles = rows
    .map((a) => a?.title)
    .filter(Boolean)
    .join(", ");
  return (
    <Shell
      icon="shield"
      title={t("rightHand.approvals.title")}
      why={card.why}
      detail={titles}
      done={approvals.isSuccess && !next ? `${t("rightHand.approvals.done")}: ${titles}` : null}
      action={next ? t("rightHand.open.open") : null}
      onAction={() => router.push(`/approval/${next?.id ?? ""}` as never)}
      blocked=""
    />
  );
}

function People({ card }: { card: Extract<Card, { kind: "member_changes" }> }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const members = useMembers(orgId);
  const names = [...new Set(card.rows.map((r) => r.name))].join(", ");
  const done = members.isSuccess && card.rows.every((r) => memberRowDone(r, members.data));
  return (
    <Shell
      icon="members"
      title={t("rightHand.people.title")}
      why={card.why}
      detail={names}
      done={done ? `${t("rightHand.people.done")}: ${names}` : null}
      action={t("rightHand.open.open")}
      onAction={() => router.push("/me/members" as never)}
      blocked=""
    />
  );
}

function OpenScreen({ card }: { card: Extract<Card, { kind: "open_page" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const agents = useAgents(orgId);
  const channels = useChannels(orgId);
  const page = APP_PAGES[card.page];
  const title =
    card.page === "agent"
      ? (agents.data?.find((a) => a.id === card.agentId)?.name ?? "")
      : card.page === "channel"
        ? `#${channels.data?.find((c) => c.id === card.channelId)?.name ?? ""}`
        : t(page.label as never);
  const here = appPagePath(page.phone, card);
  const web = appPagePath(page.web, card);
  const allowed = !page.may || can(org, page.may);
  return (
    <Shell
      icon="out"
      title={title}
      why={card.why}
      done={null}
      action={allowed && (here || web) ? t(here ? "rightHand.open.open" : "rightHand.open.web") : null}
      onAction={() => (here ? router.push(here as never) : openPage(`${serverUrl()}/org/${orgId}${web ?? ""}`))}
      blocked={t("rightHand.open.notAllowed")}
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
  icon: IconName;
  title: string;
  why: string;
  detail?: string;
  done: string | null;
  action: string | null;
  onAction: () => void;
  blocked: string;
}) {
  const { colors } = useTheme();
  const cardTop = useCardTop();
  if (done) {
    return (
      <View>
        <AskDone done words={done} />
      </View>
    );
  }
  return (
    <View style={[styles.card, { backgroundColor: colors.sunken }, cardTop]}>
      <View style={styles.row}>
        <LineIcon name={icon} variant="subhead" size={16} color={colors.ink2} />
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
  card: { borderRadius: 14, padding: 12, gap: 8, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontWeight: "600" },
});
