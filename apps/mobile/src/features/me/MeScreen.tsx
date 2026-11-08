import { useAuthConfig, useIssues, useMe, useOverview } from "@agenteschat/client";
import { showsAbout } from "@agenteschat/client/lib/about";
import { isAppLocale, localeInfo } from "@agenteschat/i18n/locale";
import Constants from "expo-constants";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import { Alert, Platform, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signOut } from "@/features/account";
import { type SoundChoice, setSoundChoice, useSoundChoice } from "@/lib/sounds";
import { useOrg } from "@/providers/org";
import { WorkspaceSky } from "@/sky/Sky";
import {
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PersonAvatar,
  PixelOrbit,
  Text,
  type ThemePreference,
  useTheme,
  WithPresence,
} from "@/ui";
import { CoverBarBackdrop, useCoverScroll } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { chooseAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { OrgAvatar } from "../shared/OrgAvatar";
import { goBack, MentionCount, PushedHeader } from "../shared/parts";
import { usePersonPhoto } from "../shared/photo";
import { useTasksUnreadMarks } from "../shared/queries";
import { useMyPerson, usePresenceOf } from "../status/hooks";
import { personLine } from "../status/logic";
import { openStatus } from "../status/StatusScreen";
import { openIssuesWithMe, workspacesBeyond } from "./logic";
import { usePushSwitch, useSoundLabel, useStartLabel } from "./PreferencePages";
import { useWorkspacesAcross } from "./WorkspacesPages";

/** Opens a screen over this page with the platform's push (back comes here). */
const open = (href: string) => router.push(href as never);

/** The agents of yours Você lists before "Ver todos". */
const AGENTS_SHOWN = 3;
/** Your photo on the cover, unframed (framed faces stop at 52). */
const PHOTO = 96;
/** How far the photo hangs below the sky. */
const PHOTO_OVERLAP = 48;

/**
 * Você, pushed from your avatar, as the phone's own settings: the bar reads "Você" with Editar on the right; the
 * workspace's sky as a band with your photo hanging from it, your name, your @ and workspace; then grouped lists on
 * the grouped gray, one value per row. Status first (ADR 0084). The workspace as one row: where you are, how many
 * more and the unread elsewhere, opening the list by server (ADR 0154), with the workspace's settings under it. Your
 * agents, alive (a working one says what it does), "Ver todos" to the Agentes tab. Your work (Tarefas, Propostas,
 * Rotinas, Wiki, Drive, Painéis, Memória): what belongs to the workspace lives in Configurações, once. The
 * preferences; Sons and Aparência change in their row through the system's choice on iOS (a screen on Android, whose
 * dialog holds three buttons at most). Sair alone in red; the version is in Sobre. A settings page is opened many
 * times a day, so nothing here animates beyond the rows' press highlight and the platform's push.
 */
export function MeScreen() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const { groups, elsewhere } = useWorkspacesAcross();
  const theme = useTheme();
  const dir = useDirectory();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // The bar is clear over the sky and becomes its own once the page scrolls under it (as an agent's page).
  const { y, onScroll } = useCoverScroll();
  const issues = useIssues(org.orgId);
  const proposals = useOverview(org.orgId).data?.proposalsWaitingForMe ?? 0;
  const push = usePushSwitch().on;
  const about = showsAbout(useAuthConfig().data);
  const mine = meId ? dir.memberById.get(meId) : undefined;
  // How you appear (to yourself: hidden stays hidden), on your photo's corner (ADR 0084).
  const myPresence = useMyPerson()?.presence;
  const name = me.data?.user.name ?? "";
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  const sounds = useSoundChoice();
  const styleLabel = useSoundLabel();
  const startLabel = useStartLabel();
  const withMe = openIssuesWithMe(issues.data, meId);
  // Mentions of me not read in a task's conversation: the red badge before the value, as on Conversas.
  const tasksUnread = useTasksUnreadMarks();
  const version = Constants.expoConfig?.version ?? "";
  const myAgents = dir.agents.filter((a) => a.ownerUserId === meId);
  const headline = [mine?.handle ? `@${mine.handle}` : null, org.org?.name].filter(Boolean).join(" · ");
  const role = org.org ? t(`mobile.me.role.${org.org.role}`) : "";
  const beyond = workspacesBeyond(groups, org.orgId);
  const workspaceSub =
    beyond.others === 0
      ? role
      : beyond.servers === 0
        ? t("mobile.me.workspaceMore", { count: beyond.others })
        : beyond.servers === 1
          ? t("mobile.me.workspaceMoreElsewhere", { count: beyond.others })
          : t("mobile.me.workspaceMoreServers", { count: beyond.others });
  const soundValue = sounds === "off" ? t("mobile.me.soundsOff") : styleLabel(sounds);
  const themeValue = t(`mobile.theme.${theme.preference}`);

  // On iOS the row's value changes in place through the system's choice; Android's dialog holds three buttons at
  // most, so there the row keeps opening its screen.
  const pickSound = () => {
    if (Platform.OS !== "ios") return open("/me/sounds");
    const choices: SoundChoice[] = ["tactile", "sky", "pixel", "off"];
    chooseAction(
      t("mobile.me.sounds"),
      choices.map((choice) => ({
        label: choice === "off" ? t("mobile.me.soundsOff") : styleLabel(choice),
        onPress: () => setSoundChoice(choice),
      })),
      t("mobile.common.cancel"),
    );
  };
  const pickTheme = () => {
    if (Platform.OS !== "ios") return open("/me/appearance");
    const choices: ThemePreference[] = ["system", "light", "dark"];
    chooseAction(
      t("mobile.me.appearance"),
      choices.map((choice) => ({ label: t(`mobile.theme.${choice}`), onPress: () => theme.setPreference(choice) })),
      t("mobile.common.cancel"),
    );
  };
  const confirmSignOut = () =>
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
    ]);

  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("mobile.me.title")}
        plate
        solid={false}
        grouped
        action={{ label: t("mobile.me.edit"), onPress: () => open("/me/account") }}
      />
      <Animated.ScrollView
        style={styles.fill}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {/* The workspace's sky as a band under the clear bar; your photo hangs from its bottom edge. */}
        <View style={[styles.band, { height: insets.top + 62 + PHOTO_OVERLAP }]}>
          <WorkspaceSky fade={0.4} style={StyleSheet.absoluteFill} />
        </View>
        <View style={styles.cover}>
          <WithPresence size={PHOTO + 6} presence={myPresence} ring={c.grouped}>
            <View style={[styles.ring, { borderColor: c.grouped }]}>
              <PersonAvatar name={name || "?"} size={PHOTO} photo={photo} />
            </View>
          </WithPresence>
          <Text variant="display2" numberOfLines={2} style={styles.center}>
            {name}
          </Text>
          {headline ? (
            <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.center}>
              {headline}
            </Text>
          ) : null}
        </View>

        <View style={styles.groups}>
          <GroupedHeader>{t("mobile.me.status")}</GroupedHeader>
          <GroupedList>
            <StatusRow />
          </GroupedList>

          <GroupedHeader>{t("mobile.me.workspace")}</GroupedHeader>
          <GroupedList>
            {org.org ? (
              <GroupedRow
                key="workspace"
                leading={<OrgAvatar logo={org.org.logo} size={36} />}
                label={org.org.name}
                sub={workspaceSub}
                // What's unread in the other workspaces (ADR 0154).
                {...(elsewhere > 0 ? { value: String(elsewhere) } : {})}
                chevron
                onPress={() => open("/me/workspaces")}
              />
            ) : null}
            <GroupedRow
              key="settings"
              icon="home"
              label={t("settings.title")}
              chevron
              onPress={() => open("/settings")}
            />
          </GroupedList>

          {myAgents.length > 0 ? (
            <>
              <GroupedHeader>{`${t("mobile.me.yourAgents")} · ${myAgents.length}`}</GroupedHeader>
              <GroupedList>
                {myAgents.slice(0, AGENTS_SHOWN).map((a) => (
                  <AgentRow key={a.id} agentId={a.id} name={a.name} role={a.role} />
                ))}
                {myAgents.length > AGENTS_SHOWN ? (
                  <GroupedRow
                    key="all"
                    icon="list"
                    label={t("mobile.me.allAgents")}
                    chevron
                    onPress={() => router.navigate("/agents" as never)}
                  />
                ) : null}
              </GroupedList>
            </>
          ) : null}

          <GroupedHeader>{t("mobile.me.work")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              key="issues"
              icon="checkc"
              label={t("mobile.me.issues")}
              {...(withMe > 0 ? { value: t("mobile.me.issuesWithMe", { count: withMe }) } : {})}
              {...(tasksUnread.mentions > 0 ? { valueLeading: <MentionCount count={tasksUnread.mentions} /> } : {})}
              chevron
              onPress={() => open("/issues")}
            />
            <GroupedRow
              key="proposals"
              icon="flag"
              label={t("shell.proposals")}
              {...(proposals > 0 ? { value: t("mobile.me.proposalsWaiting", { count: proposals }) } : {})}
              chevron
              onPress={() => open("/proposals")}
            />
            <GroupedRow
              key="routines"
              icon="clock"
              label={t("routines.title")}
              chevron
              onPress={() => open("/routines")}
            />
            <GroupedRow key="wiki" icon="file" label={t("wiki.title")} chevron onPress={() => open("/wiki")} />
            <GroupedRow key="drive" icon="doc" label={t("mobile.me.drive")} chevron onPress={() => open("/drive")} />
            <GroupedRow
              key="dashboards"
              icon="chart"
              label={t("mobile.me.dashboards")}
              chevron
              onPress={() => open("/dashboards")}
            />
            <GroupedRow
              key="memory"
              icon="brain"
              label={t("mobile.memory.title")}
              chevron
              onPress={() => open("/memory")}
            />
          </GroupedList>

          <GroupedHeader>{t("mobile.me.preferences")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              key="notifications"
              icon="bell"
              label={t("mobile.me.notifications")}
              {...(push === null ? {} : { value: push ? t("mobile.me.on") : t("mobile.me.off") })}
              chevron
              onPress={() => open("/me/notifications")}
            />
            {/* Who approves for me, and whom I approve for (ADR 0139). */}
            <GroupedRow
              key="approvals"
              icon="shield"
              label={t("settings.section.approvals")}
              chevron
              onPress={() => open("/me/approvals")}
            />
            {/* A server from before the choice sends none and can't keep one (`PUT …/me/start` answers 404). */}
            {org.org?.start !== undefined ? (
              <GroupedRow
                key="start"
                icon="home"
                label={t("mobile.me.start")}
                value={startLabel}
                chevron
                onPress={() => open("/me/start")}
              />
            ) : null}
            {/* Likewise: a server from before the choice sends no `showActivity`. */}
            {org.org?.showActivity !== undefined ? (
              <GroupedRow
                key="activity"
                icon="eye"
                label={t("mobile.me.activity")}
                value={org.org.showActivity ? t("mobile.me.on") : t("mobile.me.off")}
                chevron
                onPress={() => open("/me/activity")}
              />
            ) : null}
            {/* Likewise: a server from before the choice sends no `chatPrefs`. */}
            {org.org?.chatPrefs !== undefined ? (
              <GroupedRow
                key="chat"
                icon="text"
                label={t("settings.account.chat.title")}
                chevron
                onPress={() => open("/me/chat-look")}
              />
            ) : null}
            {/* Likewise: a server from before the choice sends no `agentStyle` (ADR 0147). */}
            {org.org?.agentStyle !== undefined ? (
              <GroupedRow
                key="agentStyle"
                icon="agent"
                label={t("mobile.me.agentStyle")}
                value={
                  org.org.agentStyle === "technical"
                    ? t("settings.account.agentStyleTechnical")
                    : t("settings.account.agentStyleSimple")
                }
                chevron
                onPress={() => open("/me/agent-style")}
              />
            ) : null}
            <GroupedRow
              key="sounds"
              icon="sound"
              label={t("mobile.me.sounds")}
              value={soundValue}
              menu
              onPress={pickSound}
            />
            <GroupedRow
              key="appearance"
              icon={theme.scheme === "dark" ? "moon" : "sun"}
              label={t("mobile.me.appearance")}
              value={themeValue}
              menu
              onPress={pickTheme}
            />
            <GroupedRow
              key="language"
              icon="globe"
              label={t("mobile.me.language")}
              value={isAppLocale(i18n.language) ? localeInfo(i18n.language).native : i18n.language}
              chevron
              onPress={() => open("/me/language")}
            />
            {about ? (
              <GroupedRow
                key="about"
                icon="info"
                label={t("settings.section.about")}
                chevron
                onPress={() => open("/me/about")}
              />
            ) : null}
          </GroupedList>

          <View style={styles.gapBig} />
          <GroupedList>
            <GroupedRow key="signOut" label={t("mobile.me.signOut")} danger onPress={confirmSignOut} />
          </GroupedList>
          {/* Sobre says the version; without it (a server that hides it), the version stays here. */}
          {!about && version ? <GroupedFooter>{t("mobile.me.version", { version })}</GroupedFooter> : null}
        </View>
      </Animated.ScrollView>
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} />
    </View>
  );
}

/** Your status as a row (ADR 0084): "Definir status" or how you appear, with when it clears; a tap pushes Status. */
function StatusRow() {
  const { t, i18n } = useTranslation();
  const me = useMyPerson();
  const presence = me?.presence ?? "offline";
  const status = me?.status ?? null;
  const label = status
    ? personLine(t, i18n.language || "en", status)
    : presence === "online"
      ? t("presence.setStatus")
      : t(`presence.${presence}`);
  return <GroupedRow icon="smile" label={label} chevron onPress={openStatus} />;
}

/** One of your agents: its face in its sky at 36, its name, what it does now (its orbit turning) or its role. */
function AgentRow({ agentId, name, role }: { agentId: string; name: string; role: string | null | undefined }) {
  const dir = useDirectory();
  const shown = usePresenceOf().agent(agentId);
  const working = shown?.presence === "busy" && shown.line ? shown.line.text : null;
  const look = agentLook(dir.agentById.get(agentId));
  return (
    <GroupedRow
      leading={<AgentFace agentId={agentId} size={36} />}
      label={name}
      {...(working ? { below: <WorkingLine color={look.color} text={working} /> } : role ? { sub: role } : {})}
      chevron
      onPress={() => open(`/agent/${agentId}`)}
    />
  );
}

/** What a working agent does, in words with its orbit, never a label. */
function WorkingLine({ color, text }: { color: Parameters<typeof PixelOrbit>[0]["color"]; text: string }) {
  return (
    <View style={styles.working}>
      <PixelOrbit color={color} size={11} />
      <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.shrink}>
        {text}
      </Text>
    </View>
  );
}


const styles = StyleSheet.create({
  fill: { flex: 1 },
  band: { overflow: "hidden" },
  cover: { alignItems: "center", gap: 6, marginTop: -PHOTO_OVERLAP, paddingHorizontal: 16 },
  // A ring in the page's color lifts the photo off the sky.
  ring: { borderRadius: 999, borderWidth: 3 },
  center: { textAlign: "center" },
  groups: { paddingHorizontal: 16, paddingTop: 4 },
  gapBig: { height: 24 },
  working: { flexDirection: "row", alignItems: "center", gap: 4 },
  shrink: { flexShrink: 1, minWidth: 0 },
});
