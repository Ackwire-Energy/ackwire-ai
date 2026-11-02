import { useAiAccounts, useCredentials, useIssues, useJoinRequests, useMe } from "@agenteschat/client";
import {
  accountTitle,
  groupPlans,
  onSeveralComputers,
  ownSignIns,
  ownSignInTitle,
} from "@agenteschat/client/lib/ai-accounts";
import { can } from "@agenteschat/client/lib/permissions";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { useSoundChoice } from "@/lib/sounds";
import { useOrg } from "@/providers/org";
import { Button, Icon, type IconName, PersonAvatar, ProviderLogo, Text, useTheme, WithPresence } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { CoverPage, PageRow, PageSection, TILE } from "../shared/CoverPage";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { OrgAvatar } from "../shared/OrgAvatar";
import { goBack, Tile } from "../shared/parts";
import { usePersonPhoto } from "../shared/photo";
import { useMyPerson } from "../status/hooks";
import { MyStatusRow } from "../status/MyStatusRow";
import { PlanMeter } from "../usage/parts";
import { openIssuesWithMe } from "./logic";
import { usePushSwitch, useSoundLabel, useStartLabel } from "./PreferencePages";

/** Opens a screen over this page with the platform's push (back comes here). */
const open = (href: string) => router.push(href as never);

/**
 * Você, a page pushed from the avatar, in Conversas' language: the workspace's sky with your photo, name, @ and role
 * (the native bar clear over it, the sky lagging behind the scroll), "Editar perfil" and "Trocar workspace"; your
 * status right under you (ADR 0084, pushing Status); your agents, alive; what they think with (the plans, the
 * computers' own sign-ins, each with its usage in pixels);
 * "Do workspace" (the workspace itself first, opening its settings: `app/(app)/settings/*`) and the preferences
 * as loose rows; Sair and the version. Each row pushes its screen (Conta, Workspaces, Membros, Notificações, Sons,
 * Aparência, Idioma: `app/(app)/me/*`) or one of the app's.
 */
export function MeScreen() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const theme = useTheme();
  const dir = useDirectory();
  const issues = useIssues(org.orgId);
  const admin = can(org.org, "manage_credentials");
  const credentials = useCredentials(org.orgId, admin);
  const liveKeys = (credentials.data ?? []).filter((k) => !k.revokedAt).length;
  // What the agents think with: the computers' own sign-ins and the person's accounts ("Contas de IA" counts them,
  // then the API keys).
  const ai = useAiAccounts(org.orgId);
  const own = ownSignIns(ai.data);
  const accounts = groupPlans(ai.data?.accounts ?? []);
  const plans = own.length + accounts.length;
  // On which computer, as "Contas de IA" says it: only where the accounts sit on more than one.
  const several = onSeveralComputers(ai.data?.accounts ?? []);
  const c = useColors();
  const requests = useJoinRequests(org.orgId, can(org.org, "invite_people"));
  const waiting = requests.data?.length ?? 0;
  const push = usePushSwitch().on;

  const mine = meId ? dir.memberById.get(meId) : undefined;
  // How you appear (to yourself: hidden stays hidden), on your photo's corner (ADR 0084).
  const myPresence = useMyPerson()?.presence;
  const name = me.data?.user.name ?? "";
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  const role = org.org ? t(`mobile.me.role.${org.org.role}`) : "";
  const themeLabel = t(`mobile.theme.${theme.preference}`);
  const sounds = useSoundChoice();
  const styleLabel = useSoundLabel();
  const startLabel = useStartLabel();
  const en = i18n.language.startsWith("en");
  const withMe = openIssuesWithMe(issues.data, meId);
  const version = Constants.expoConfig?.version ?? "";

  const myAgents = dir.agents.filter((a) => a.ownerUserId === meId);
  const headline = [mine?.handle ? `@${mine.handle}` : null, role, org.org?.name].filter(Boolean).join(" · ");
  const workspaceRows: { icon: IconName; label: string; value?: string; href: string }[] = [
    // Everyone's: who invites finds the requests there, and a member who may not suggests someone (ADR 0090).
    {
      icon: "members",
      label: t("members.title"),
      ...(waiting > 0 ? { value: t("mobile.members.waiting", { count: waiting }) } : {}),
      href: "/me/members",
    },
    {
      icon: "checkc",
      label: t("mobile.me.issues"),
      ...(withMe > 0 ? { value: t("mobile.me.issuesWithMe", { count: withMe }) } : {}),
      href: "/issues",
    },
    { icon: "clock", label: t("routines.title"), href: "/routines" },
    { icon: "file", label: t("wiki.title"), href: "/wiki" },
    { icon: "brain", label: t("mobile.memory.title"), href: "/memory" },
    { icon: "doc", label: t("mobile.me.drive"), href: "/drive" },
    { icon: "bolt", label: t("mobile.me.connectors"), href: "/connectors" },
    { icon: "chart", label: t("mobile.me.usage"), href: "/usage" },
    {
      icon: "brain",
      label: t("mobile.ai.row"),
      value:
        plans > 0
          ? t("mobile.ai.rowPlans", { count: plans })
          : admin && credentials.data
            ? liveKeys > 0
              ? t("mobile.ai.rowKeys", { count: liveKeys })
              : t("mobile.ai.rowNone")
            : undefined,
      href: "/ai-accounts",
    },
  ];
  const prefRows: { icon: IconName; label: string; value?: string; href: string }[] = [
    {
      icon: "bell",
      label: t("mobile.me.notifications"),
      ...(push === null ? {} : { value: push ? t("mobile.me.on") : t("mobile.me.off") }),
      href: "/me/notifications",
    },
    // A server from before the choice sends none and can't keep one (`PUT …/me/start` answers 404).
    ...(org.org?.start !== undefined
      ? [{ icon: "home" as const, label: t("mobile.me.start"), value: startLabel, href: "/me/start" }]
      : []),
    // Likewise: a server from before the choice sends no `showActivity`.
    ...(org.org?.showActivity !== undefined
      ? [
          {
            icon: "eye" as const,
            label: t("mobile.me.activity"),
            value: org.org.showActivity ? t("mobile.me.on") : t("mobile.me.off"),
            href: "/me/activity",
          },
        ]
      : []),
    {
      icon: "sound",
      label: t("mobile.me.sounds"),
      value: sounds === "off" ? t("mobile.me.soundsOff") : styleLabel(sounds),
      href: "/me/sounds",
    },
    {
      icon: theme.scheme === "dark" ? "moon" : "sun",
      label: t("mobile.me.appearance"),
      value: themeLabel,
      href: "/me/appearance",
    },
    {
      icon: "globe",
      label: t("mobile.me.language"),
      value: en ? t("mobile.me.langEn") : t("mobile.me.langPt"),
      href: "/me/language",
    },
  ];
  return (
    // The page is white like Conversas; its screens sit on the grouped gray, as settings do.
    <CoverPage
      face={
        // A ring in the page's color lifts the photo off the sky; the badge sits on it, ringed the same.
        <WithPresence size={74} presence={myPresence} ring={c.bg}>
          <View style={[styles.ring, { borderColor: c.bg }]}>
            <PersonAvatar name={name || "?"} size={68} photo={photo} />
          </View>
        </WithPresence>
      }
      title={name}
      headline={headline}
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            icon="pen"
            label={t("mobile.me.editProfile")}
            onPress={() => open("/me/account")}
          />
          {org.orgs.length > 1 ? (
            <Button
              size="sm"
              variant="secondary"
              label={t("mobile.me.switchWorkspace")}
              onPress={() => open("/me/workspaces")}
            />
          ) : null}
        </>
      }
    >
      {/* Your status, right under you: it pushes Status. */}
      <MyStatusRow />

      {myAgents.length > 0 ? (
        <>
          <PageSection title={t("mobile.me.yourAgents")} count={myAgents.length} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crew}>
            {myAgents.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => open(`/agent/${a.id}`)}
                accessibilityRole="button"
                accessibilityLabel={a.name}
                style={styles.crewItem}
              >
                <AgentFace agentId={a.id} size={52} presence />
                <Text variant="caption" tone="ink2" numberOfLines={1}>
                  {a.name}
                </Text>
              </Pressable>
            ))}
            {can(org.org, "create_agents") ? (
              <Pressable
                onPress={() => open("/new-agent")}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.me.newAgent")}
                style={styles.crewItem}
              >
                <View style={[styles.add, { borderColor: c.line2 }]}>
                  <Icon name="plus" size={22} color={c.faint} />
                </View>
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {t("mobile.me.newAgent")}
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </>
      ) : null}

      <PageSection title={t("mobile.me.thinksWith")} {...(plans > 0 ? { count: plans } : {})} />
      {own.map((o, i) => (
        <PlanRow
          key={o.key}
          logo={o.kind}
          title={ownSignInTitle(t, o)}
          sub={t("mobile.me.ownOn", { computer: o.computer })}
          usage={o.usage}
          divider={i > 0}
          onPress={() => open("/ai-accounts")}
        />
      ))}
      {accounts.map((a, i) => {
        const first = a.logins[0];
        if (!first) return null;
        return (
          <PlanRow
            key={a.key}
            logo={first.provider ?? first.kind}
            title={accountTitle(first)}
            sub={several ? t("aiAccounts.page.on", { computer: first.computer }) : null}
            usage={a.usage}
            divider={own.length + i > 0}
            onPress={() => open("/ai-accounts")}
          />
        );
      })}
      {plans === 0 ? (
        <PageRow icon="plus" label={t("aiAccounts.page.connect")} onPress={() => openConnectAi()} />
      ) : null}

      <PageSection title={t("mobile.me.fromWorkspace")} />
      {/* The workspace itself first: its settings, as the web's sections. */}
      {org.org ? (
        <PageRow
          leading={<OrgAvatar logo={org.org.logo} size={TILE} />}
          label={org.org.name}
          value={t("settings.title")}
          onPress={() => open("/settings")}
        />
      ) : null}
      {workspaceRows.map((r, i) => (
        <PageRow
          key={r.href}
          icon={r.icon}
          label={r.label}
          value={r.value}
          divider={i > 0 || !!org.org}
          onPress={() => open(r.href)}
        />
      ))}

      <PageSection title={t("mobile.me.preferences")} />
      {prefRows.map((r, i) => (
        <PageRow
          key={r.href}
          icon={r.icon}
          label={r.label}
          value={r.value}
          divider={i > 0}
          onPress={() => open(r.href)}
        />
      ))}

      <View style={styles.gapBig} />
      <PageRow
        icon="out"
        label={t("mobile.me.signOut")}
        danger
        chevron={false}
        onPress={() =>
          Alert.alert(t("mobile.me.signOutConfirm"), t("mobile.me.signOutConfirmText"), [
            { text: t("mobile.common.cancel"), style: "cancel" },
            {
              text: t("mobile.me.signOut"),
              style: "destructive",
              onPress: () => {
                goBack();
                void signOut();
              },
            },
          ])
        }
      />
      {version ? (
        <Text variant="footnote" tone="faint" style={styles.version}>
          {t("mobile.me.version", { version })}
        </Text>
      ) : null}
    </CoverPage>
  );
}

/** A plan the agents think with: its maker's mark, its name, its usage in pixels and where it is (`sub`), if said. */
function PlanRow({
  logo,
  title,
  sub,
  usage,
  divider,
  onPress,
}: {
  logo: string;
  title: string;
  sub: string | null;
  usage: Parameters<typeof PlanMeter>[0]["usage"] | null;
  divider: boolean;
  onPress: () => void;
}) {
  return (
    <PageRow
      leading={
        <Tile size={TILE}>
          <ProviderLogo id={logo} size="sm" />
        </Tile>
      }
      label={title}
      divider={divider}
      onPress={onPress}
      below={
        usage || sub ? (
          <>
            {usage ? (
              <View style={styles.meter}>
                <PlanMeter usage={usage} compact />
              </View>
            ) : null}
            {sub ? (
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {sub}
              </Text>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  gapBig: { height: 22 },
  // A ring in the page's color lifts the photo off the sky.
  ring: { borderRadius: 40, borderWidth: 3 },
  crew: { gap: 14, paddingHorizontal: 20, paddingVertical: 4 },
  crewItem: { width: 62, alignItems: "center", gap: 6 },
  add: {
    width: 52,
    height: 52,
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  meter: { marginTop: 6, marginBottom: 3 },
  version: { paddingHorizontal: 20, paddingTop: 14 },
});
