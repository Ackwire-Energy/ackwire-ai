import {
  keys,
  type Memory,
  useAgentAccess,
  useAgentDetail,
  useAgentForYou,
  useApi,
  useMemoryAboutMe,
  useMemoryAction,
  useUsage,
} from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  AgentAvatar,
  Button,
  Card,
  Icon,
  type IconName,
  PixelOrbit,
  Row,
  Section,
  Sky,
  SpendBar,
  Text,
  useToast,
} from "@/ui";
import { CoverParallax, useCoverScroll, useScrollFade } from "@/ui/cover";
import { AgentBrowserRow } from "../browser/AgentBrowserRow";
import { chatHref } from "../links/logic";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { PushedHeader, Tile } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import {
  canEditMemories,
  type DidLine,
  dayWord,
  didLines,
  knownAboutMe,
  memoryOrigin,
  plainRole,
  spendOf,
  usesOf,
} from "./logic";
import { workTitle } from "./work";

/** Rows of "O que fez por você" before "Ver tudo". */
const DID_SHOWN = 4;

/** Built-in areas in "O que pode usar": their tile. */
const AREA_ICON: Record<string, IconName> = {
  context: "brain",
  drive: "drive",
  issues: "issue",
  calendar: "clock",
  wiki: "doc",
  skills: "sparkle",
  schedule: "clock",
  forum: "chat",
  sandbox: "laptop",
};

/**
 * An agent's profile as a teammate (MobileIntencional.html, "Perfil do agente"): its sky and living body, its
 * role in one plain sentence, who answers for it, what it is on now (or what waits on you), one button
 * (Conversar), then what it did for you, what it knows about you (tap to correct or forget, for its owner and
 * admins), what it can use in plain levels and the approval rule, and its month last.
 */
export function AgentProfileScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <Profile id={id} />
    </SheetHostProvider>
  );
}

function Profile({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const when = useWhen();
  const meId = useMeId();
  const role = useOrg().org?.role;
  const insets = useSafeAreaInsets();
  // The cover's sky lags behind the scroll and stretches on pull; the agent fades as it nears the bar.
  const { y, onScroll } = useCoverScroll();
  const underBar = AVATAR_TOP - (insets.top + BAR_HEIGHT);
  const avatarFade = useScrollFade(y, underBar - 30, underBar + 70);
  const agent = dir.agentById.get(id);
  const detail = useAgentDetail(orgId, id);
  const access = useAgentAccess(orgId, id);
  const usage = useUsage(orgId);
  const forYou = useAgentForYou(orgId, id);
  const knows = useMemoryAboutMe(orgId, id);
  const work = useWorkingNow().filter((w) => w.agentId === id);
  const asking = useWaitingApprovals().filter((a) => a.agentId === id);
  const waitingNow = asking[0];
  const [allDid, setAllDid] = useState(false);
  const look = agentLook(agent);
  const name = agent?.name ?? detail.data?.name ?? "";
  const g = genderOf(name);
  const ownerId = agent?.ownerUserId ?? null;
  const owner = ownerId ? dir.memberById.get(ownerId)?.name : undefined;
  const mine = Boolean(meId && ownerId === meId);
  const roleName = (agent?.role || detail.data?.role || "").trim();
  const plain = plainRole(agent?.instructions || detail.data?.instructions);
  const busy = work.length > 0;
  const editable = canEditMemories(agent, { id: meId, role });
  const decides = mine || can(role, "manage_agents");
  const did = didLines(forYou.data?.items);
  const memories = knownAboutMe(knows.data);
  const uses = usesOf(access.data);
  const spend = detail.data
    ? spendOf({
        budgetUsedPercent: detail.data.budgetUsedPercent,
        monthlyBudgetUsd: detail.data.monthlyBudgetUsd ?? null,
        ...(detail.data.defaultBudgetUsd !== undefined ? { defaultBudgetUsd: detail.data.defaultBudgetUsd } : {}),
        usage: usage.data?.find((u) => u.agentId === id) ?? null,
      })
    : null;
  const money = (v: number) =>
    new Intl.NumberFormat(i18n.language || "pt-BR", { style: "currency", currency: "USD" }).format(v);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(when.locale, { day: "numeric", month: "short" }).format(new Date(iso)).replace(".", "");
  const dayText = (iso: string) => {
    const d = dayWord(iso);
    return d.kind === "date"
      ? t("mobile.intentAgents.knows.when.date", { date: date(iso) })
      : t(`mobile.intentAgents.knows.when.${d.kind}`);
  };
  const originText = (m: Memory) => {
    const o = memoryOrigin(m, meId);
    switch (o.kind) {
      case "saidDm":
        return t("mobile.intentAgents.knows.saidDm", { when: dayText(o.at) });
      case "saidChannel":
        return o.channel
          ? t("mobile.intentAgents.knows.saidChannel", { channel: o.channel, date: date(o.at) })
          : t("mobile.intentAgents.knows.saidSomewhere", { date: date(o.at) });
      case "wrote":
        return t("mobile.intentAgents.knows.wrote", { date: date(o.at) });
      case "learned":
        return t("mobile.intentAgents.knows.learned", { date: date(o.at) });
    }
  };

  const openDm = () =>
    api.dms
      .open(orgId, { agentId: id })
      .then(({ channelId }) => {
        void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
        router.push(chatHref(channelId));
      })
      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }));

  const open = (href: DidLine["href"]) => {
    if (!href) return;
    if (href.kind === "issue") router.push(`/issues/${href.number}`);
    else if (href.kind === "chat") router.push(chatHref(href.channelId, href.threadId));
    else if (href.kind === "file") router.push({ pathname: "/file/[id]", params: { id: href.id } });
    else router.push(`/approval/${href.id}`);
  };

  const fix = (m: Memory) =>
    sheet.open(
      <MemoryFix
        memory={m}
        agentId={id}
        agentName={name}
        g={g}
        source={m.from ? t("mobile.intentAgents.fix.from", { when: when.short(m.from.at) }) : originText(m)}
        onSee={
          m.from
            ? () => {
                const from = m.from;
                sheet.close();
                if (from) router.push(chatHref(from.channelId, from.threadId));
              }
            : undefined
        }
        onDone={sheet.close}
      />,
    );

  const ownerLine = mine
    ? t("mobile.intentAgents.ownerYou")
    : owner
      ? t("mobile.intentAgents.owner", { name: owner })
      : null;
  const roleLine = [
    roleName || null,
    plain ? (roleName ? plain.charAt(0).toLowerCase() + plain.slice(1) : plain) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shownDid = allDid ? did : did.slice(0, DID_SHOWN);

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        // The browser card's own text field: its buttons and the page take a tap with the keyboard up.
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      >
        <View style={[styles.cover, { paddingTop: insets.top + 56 }]}>
          <CoverParallax y={y} style={StyleSheet.absoluteFill}>
            <Sky color={look.color} depth={1} style={StyleSheet.absoluteFill} />
          </CoverParallax>
          <Animated.View style={avatarFade}>
            <AgentAvatar agent={look} size={104} mode={busy ? "run" : "idle"} />
          </Animated.View>
        </View>
        <View style={styles.prof}>
          <Text variant="display" style={styles.center}>
            {name}
          </Text>
          {roleLine ? (
            <Text variant="body" tone="ink2" style={styles.center}>
              {roleLine}
            </Text>
          ) : null}
          {ownerLine ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {ownerLine}
            </Text>
          ) : null}
          {waitingNow ? (
            <NowPill
              leading={<Icon name="shield" size={15} color={c.amber} />}
              label={t("mobile.intentAgents.nowWaiting", { title: waitingNow.title })}
              onPress={() => router.push(`/approval/${waitingNow.id}`)}
            />
          ) : null}
          {work.map((w) => (
            <NowPill
              key={w.key}
              leading={<PixelOrbit color={look.color} size={14} />}
              label={workTitle(t, w)}
              onPress={() =>
                w.missionId ? router.push(`/mission/${w.missionId}`) : router.push(chatHref(w.channelId, w.threadId))
              }
            />
          ))}
          <View style={styles.acts}>
            <Button
              variant="primary"
              wide
              icon="chat"
              label={t("mobile.agent.talk")}
              disabled={agent?.canTalk === false}
              onPress={() => void openDm()}
            />
          </View>
          {agent?.canTalk === false ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {t("mobile.agent.cantTalk")}
            </Text>
          ) : null}
        </View>

        {forYou.data || forYou.isError ? (
          <Section
            title={t("mobile.intentAgents.did.title")}
            {...(did.length > DID_SHOWN
              ? {
                  action: {
                    label: allDid ? t("mobile.intentAgents.did.seeLess") : t("mobile.intentAgents.did.seeAll"),
                    onPress: () => setAllDid((v) => !v),
                  },
                }
              : {})}
          >
            {forYou.data && forYou.data.monthCount > 0 ? (
              <Text variant="small" tone="muted" style={styles.lead}>
                {t("mobile.intentAgents.did.month", { count: forYou.data.monthCount })}
              </Text>
            ) : null}
            {did.length > 0 ? (
              <Card>
                {shownDid.map((l) => (
                  <Row
                    key={l.key}
                    leading={<Tile icon={l.icon} />}
                    title={t(`mobile.intentAgents.did.${l.title.key}`, l.title.values)}
                    subtitle={
                      l.sub
                        ? "text" in l.sub
                          ? l.sub.text
                          : t(`mobile.intentAgents.did.${l.sub.key}`, l.sub.values ?? {})
                        : undefined
                    }
                    meta={
                      <Text variant="small" tone="faint">
                        {when.short(l.at)}
                      </Text>
                    }
                    {...(l.href ? { onPress: () => open(l.href) } : {})}
                  />
                ))}
              </Card>
            ) : (
              <Text variant="small" tone="muted" style={styles.foot}>
                {t(`mobile.intentAgents.did.empty${g}`, { name })}
              </Text>
            )}
          </Section>
        ) : null}

        {knows.data ? (
          <Section title={t("mobile.intentAgents.knows.title")}>
            {memories.length > 0 ? (
              <>
                <Card>
                  {memories.map((m) => (
                    <Row
                      key={m.id}
                      leading={<Tile icon="brain" />}
                      title={m.text}
                      subtitle={originText(m)}
                      chevron={editable}
                      {...(editable ? { onPress: () => fix(m) } : {})}
                    />
                  ))}
                </Card>
                <Text variant="small" tone="muted" style={styles.foot}>
                  {editable
                    ? t(`mobile.intentAgents.knows.foot${g}`)
                    : owner
                      ? t("mobile.intentAgents.knows.footOwner", { name: owner })
                      : t("mobile.intentAgents.knows.footAdmins")}
                </Text>
              </>
            ) : (
              <Text variant="small" tone="muted" style={styles.foot}>
                {t(`mobile.intentAgents.knows.empty${g}`, { name })}
              </Text>
            )}
          </Section>
        ) : null}

        <AgentBrowserRow agentId={id} decides={decides} busy={busy} />

        {access.data ? (
          <Section title={t("mobile.intentAgents.uses.title")}>
            {uses.lines.length > 0 ? (
              <Card>
                {uses.lines.map((u) => (
                  <Row
                    key={u.key}
                    leading={
                      "area" in u.label ? (
                        <Tile icon={AREA_ICON[u.label.area] ?? "doc"} />
                      ) : (
                        <Tile>
                          <Text variant="body" tone="muted" style={{ fontWeight: "600" }}>
                            {u.label.text.trim().charAt(0).toUpperCase()}
                          </Text>
                        </Tile>
                      )
                    }
                    title={
                      "area" in u.label
                        ? t(`mobile.intentAgents.uses.area.${u.label.area}`, { defaultValue: u.label.area })
                        : u.label.text
                    }
                    meta={
                      <Text variant="small" tone="muted">
                        {t(`mobile.intentAgents.uses.level.${u.level}`)}
                      </Text>
                    }
                  />
                ))}
              </Card>
            ) : (
              <Text variant="small" tone="muted" style={styles.foot}>
                {t("mobile.intentAgents.uses.empty")}
              </Text>
            )}
            {uses.asks ? (
              <Text variant="small" tone="muted" style={styles.foot}>
                {decides
                  ? t("mobile.intentAgents.uses.asksYou")
                  : owner
                    ? t("mobile.intentAgents.uses.asksOwner", { name: owner })
                    : t("mobile.intentAgents.uses.asksAdmins")}
              </Text>
            ) : null}
          </Section>
        ) : null}

        {spend ? (
          <Section title={t("mobile.agent.month")}>
            <Card>
              <View style={styles.spend}>
                <View style={styles.spendHead}>
                  {spend.kind === "money" ? (
                    <>
                      <Text variant="body" tone="ink2">
                        {money(spend.spentUsd)}
                      </Text>
                      <Text variant="small" tone="muted">
                        {t("mobile.agent.ofBudget", { budget: money(spend.budgetUsd) })}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text variant="body" tone="ink2">
                        {t("mobile.agent.percent", { percent: spend.percent })}
                      </Text>
                      <Text variant="small" tone="muted">
                        {t("mobile.agent.ofLimit")}
                      </Text>
                    </>
                  )}
                </View>
                <SpendBar color={look.color} value={spend.fraction} />
                {spend.fraction >= 1 ? (
                  <View style={styles.warn}>
                    <Icon name="clock" size={14} color={c.muted} />
                    <Text variant="caption" tone="muted">
                      {t(`mobile.agent.exhausted${g}`, { name })}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Card>
          </Section>
        ) : null}
      </Animated.ScrollView>
      <View style={styles.bar} pointerEvents="box-none">
        <PushedHeader plate solid={false} />
      </View>
    </View>
  );
}

/** What it is on now (`.nowp`): one line that opens the place (the request, the conversation, the mission). */
function NowPill({ leading, label, onPress }: { leading: ReactNode; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.now, { backgroundColor: pressed ? c.sunken : c.raised, borderColor: c.line }]}
    >
      {leading}
      <Text variant="small" tone="ink2" numberOfLines={1} style={styles.nowText}>
        {label}
      </Text>
      <Icon name="right" size={14} color={c.faint} />
    </Pressable>
  );
}

/** "Corrigir uma memória": edit the text (the old one stays in the history) or forget it (archived). */
function MemoryFix({
  memory: m,
  agentId,
  agentName,
  g,
  source,
  onSee,
  onDone,
}: {
  memory: Memory;
  agentId: string;
  agentName: string;
  g: string;
  source: string;
  onSee: (() => void) | undefined;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const toast = useToast();
  const action = useMemoryAction(orgId, agentId);
  const [text, setText] = useState(m.text);
  const changed = text.trim() !== "" && text.trim() !== m.text.trim();
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const save = () =>
    action.mutate(
      { type: "edit", id: m.id, text: text.trim() },
      {
        onSuccess: () => {
          toast({ title: t("mobile.intentAgents.fix.saved"), agentId });
          onDone();
        },
        onError: failed,
      },
    );
  const forget = () =>
    action.mutate(
      { type: "archive", id: m.id, archived: true },
      {
        onSuccess: () => {
          toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId });
          onDone();
        },
        onError: failed,
      },
    );
  return (
    <>
      <SheetTitle title={t(`mobile.intentAgents.fix.title${g}`, { name: agentName })} />
      <TextArea value={text} onChangeText={setText} autoFocus maxLength={8000} />
      <View style={styles.src}>
        <Icon name="chat" size={14} color={c.muted} />
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.grow}>
          {source}
        </Text>
        {onSee ? (
          <Pressable onPress={onSee} accessibilityRole="link" hitSlop={8}>
            <Text variant="small" tone="ink2" style={styles.bold}>
              {t("mobile.intentAgents.fix.see")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text variant="small" tone="muted">
        {t(`mobile.intentAgents.fix.fine${g}`, { name: agentName })}
      </Text>
      <Button
        variant="primary"
        wide
        icon="check"
        label={t("mobile.intentAgents.fix.save")}
        disabled={!changed || action.isPending}
        onPress={save}
      />
      <Button
        variant="ghost"
        wide
        label={t("mobile.intentAgents.fix.forget")}
        disabled={action.isPending}
        onPress={forget}
      />
    </>
  );
}

/** Height of the sky cover. */
const COVER_HEIGHT = 300;
/** Where the agent's top sits in the cover (bottom padding 22, avatar 104), and the bar's height. */
const AVATAR_TOP = COVER_HEIGHT - 22 - 104;
const BAR_HEIGHT = 44;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { position: "absolute", top: 0, left: 0, right: 0 },
  // Not clipped: on a pull the sky grows up into the gap above the content.
  cover: { height: COVER_HEIGHT, alignItems: "center", justifyContent: "flex-end", paddingBottom: 22 },
  prof: { paddingHorizontal: 24, gap: 4 },
  center: { textAlign: "center" },
  acts: { marginTop: 14 },
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  now: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 8,
    marginTop: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "100%",
  },
  nowText: { flexShrink: 1, fontWeight: "500" },
  lead: { paddingHorizontal: 4, marginTop: -6, marginBottom: 10 },
  foot: { paddingHorizontal: 4, marginTop: 8 },
  src: { flexDirection: "row", alignItems: "center", gap: 6 },
  spend: { padding: 14, gap: 10 },
  spendHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  warn: { flexDirection: "row", alignItems: "center", gap: 6 },
});
