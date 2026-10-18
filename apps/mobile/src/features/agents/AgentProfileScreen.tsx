import { keys, useAgentAccess, useAgentDetail, useApi, useUsage } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar, Button, Card, Chip, Icon, PixelOrbit, Row, Section, Sky, SpendBar, Text, useToast } from "@/ui";
import { CoverParallax, useCoverScroll, useScrollFade } from "@/ui/cover";
import { chatHref } from "../links/logic";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { PushedHeader, Tile } from "../shared/parts";
import { useWorkingNow } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { canUse, spendOf } from "./logic";
import { workTitle } from "./work";

/**
 * An agent's profile: its sky and living body, Conversar / Tarefa, what it is
 * on now, what it does, what it may use, and its month (money only when the
 * API shows it to this person, else the share of its budget).
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
  const insets = useSafeAreaInsets();
  // The cover's sky lags behind the scroll and stretches on pull; the agent fades as it nears the bar.
  const { y, onScroll } = useCoverScroll();
  const underBar = AVATAR_TOP - (insets.top + BAR_HEIGHT);
  const avatarFade = useScrollFade(y, underBar - 30, underBar + 70);
  const agent = dir.agentById.get(id);
  const detail = useAgentDetail(orgId, id);
  const access = useAgentAccess(orgId, id);
  const usage = useUsage(orgId);
  const work = useWorkingNow().filter((w) => w.agentId === id);
  const look = agentLook(agent);
  const name = agent?.name ?? detail.data?.name ?? "";
  const g = genderOf(name);
  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  const role = agent?.role || detail.data?.role || "";
  const busy = work.length > 0;
  const tools = canUse(access.data);
  const channels = detail.data?.channels ?? [];
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

  const openDm = (then?: (channelId: string) => Promise<unknown>) =>
    api.dms
      .open(orgId, { agentId: id })
      .then(async ({ channelId }) => {
        if (then) await then(channelId);
        void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
        router.push(chatHref(channelId));
      })
      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }));

  const task = () =>
    sheet.open(
      <PromptForm
        leading={<AgentAvatar agent={look} size={32} />}
        title={t(`mobile.agent.taskFor${g}`, { name })}
        placeholder={t("mobile.agent.taskPlaceholder")}
        submitLabel={t("mobile.agent.sendTask")}
        icon="target"
        onSubmit={(text) => {
          sheet.close();
          return openDm((channelId) =>
            api.chat
              .post(orgId, channelId, { body: text })
              .then(() => toast({ title: t("mobile.agent.taskSent"), agentId: id })),
          );
        }}
      />,
    );

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
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
          <Text variant="body" tone="muted" style={styles.center}>
            {[role, owner ? t("mobile.agent.owner", { name: owner }) : null].filter(Boolean).join(" · ")}
          </Text>
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                icon="chat"
                label={t("mobile.agent.talk")}
                disabled={agent?.canTalk === false}
                onPress={() => void openDm()}
              />
            </View>
            <Button
              variant="secondary"
              icon="target"
              label={t("mobile.agent.task")}
              disabled={agent?.canTalk === false}
              onPress={task}
            />
          </View>
          {agent?.canTalk === false ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {t("mobile.agent.cantTalk")}
            </Text>
          ) : null}
        </View>

        <Section title={t("mobile.agent.now")}>
          <Card>
            {work.length > 0 ? (
              work.map((w) => (
                <Row
                  key={w.key}
                  leading={
                    <Tile>
                      <PixelOrbit color={look.color} size={16} />
                    </Tile>
                  }
                  title={workTitle(t, w)}
                  chevron
                  onPress={() =>
                    w.missionId
                      ? router.push(`/mission/${w.missionId}`)
                      : router.push(chatHref(w.channelId, w.threadId))
                  }
                />
              ))
            ) : (
              <Row
                leading={<Tile icon="moon" />}
                title={t("mobile.agents.free")}
                subtitle={t("mobile.agent.freeHint")}
              />
            )}
          </Card>
        </Section>

        {agent?.instructions || detail.data?.instructions ? (
          <Section title={t("mobile.agent.does")}>
            <Card>
              <Text variant="body" tone="ink2" style={styles.about} numberOfLines={8}>
                {agent?.instructions || detail.data?.instructions}
              </Text>
            </Card>
          </Section>
        ) : null}

        {tools.length > 0 || channels.length > 0 ? (
          <Section title={t("mobile.agent.canUse")}>
            <Card>
              <View style={styles.cans}>
                {tools.map((x) => (
                  <Chip key={x.key} icon={x.app ? "server" : "doc"} label={x.label} />
                ))}
                {channels.map((ch) => (
                  <Chip key={ch.id} icon="hash" label={ch.name} />
                ))}
              </View>
            </Card>
          </Section>
        ) : null}

        {spend ? (
          <Section title={t("mobile.agent.month")}>
            <Card>
              <View style={styles.spend}>
                <View style={styles.spendHead}>
                  {spend.kind === "money" ? (
                    <>
                      <Text variant="body" style={styles.bold}>
                        {money(spend.spentUsd)}
                      </Text>
                      <Text variant="small" tone="muted">
                        {t("mobile.agent.ofBudget", { budget: money(spend.budgetUsd) })}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text variant="body" style={styles.bold}>
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
  acts: { flexDirection: "row", gap: 8, marginTop: 14 },
  grow: { flex: 1 },
  bold: { fontWeight: "600" },
  about: { padding: 14 },
  cans: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 14 },
  spend: { padding: 14, gap: 10 },
  spendHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  warn: { flexDirection: "row", alignItems: "center", gap: 6 },
});
