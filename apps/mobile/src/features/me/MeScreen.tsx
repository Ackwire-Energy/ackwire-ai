import { useAiAccounts, useCredentials, useIssues, useJoinRequests, useMe } from "@agenteschat/client";
import { groupPlans, ownSignIns, planWordOf } from "@agenteschat/client/lib/ai-accounts";
import { can } from "@agenteschat/client/lib/permissions";
import { SOUND_STYLES, type SoundStyle } from "@agenteschat/ui/sfx";
import Constants from "expo-constants";
import { router, useNavigation } from "expo-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, BackHandler, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { SlideInLeft, SlideInRight } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signOut } from "@/features/account";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { pushPermission, unregisterPush } from "@/lib/push";
import { serverUrl } from "@/lib/server";
import { setSoundChoice, useSoundChoice } from "@/lib/sounds";
import { readValue, STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { usePush } from "@/providers/push";
import { WorkspaceSky } from "@/sky/Sky";
import {
  Button,
  Count,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  IconButton,
  type IconName,
  PersonAvatar,
  ProviderLogo,
  Text,
  type ThemePreference,
  useTheme,
  useToast,
  weights,
} from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { MembersPage } from "../members/MembersPage";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { usePersonPhoto } from "../shared/photo";
import { PlanMeter } from "../usage/parts";
import { AccountPage, ZonePage } from "./AccountPage";
import { type AccountDraft, openIssuesWithMe } from "./logic";
import { Page } from "./parts";

/** The screens of the page (its own stack: tap a row, the next one slides in; back slides it out). */
export type MePage =
  | "root"
  | "account"
  | "zone"
  | "workspaces"
  | "members"
  | "notifications"
  | "sounds"
  | "appearance"
  | "language";

const SOUND_LABELS: Record<SoundStyle, string> = {
  tactile: "mobile.me.soundTactile",
  sky: "mobile.me.soundSky",
  pixel: "mobile.me.soundPixel",
};

/** Opens a screen over this page (back comes here). */
const open = (href: string) => router.push(href as never);

/**
 * Você, a page pushed from the avatar, in Conversas' language: the workspace's sky with your photo, name, @ and role,
 * "Editar perfil" and "Trocar workspace"; your agents, alive; what they think with (the plans, the computers' own
 * sign-ins, each with its usage in pixels); "Do workspace" and the preferences as loose rows; Sair and the version.
 * The rows open its own small stack (Conta, Workspaces, Membros, Notificações, Sons, Aparência, Idioma) or a screen
 * over it.
 */
export function MeScreen({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const theme = useTheme();
  const toast = useToast();
  const { ask: askPush } = usePush();
  const dir = useDirectory();
  const issues = useIssues(org.orgId);
  const admin = can(org.org?.role, "manage_credentials");
  const credentials = useCredentials(org.orgId, admin);
  const liveKeys = (credentials.data ?? []).filter((k) => !k.revokedAt).length;
  // What the agents think with: the computers' own sign-ins and the person's accounts ("Contas de IA" counts them,
  // then the API keys).
  const ai = useAiAccounts(org.orgId);
  const own = ownSignIns(ai.data);
  const accounts = groupPlans(ai.data?.accounts ?? []);
  const plans = own.length + accounts.length;
  const c = useColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  // Membros, for whoever manages them (the requests to join and the invitation link live there).
  const manager = can(org.org?.role, "manage_members");
  const requests = useJoinRequests(org.orgId, manager);
  const waiting = requests.data?.length ?? 0;
  const [stack, setStack] = useState<MePage[]>(["root"]);
  const [forward, setForward] = useState(true);
  const [push, setPush] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const page = stack[stack.length - 1] ?? "root";
  const go = useCallback((next: MePage) => {
    setForward(true);
    setStack((s) => [...s, next]);
  }, []);
  const back = useCallback(() => {
    setForward(false);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);
  // Inside the page's own stack, back (the edge swipe on iOS, the system's on Android) goes one screen back.
  const inner = stack.length > 1;
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !inner });
  }, [navigation, inner]);
  useEffect(() => {
    if (!inner) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [inner, back]);

  useEffect(() => {
    let alive = true;
    void Promise.all([pushPermission(), readValue(STORED.pushToken)]).then(([permission, token]) => {
      if (alive) setPush(permission === "granted" && Boolean(token));
    });
    return () => {
      alive = false;
    };
  }, []);

  const setNotifications = async (on: boolean) => {
    setPush(on);
    if (on) {
      // Through the provider, so Conversas knows the phone was asked (our sheet won't open after this).
      const ok = await askPush();
      setPush(ok);
      if (!ok) toast({ title: t("mobile.me.pushOff"), subtitle: t("mobile.me.pushOffSub"), icon: "bell" });
    } else await unregisterPush();
  };

  const mine = meId ? dir.memberById.get(meId) : undefined;
  const name = me.data?.user.name ?? "";
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  const role = org.org ? t(`mobile.me.role.${org.org.role}`) : "";
  const themeLabel = t(`mobile.theme.${theme.preference}`);
  const sounds = useSoundChoice();
  const styleLabel = (style: SoundStyle) => t(SOUND_LABELS[style]);
  const en = i18n.language.startsWith("en");
  const withMe = openIssuesWithMe(issues.data, meId);
  const version = Constants.expoConfig?.version ?? "";

  const openAccount = () => {
    setDraft({ name, handle: mine?.handle ?? "", zone: mine?.timezone ?? null });
    go("account");
  };

  let body: ReactNode;
  switch (page) {
    case "account":
      body = draft ? (
        <AccountPage
          draft={draft}
          setDraft={setDraft}
          onBack={back}
          onZone={() => go("zone")}
          onDelete={() => open("/account-delete")}
        />
      ) : null;
      break;
    case "zone":
      body = draft ? (
        <ZonePage
          value={draft.zone}
          onBack={back}
          onPick={(zone) => {
            setDraft({ ...draft, zone });
            back();
          }}
        />
      ) : null;
      break;
    case "workspaces":
      body = (
        <Page title={t("mobile.me.workspaces")} onBack={back}>
          <GroupedHeader>{t("mobile.me.workspacesIn")}</GroupedHeader>
          <GroupedList>
            {org.orgs.map((o) => (
              <GroupedRow
                key={o.id}
                leading={<OrgTile name={o.name} logo={o.logo} />}
                label={o.name}
                checked={o.id === org.orgId}
                onPress={() => {
                  if (o.id === org.orgId) return;
                  org.setOrgId(o.id);
                  router.dismissTo("/");
                }}
              />
            ))}
          </GroupedList>
        </Page>
      );
      break;
    case "members":
      body = <MembersPage onBack={back} onRequests={() => open("/join-requests")} />;
      break;
    case "notifications":
      body = (
        <Page title={t("mobile.me.notifications")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              label={t("mobile.me.notificationsPhone")}
              toggle={push ?? false}
              onPress={() => void setNotifications(!(push ?? false))}
            />
          </GroupedList>
          <GroupedFooter>{t("mobile.me.notificationsHint")}</GroupedFooter>
        </Page>
      );
      break;
    case "sounds":
      body = (
        <Page title={t("mobile.me.sounds")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              label={t("mobile.me.soundsOn")}
              toggle={sounds !== "off"}
              onPress={() => setSoundChoice(sounds === "off" ? "tactile" : "off")}
            />
          </GroupedList>
          <GroupedFooter>{t("mobile.me.soundsHint")}</GroupedFooter>
          {sounds !== "off" && (
            <>
              <GroupedHeader>{t("mobile.me.soundStyle")}</GroupedHeader>
              <GroupedList>
                {SOUND_STYLES.map((style) => (
                  <GroupedRow
                    key={style}
                    label={styleLabel(style)}
                    checked={sounds === style}
                    onPress={() => setSoundChoice(style)}
                  />
                ))}
              </GroupedList>
            </>
          )}
        </Page>
      );
      break;
    case "appearance":
      body = (
        <Page title={t("mobile.me.appearance")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            {(["system", "light", "dark"] as const).map((key) => (
              <GroupedRow
                key={key}
                label={t(`mobile.theme.${key}`)}
                checked={theme.preference === key}
                onPress={() => theme.setPreference(key as ThemePreference)}
              />
            ))}
          </GroupedList>
        </Page>
      );
      break;
    case "language":
      body = (
        <Page title={t("mobile.me.language")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow label={t("mobile.me.langPt")} checked={!en} onPress={() => void i18n.changeLanguage("pt-BR")} />
            <GroupedRow label={t("mobile.me.langEn")} checked={en} onPress={() => void i18n.changeLanguage("en")} />
          </GroupedList>
        </Page>
      );
      break;
    default: {
      const myAgents = dir.agents.filter((a) => a.ownerUserId === meId);
      const headline = [mine?.handle ? `@${mine.handle}` : null, role, org.org?.name].filter(Boolean).join(" · ");
      const workspaceRows: { icon: IconName; label: string; value?: string; href?: string; page?: MePage }[] = [
        ...(manager
          ? [
              {
                icon: "members" as const,
                label: t("members.title"),
                ...(waiting > 0 ? { value: t("mobile.members.waiting", { count: waiting }) } : {}),
                page: "members" as const,
              },
            ]
          : []),
        {
          icon: "checkc",
          label: t("mobile.me.issues"),
          ...(withMe > 0 ? { value: t("mobile.me.issuesWithMe", { count: withMe }) } : {}),
          href: "/issues",
        },
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
      const prefRows: { icon: IconName; label: string; value?: string; page: MePage }[] = [
        {
          icon: "bell",
          label: t("mobile.me.notifications"),
          ...(push === null ? {} : { value: push ? t("mobile.me.on") : t("mobile.me.off") }),
          page: "notifications",
        },
        {
          icon: "sound",
          label: t("mobile.me.sounds"),
          value: sounds === "off" ? t("mobile.me.soundsOff") : styleLabel(sounds),
          page: "sounds",
        },
        {
          icon: theme.scheme === "dark" ? "moon" : "sun",
          label: t("mobile.me.appearance"),
          value: themeLabel,
          page: "appearance",
        },
        {
          icon: "globe",
          label: t("mobile.me.language"),
          value: en ? t("mobile.me.langEn") : t("mobile.me.langPt"),
          page: "language",
        },
      ];
      body = (
        <ScrollView
          style={styles.fill}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}
        >
          {/* The workspace's sky, as on Conversas, reaching up behind the status bar. */}
          <View style={[styles.band, { paddingTop: insets.top + 62 }]}>
            <WorkspaceSky fade={0.4} style={StyleSheet.absoluteFill} />
            <View style={styles.meLine}>
              <View style={[styles.ring, { borderColor: c.bg }]}>
                <PersonAvatar name={name || "?"} size={68} photo={photo} />
              </View>
              <View style={styles.grow}>
                <Text variant="display2" numberOfLines={2}>
                  {name}
                </Text>
                {headline ? (
                  <Text variant="small" tone="muted" numberOfLines={1}>
                    {headline}
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={styles.acts}>
              <Button
                size="sm"
                variant="secondary"
                icon="pen"
                label={t("mobile.me.editProfile")}
                onPress={openAccount}
              />
              {org.orgs.length > 1 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  label={t("mobile.me.switchWorkspace")}
                  onPress={() => go("workspaces")}
                />
              ) : null}
            </View>
          </View>

          {myAgents.length > 0 ? (
            <>
              <Section title={t("mobile.me.yourAgents")} count={myAgents.length} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crew}>
                {myAgents.map((a) => (
                  <Pressable
                    key={a.id}
                    onPress={() => open(`/agent/${a.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={a.name}
                    style={styles.crewItem}
                  >
                    <AgentFace agentId={a.id} size={52} />
                    <Text variant="caption" tone="ink2" numberOfLines={1}>
                      {a.name}
                    </Text>
                  </Pressable>
                ))}
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
              </ScrollView>
            </>
          ) : null}

          <Section title={t("mobile.me.thinksWith")} {...(plans > 0 ? { count: plans } : {})} />
          {own.map((o, i) => (
            <PlanRow
              key={o.key}
              logo={o.kind}
              title={[t(`aiAccounts.connect.${o.kind}`), planWordOf(o.plan)].filter(Boolean).join(" ")}
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
                title={first.label}
                sub={t("aiAccounts.page.on", { computer: first.computer })}
                usage={a.usage}
                divider={own.length + i > 0}
                onPress={() => open("/ai-accounts")}
              />
            );
          })}
          {plans === 0 ? (
            <PageRow icon="plus" label={t("aiAccounts.page.connect")} onPress={() => openConnectAi()} />
          ) : null}

          <Section title={t("mobile.me.fromWorkspace")} />
          {workspaceRows.map((r, i) => (
            <PageRow
              key={r.label}
              icon={r.icon}
              label={r.label}
              value={r.value}
              divider={i > 0}
              onPress={() => (r.page ? go(r.page) : r.href ? open(r.href) : undefined)}
            />
          ))}

          <Section title={t("mobile.me.preferences")} />
          {prefRows.map((r, i) => (
            <PageRow
              key={r.page}
              icon={r.icon}
              label={r.label}
              value={r.value}
              divider={i > 0}
              onPress={() => go(r.page)}
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
                    onClose();
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
        </ScrollView>
      );
      break;
    }
  }

  return (
    // The page is white like Conversas; its inner screens sit on the grouped gray, as settings do.
    <View style={[styles.fill, { backgroundColor: page === "root" ? c.bg : c.grouped }]}>
      <Animated.View
        key={`${stack.length}-${page}`}
        entering={
          theme.reducedMotion || (stack.length === 1 && forward)
            ? undefined
            : forward
              ? SlideInRight.duration(260)
              : SlideInLeft.duration(260)
        }
        style={styles.fill}
      >
        {body}
      </Animated.View>
      {page === "root" ? (
        <View style={[styles.backPlate, { top: insets.top + 6 }]}>
          <IconButton icon="back" plate label={t("mobile.common.back")} onPress={onClose} />
        </View>
      ) : null}
    </View>
  );
}

/** A section's head, as Conversas' ("Agentes 4"): the title and its count, faint. */
function Section({ title, count }: { title: string; count?: number }) {
  const c = useColors();
  return (
    <View style={styles.section}>
      <Text variant="small" tone="ink" style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      {count !== undefined ? <Count value={count} size={15} weight={weights.medium} color={c.faint} /> : null}
    </View>
  );
}

/** A loose row, as Conversas' (the hairline starts at the text): a tile, the label, a value, the chevron. */
function PageRow({
  icon,
  leading,
  label,
  value,
  below,
  onPress,
  divider = false,
  danger = false,
  chevron = true,
}: {
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  value?: string | undefined;
  below?: ReactNode;
  onPress: () => void;
  divider?: boolean;
  danger?: boolean;
  chevron?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.rowLine, { backgroundColor: c.line2 }]} /> : null}
      {leading ?? (icon ? <Tile icon={icon} size={36} /> : null)}
      <View style={styles.grow}>
        <Text variant="body" tone={danger ? "danger" : "ink"} numberOfLines={1}>
          {label}
        </Text>
        {below}
      </View>
      {value ? (
        <Text variant="body" tone="faint" numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {chevron ? <Icon name="right" size={15} color={c.faint} /> : null}
    </Pressable>
  );
}

/** A plan the agents think with: its maker's mark, its name, its usage in pixels and where it is. */
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
  sub: string;
  usage: Parameters<typeof PlanMeter>[0]["usage"] | null;
  divider: boolean;
  onPress: () => void;
}) {
  return (
    <PageRow
      leading={
        <Tile size={36}>
          <ProviderLogo id={logo} size="sm" />
        </Tile>
      }
      label={title}
      divider={divider}
      onPress={onPress}
      below={
        <>
          {usage ? (
            <View style={styles.meter}>
              <PlanMeter usage={usage} compact />
            </View>
          ) : null}
          <Text variant="footnote" tone="muted" numberOfLines={1}>
            {sub}
          </Text>
        </>
      }
    />
  );
}

/** A workspace: its logo, or its initial on a neutral tile. */
function OrgTile({ name, logo }: { name: string; logo?: string | null | undefined }) {
  const c = useColors();
  const source = photoSource(logo, serverUrl(), appHeaders(lastCookie()));
  if (source) return <Image source={source} style={styles.org} accessibilityIgnoresInvertColors />;
  return (
    <View style={[styles.org, { backgroundColor: c.ink2 }]}>
      <Text variant="label" style={{ color: c.bg }}>
        {(name.trim()[0] ?? "?").toLocaleUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  gap: { height: 14 },
  gapBig: { height: 22 },
  backPlate: { position: "absolute", left: 16 },
  band: { paddingHorizontal: 20, paddingBottom: 18, overflow: "hidden" },
  meLine: { flexDirection: "row", alignItems: "center", gap: 14 },
  // A ring in the page's color lifts the photo off the sky.
  ring: { borderRadius: 40, borderWidth: 3 },
  acts: { flexDirection: "row", gap: 8, marginTop: 16 },
  section: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 22,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  sectionTitle: { fontWeight: "600", flexShrink: 1 },
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  // From the text column: 20 + the 36 tile + 13.
  rowLine: { position: "absolute", top: 0, right: 0, left: 69, height: StyleSheet.hairlineWidth },
  value: { maxWidth: "45%" },
  meter: { marginTop: 6, marginBottom: 3 },
  version: { paddingHorizontal: 20, paddingTop: 14 },
  org: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
