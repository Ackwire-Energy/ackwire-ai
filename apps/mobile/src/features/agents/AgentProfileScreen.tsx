import {
  keys,
  type Memory,
  useAgentAccess,
  useAgentBrain,
  useAgentDetail,
  useAgentForYou,
  useAiStatus,
  useApi,
  useApprovalRules,
  useMemoryAboutMe,
  useMemoryAction,
  useModelLabel,
  useRemoveApprovalRule,
  useUsage,
} from "@agenteschat/client";
import { approvalRuleServer, approvalRuleWords } from "@agenteschat/client/lib/approval-words";
import { listsAgent, seesDetails } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { effortLevel } from "@agenteschat/client/lib/brain-advanced";
import { formatPercent, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentPlan, aiStateOf, planLabel, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { usageShown } from "@agenteschat/client/lib/plan-usage";
import { AUTO, isAuto } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
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
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  PixelOrbit,
  ProviderLogo,
  Row,
  Section,
  Sky,
  SpendBar,
  Text,
  useToast,
  WithPresence,
} from "@/ui";
import { CoverParallax, useCoverScroll, useScrollFade } from "@/ui/cover";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { LetMeTalkPill } from "../chat/ReachLines";
import { AgentComputerRow } from "../computer/AgentComputerRow";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { chatHref } from "../links/logic";
import { UsageQueueSheet } from "../queue/UsageQueueSheet";
import { openRightHandSettings } from "../right-hand/SettingsScreen";
import { useConnectedById } from "../settings/hooks";
import { agentBadgeInset } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { PushedHeader, Tile } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { useAgentProfileStatus } from "../status/hooks";
import { StatusCard } from "../status/StatusCard";
import { PlanMeter } from "../usage/parts";
import { openAgentUsage } from "../usage/UsageScreen";
import { openAgentEdit } from "./AgentEditScreen";
import { AgentMailSection } from "./AgentMailSection";
import { byPlaybook, canEditMemories, type DidLine, didLines, knownAboutMe, plainRole, spendOf, usesOf } from "./logic";
import { MonthPixels } from "./MonthPixels";
import { useMemoryOriginText } from "./useMemoryOriginText";
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
  browser: "globe",
  setup: "pen",
  desktop: "laptop",
};

/**
 * An agent's profile as a teammate: its sky and living body (with its presence badge), its
 * role in one plain sentence, who answers for it, its presence and status line (ADR 0084), what it is on now (or
 * what waits on you), one button
 * (Conversar), then what it did for you, what it knows about you (tap to correct or forget, for its owner and
 * admins), what it can use in plain levels and the approval rule, and its month last.
 */
export function AgentProfileScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const agent = useDirectory().anyAgent(id);
  // No longer in the team (archived or deleted): its messages name it, it has no profile.
  if (agent?.former) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title={agent.name} solid={false} />
        <EmptyState icon="agent" title={t("profile.former")} />
      </View>
    );
  }
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
  const org = useOrg().org;
  const insets = useSafeAreaInsets();
  // The cover's sky lags behind the scroll and stretches on pull; the agent fades as it nears the bar.
  const { y, onScroll } = useCoverScroll();
  const underBar = AVATAR_TOP - (insets.top + BAR_HEIGHT);
  const avatarFade = useScrollFade(y, underBar - 30, underBar + 70);
  const agent = dir.agentById.get(id);
  // Someone it doesn't answer (not its owner, not an admin) sees only its public card: no tools, memory or month.
  const details = seesDetails(agent);
  // The team's right hand (ADR 0137): what it is and how it works, its model, Configurar for who manages agents.
  const rightHand = isRightHand(agent);
  const modelLabel = useModelLabel();
  const detail = useAgentDetail(orgId, id);
  const access = useAgentAccess(orgId, id, details);
  const usage = useUsage(orgId);
  const forYou = useAgentForYou(orgId, id);
  const knows = useMemoryAboutMe(orgId, id);
  const work = useWorkingNow().filter((w) => w.agentId === id);
  const asking = useWaitingApprovals().filter((a) => a.agentId === id);
  const noAi = aiStateOf(useAiStatus(orgId).data, id) === "no_ai";
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
  const editable = canEditMemories(agent, { id: meId, org });
  // Its presence and line (ADR 0084): the badge, "Ocupado · Num trabalho pesado", the card with what it does.
  const status = useAgentProfileStatus(id, name);
  const decides = mine || can(org, "manage_agents");
  const did = didLines(forYou.data?.items);
  const memories = knownAboutMe(knows.data);
  const learned = byPlaybook(memories);
  const uses = usesOf(access.data);
  const connected = useConnectedById();
  // A computer brain: its maker's mark and the model by the plan that pays for it ("Sonnet pelo plano do Claude"; its
  // computer only where it tells two apart).
  const thinks =
    agent?.brain && agent.brain.kind !== "model" ? brainLine(t, agent.brain, "", { agents: dir.agents }) : null;
  // As the web's cell: the plan as the row's name ("Pensa com" › "Claude"), the model under it, and its effort for who
  // sees it (its owner and admins) where the model is fixed (Automático picks the effort too).
  const effortView = useAgentBrain(orgId, id, decides && thinks !== null).data;
  const brainKind = agent?.brain?.kind;
  const thinksPlan =
    brainKind && brainKind !== "model"
      ? planLabel(t, planOfAccount({ kind: brainKind, provider: agent?.brain?.provider ?? null }))
      : null;
  const thinksModel = isAuto(agent?.brain?.model) ? t("brain.auto.label") : (agent?.brain?.model ?? null);
  const thinksEffort =
    effortView && effortView.brain !== "model" && !isAuto(effortView.effectiveModel)
      ? t("agentPage.work.cell.effort", {
          level: t(`agentPage.work.brain.effortsLower.${effortLevel(effortView.effort)}`),
        })
      : null;
  const thinksUnder = [thinksModel, thinksEffort].filter(Boolean).join(" · ");
  const spend = detail.data
    ? spendOf({
        budgetUsedPercent: detail.data.budgetUsedPercent,
        monthlyBudgetUsd: detail.data.monthlyBudgetUsd ?? null,
        ...(detail.data.defaultBudgetUsd !== undefined ? { defaultBudgetUsd: detail.data.defaultBudgetUsd } : {}),
        usage: usage.data?.find((u) => u.agentId === id) ?? null,
      })
    : null;
  // On a plan, its limits first and the budget only once it spent through the API (ADR 0063 §5).
  const shown = usageShown(agent?.brain, detail.data?.budgetUsedPercent ?? 0);
  const money = (v: number) =>
    new Intl.NumberFormat(i18n.language || "en", { style: "currency", currency: "USD" }).format(v);
  const originText = useMemoryOriginText();

  const openDm = (to: { agentId: string } | { userId: string } = { agentId: id }) =>
    api.dms
      .open(orgId, to)
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

  const memoryRow = (m: Memory) => (
    <Row
      key={m.id}
      leading={<Tile icon="brain" />}
      title={m.summary ?? m.text}
      subtitle={originText(m)}
      chevron={editable}
      {...(editable ? { onPress: () => fix(m) } : {})}
    />
  );

  const ownerLine = rightHand
    ? null
    : mine
      ? t("mobile.intentAgents.ownerYou")
      : owner
        ? t("mobile.intentAgents.owner", { name: owner })
        : null;
  const roleLine = rightHand
    ? `${t("rightHand.role")} · ${t("rightHand.label")}`
    : [roleName || null, plain ? (roleName ? lowerFirst(plain, i18n.language) : plain) : null]
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
            <WithPresence size={104} presence={status?.presence} inset={agentBadgeInset(look, 104)}>
              <AgentAvatar agent={look} size={104} mode={busy ? "run" : "idle"} />
            </WithPresence>
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
          {status ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {status.line}
            </Text>
          ) : null}
          {status?.card ? (
            <View style={styles.status}>
              <StatusCard emoji={status.card.emoji} text={status.card.text} note={status.card.note} />
            </View>
          ) : null}
          {status?.waiting ? (
            <View style={styles.status}>
              <Button
                variant="secondary"
                size="sm"
                icon="wait"
                label={t("queue.see")}
                onPress={() => sheet.open(<UsageQueueSheet agentId={id} />)}
              />
            </View>
          ) : null}
          {waitingNow ? (
            <NowPill
              leading={<Icon name="wait" size={15} color={c.amber} />}
              label={t("mobile.intentAgents.nowWaiting", { title: waitingNow.title })}
              onPress={() => router.push(`/approval/${waitingNow.id}`)}
            />
          ) : null}
          {noAi ? (
            <NowPill
              leading={<Icon name="bolt" size={15} color={c.amber} />}
              label={t("noAi.agent", agentGrammar(agent?.name ?? ""))}
              onPress={() => openConnectAi({ agentId: id, plan: agentPlan(agent) ?? undefined })}
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
            {details || !ownerId ? (
              <Button
                variant="primary"
                wide
                icon="chat"
                label={t("mobile.agent.talk")}
                disabled={!listsAgent(org, agent)}
                onPress={() => void openDm()}
              />
            ) : (
              <Button
                variant="primary"
                wide
                icon="chat"
                label={t("profile.askAccess")}
                onPress={() => void openDm({ userId: ownerId })}
              />
            )}
          </View>
          {agent?.canTalk === false ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {details ? t("mobile.agent.cantTalk") : t("profile.detailsHidden", agentGrammar(name))}
            </Text>
          ) : null}
          {agent ? <LetMeTalkPill agent={agent} /> : null}
        </View>

        {rightHand && agent ? (
          <Section title={t("rightHand.profile.how")}>
            <Card>
              <Row leading={<Tile icon="shield" />} title={t("rightHand.profile.permissions")} />
              <Row leading={<Tile icon="lock" />} title={t("rightHand.profile.private")} />
              <Row leading={<Tile icon="hash" />} title={t("rightHand.profile.channels")} />
              <Row
                leading={<Tile icon="brain" />}
                title={t("rightHand.profile.model")}
                meta={
                  <Text variant="small" tone="muted">
                    {agent.model === AUTO ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model)}
                  </Text>
                }
              />
            </Card>
          </Section>
        ) : details ? (
          <>
            {forYou.data || forYou.isError ? (
              <Section
                title={t("mobile.intentAgents.did.title", agentGrammar(name))}
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
                {/* Its month, day by day, in its own tones (the web's Atividade tab). */}
                {detail.data && detail.data.runsThisMonth > 0 ? (
                  <View style={styles.pixels}>
                    <MonthPixels
                      perDay={detail.data.runsByDay}
                      color={look.color}
                      label={t("agentPage.activity.chartLabel", {
                        count: detail.data.runsThisMonth,
                        month: new Intl.DateTimeFormat(when.locale, { month: "long", timeZone: "UTC" }).format(
                          new Date(),
                        ),
                      })}
                    />
                  </View>
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
              <Section title={t("mobile.intentAgents.knows.title", agentGrammar(name))}>
                {memories.length > 0 ? (
                  <>
                    {learned.people.length > 0 ? <Card>{learned.people.map(memoryRow)}</Card> : null}
                    {learned.playbook.length > 0 ? (
                      <>
                        <Text variant="small" tone="ink" accessibilityRole="header" style={styles.playbook}>
                          {t("agentPage.memory.playbook", agentGrammar(name))}
                        </Text>
                        <Text variant="small" tone="muted" style={styles.foot}>
                          {t("agentPage.memory.playbookNote")}
                        </Text>
                        <Card>{learned.playbook.map(memoryRow)}</Card>
                      </>
                    ) : null}
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

            <AgentComputerRow agentId={id} />

            {thinks ? (
              <Section title={t("mobile.intentAgents.thinks")}>
                <Card>
                  {/* Its owner and admins open its AI: the account, the plan's usage, who it replies to. */}
                  <Row
                    leading={thinks.mark ? <ProviderLogo id={thinks.mark} size="sm" /> : undefined}
                    title={thinksPlan ?? thinks.text}
                    {...(thinksUnder ? { subtitle: thinksUnder, subtitleLines: 2 } : {})}
                    {...(decides ? { chevron: true, onPress: () => openAgentAi(id) } : {})}
                  />
                </Card>
              </Section>
            ) : null}

            {access.data ? (
              <Section title={t("mobile.intentAgents.uses.title", agentGrammar(name))}>
                {uses.lines.length > 0 ? (
                  <Card>
                    {uses.lines.map((u) => (
                      <Row
                        key={u.key}
                        leading={
                          "area" in u.label ? (
                            <Tile icon={AREA_ICON[u.label.area] ?? "doc"} />
                          ) : (
                            <ConnectorIcon
                              def={(u.connectionId ? connected.get(u.connectionId)?.def : null) ?? null}
                              image={u.connectionId ? connected.get(u.connectionId)?.image : null}
                              label={u.label.text}
                              size={36}
                            />
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
                {decides ? (
                  // Ferramentas: a new service for this agent starts in Conectores (who uses it is chosen there).
                  <View style={styles.foot}>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="plus"
                      label={t("mobile.connectors.fromAgent")}
                      onPress={() => router.push("/connectors")}
                    />
                  </View>
                ) : null}
              </Section>
            ) : null}

            <AgentMailSection agentId={id} />

            <AlwaysApproved agentId={id} name={name} mayRemove={mine || can(org, "approve_actions")} />

            <Section title={t("mobile.agent.month")}>
              <View style={styles.monthCards}>
                {shown.plan ? (
                  <Card>
                    <View style={styles.spend}>
                      <PlanMeter compact usage={shown.plan.usage} label={shown.plan.account} />
                      {spend && shown.budget ? (
                        <Text variant="caption" tone="muted">
                          {spend.kind === "money"
                            ? `${money(spend.spentUsd)} ${t("mobile.agent.ofBudget", { budget: money(spend.budgetUsd) })}`
                            : `${formatPercent(i18n.language, spend.percent)} ${t("mobile.agent.ofMonthBudget")}`}
                        </Text>
                      ) : null}
                    </View>
                  </Card>
                ) : spend && shown.budget ? (
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
                              {formatPercent(i18n.language, spend.percent)}
                            </Text>
                            <Text variant="small" tone="muted">
                              {t("mobile.agent.ofMonthBudget")}
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
                ) : null}
                {/* Uso: the month by account and the plan it thinks with now, as the web's Uso tab. */}
                <Card>
                  <Row
                    leading={<Tile icon="chart" />}
                    title={t("usageViews.agent.title", agentGrammar(name))}
                    chevron
                    onPress={() => openAgentUsage(id)}
                  />
                </Card>
              </View>
            </Section>
          </>
        ) : null}
      </Animated.ScrollView>
      <View style={styles.bar} pointerEvents="box-none">
        {/* Its person changes its look; admins, everything ("Editar", as the web's Configurações). */}
        <PushedHeader
          plate
          solid={false}
          {...(rightHand
            ? can(org, "manage_agents")
              ? { action: { label: t("rightHand.profile.configure"), onPress: openRightHandSettings } }
              : {}
            : decides && agent
              ? { action: { label: t("agent.edit"), onPress: () => openAgentEdit(id) } }
              : {})}
        />
      </View>
    </View>
  );
}

/**
 * "Aprovado sempre", as on the web's Ferramentas e acesso: what the agent runs without asking, approved for good
 * from a request, by whom and when. Its owner and whoever decides approvals take one back with its ×, at once.
 * Shown only when there is something.
 */
function AlwaysApproved({ agentId, name, mayRemove }: { agentId: string; name: string; mayRemove: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const when = useWhen();
  const dir = useDirectory();
  const connected = useConnectedById();
  const rules = useApprovalRules(orgId, agentId);
  const remove = useRemoveApprovalRule(orgId, agentId);
  const list = rules.data ?? [];
  if (list.length === 0) return null;
  return (
    <Section title={t("agentPage.access.always.title")}>
      <Card>
        {list.map((rule) => {
          const what = approvalRuleWords(t, rule);
          const who = rule.createdByUserId ? dir.memberById.get(rule.createdByUserId)?.name : undefined;
          const at = when.short(rule.createdAt);
          return (
            <Row
              key={rule.id}
              leading={
                <ConnectorIcon
                  def={(rule.connectionId && connected.get(rule.connectionId)?.def) || null}
                  image={rule.connectionId ? connected.get(rule.connectionId)?.image : null}
                  label={approvalRuleServer(t, rule)}
                  size={36}
                />
              }
              title={what}
              subtitle={
                who
                  ? t("agentPage.access.always.by", { name: who, when: at })
                  : t("agentPage.access.always.byNobody", { when: at })
              }
              meta={
                mayRemove ? (
                  <IconButton
                    icon="x"
                    label={t("agentPage.access.always.remove", { what })}
                    disabled={remove.isPending}
                    onPress={() =>
                      remove.mutate(rule.id, {
                        onSuccess: () => toast({ title: t("agentPage.access.always.removed", { name }), agentId }),
                        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                      })
                    }
                  />
                ) : undefined
              }
            />
          );
        })}
      </Card>
      <Text variant="small" tone="muted" style={styles.foot}>
        {t("agentPage.access.always.help")}
      </Text>
    </Section>
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
export function MemoryFix({
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
  status: { marginTop: 10 },
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
  pixels: { paddingHorizontal: 4, marginBottom: 12 },
  monthCards: { gap: 10 },
  foot: { paddingHorizontal: 4, marginTop: 8 },
  playbook: { paddingHorizontal: 4, marginTop: 16, fontWeight: "600" },
  src: { flexDirection: "row", alignItems: "center", gap: 6 },
  spend: { padding: 14, gap: 10 },
  spendHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  warn: { flexDirection: "row", alignItems: "center", gap: 6 },
});
