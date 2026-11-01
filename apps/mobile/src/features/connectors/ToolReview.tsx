import {
  type ConnectorDef,
  type CustomServer,
  type MailAccount,
  type ToolDecision,
  useCustomServerAction,
  useCustomServers,
  useMailAction,
} from "@agenteschat/client";
import { mailActionsChanged, mailActionsFrom, mailReviewTools } from "@agenteschat/client/lib/mail";
import {
  countLevels,
  levelSummary,
  type ReviewTool,
  reviewDecisions,
  reviewToolsOf,
} from "@agenteschat/client/lib/tool-review";
import { useDeferredValue, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Icon, SearchField, Segmented, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, MONO, successHaptic, Tile } from "../shared/parts";
import { Problem } from "./Problem";
import {
  acceptAll,
  catalogReviewTools,
  choicesOf,
  choose,
  chosenLevel,
  confirm,
  emptyReview,
  isWaiting,
  type ReviewState,
  reviewAgain,
  reviewTarget,
  type SubjectGroup,
  subjectsOf,
  waitingHits,
} from "./review";

/**
 * "O que faz", between connecting and who uses it (the web's second step): a server connected by its address
 * shows its tools as they came classified, by subject, each with the web's control to change it (saved on
 * Continuar, through the same endpoint); our catalog services show theirs as they are (by scope: sensitive
 * ones always ask). On its own screen (Ferramentas) the server's button saves and the catalog's list has none.
 */
export function ReviewStep({
  connectionId,
  def,
  name,
  onNext,
  onScreen = false,
}: {
  connectionId: string;
  def: ConnectorDef | null;
  name: string;
  onNext: () => void;
  onScreen?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const servers = useCustomServers(orgId);
  const target = reviewTarget(
    connectionId,
    def,
    servers.data ?? (servers.isError ? [] : undefined),
    servers.isFetching,
  );
  if (target.kind === "server") {
    return (
      <ServerReview key={target.server.id} server={target.server} name={name} onNext={onNext} onScreen={onScreen} />
    );
  }
  if (target.kind === "loading") return <ActivityIndicator color={c.muted} />;
  const tools = target.kind === "catalog" ? catalogReviewTools(t, target.def) : [];
  return (
    <>
      {target.kind === "catalog" ? (
        <Text variant="body" tone="muted">
          {t("toolReview.catalogLead", { name })}
        </Text>
      ) : null}
      {tools.length === 0 ? (
        <Text variant="small" tone="muted">
          {t("toolReview.noTools")}
        </Text>
      ) : (
        <ToolList tools={tools} levelOf={(x) => x.level} />
      )}
      {onScreen ? null : <Button variant="primary" wide label={t("connectFlow.next")} onPress={onNext} />}
    </>
  );
}

/** A server's tools: the person settles what waits and changes what they want; Continuar (Salvar) saves it all. */
function ServerReview({
  server: first,
  name,
  onNext,
  onScreen,
}: {
  server: CustomServer;
  name: string;
  onNext: () => void;
  onScreen: boolean;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { save, refresh } = useCustomServerAction(orgId);
  const [server, setServer] = useState(first);
  const [state, setState] = useState<ReviewState>(emptyReview);
  const [failed, setFailed] = useState<string | null>(null);
  const tools = useMemo(() => reviewToolsOf(t, server), [t, server]);
  const left = tools.filter((x) => isWaiting(state, x)).length;
  const busy = save.isPending || refresh.isPending;
  const fail = (text: string) => {
    errorHaptic();
    setFailed(text);
  };
  const lookAgain = () => {
    setFailed(null);
    refresh.mutate(server.id, {
      onSuccess: (fresh) => setServer(fresh),
      onError: () => fail(t("mobile.connectors.review.refreshFailed")),
    });
  };
  const next = () => {
    setFailed(null);
    save.mutate(
      { id: server.id, label: server.label, tools: reviewDecisions(tools, state.levels, state.decided) },
      {
        onSuccess: () => {
          successHaptic();
          onNext();
        },
        onError: () => fail(t("mobile.connectors.review.saveFailed", { name })),
      },
    );
  };
  return (
    <>
      <Text variant="body" tone="muted">
        {t("toolReview.lead", { count: tools.length, name })}
      </Text>
      <Button
        variant="secondary"
        size="sm"
        label={refresh.isPending ? t("mobile.connectors.review.refreshing") : t("toolReview.refresh")}
        disabled={busy}
        onPress={lookAgain}
      />
      {tools.length === 0 ? (
        <Text variant="small" tone="muted">
          {t("toolReview.noTools")}
        </Text>
      ) : (
        <ToolList tools={tools} levelOf={(x) => chosenLevel(state, x)} review={{ state, onChange: setState }} />
      )}
      {failed ? <Problem key={failed} text={failed} /> : null}
      <Text variant="small" tone="muted">
        {left > 0 ? t("toolReview.missing", { count: left }) : t("toolReview.later")}
      </Text>
      <Button
        variant="primary"
        wide
        label={
          save.isPending ? t("mobile.connectors.review.saving") : onScreen ? t("common.save") : t("connectFlow.next")
        }
        disabled={busy}
        onPress={next}
      />
    </>
  );
}

/**
 * A mailbox's "O que faz", as on the web: each action at Consulta · Muda · Aprovação · Desligada (sending and
 * deleting only ask or are off), saved through the mailbox on Continuar (Salvar on its own).
 */
export function MailReview({
  account,
  onNext,
  onScreen = false,
}: {
  account: MailAccount;
  onNext: () => void;
  onScreen?: boolean;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { update } = useMailAction(orgId);
  const [state, setState] = useState<ReviewState>(emptyReview);
  const [failed, setFailed] = useState(false);
  const tools = useMemo(() => mailReviewTools(t, account), [t, account]);
  const next = () => {
    const chosen = mailActionsFrom(tools, state.levels);
    if (!mailActionsChanged(account, chosen)) return onNext();
    setFailed(false);
    update.mutate(
      { accountId: account.id, ...chosen },
      {
        onSuccess: () => {
          successHaptic();
          onNext();
        },
        onError: () => {
          errorHaptic();
          setFailed(true);
        },
      },
    );
  };
  return (
    <>
      <Text variant="body" tone="muted">
        {t("mail.toolsLead", { name: account.address })}
      </Text>
      <ToolList tools={tools} levelOf={(x) => chosenLevel(state, x)} review={{ state, onChange: setState }} />
      {failed ? <Problem text={t("mail.actionsError")} /> : null}
      <Button
        variant="primary"
        wide
        label={
          update.isPending ? t("mobile.connectors.review.saving") : onScreen ? t("common.save") : t("connectFlow.next")
        }
        disabled={update.isPending}
        onPress={next}
      />
    </>
  );
}

/** "Ferramentas" on a connection or a mailbox: how many tools, how many wait for a decision ("Revisar"). */
export function ToolsRow({ count, waiting = 0, onPress }: { count: number; waiting?: number; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const line = waiting > 0 ? t("toolReview.decideTitle", { count: waiting }) : t("toolReview.subjectCount", { count });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${t("connectors.tools")}, ${line}`}
      style={({ pressed }) => [styles.row, { borderColor: c.line }, pressed && { backgroundColor: c.sunken }]}
    >
      <Tile icon="list" size={36} />
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold}>
          {t("connectors.tools")}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={1} style={waiting > 0 && { color: c.warn }}>
          {line}
        </Text>
      </View>
      {waiting > 0 ? (
        <Text variant="small" style={[styles.bold, { color: c.warn }]}>
          {t("connectors.review")}
        </Text>
      ) : null}
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/**
 * The tools, as the web lists them: (editable) a summary when nothing waits, then every tool by subject under
 * one search, with "Precisam da sua decisão" first; a subject opens to its tools. Read-only shows each level.
 */
function ToolList({
  tools,
  levelOf,
  review,
}: {
  tools: ReviewTool[];
  levelOf: (tool: ReviewTool) => ToolDecision;
  /** Absent: read-only. */
  review?: { state: ReviewState; onChange: (state: ReviewState) => void };
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const searching = query.trim().length > 0;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const state = review?.state;
  const waiting = state ? tools.filter((x) => isWaiting(state, x)) : [];
  const hits = state ? waitingHits(state, tools, query) : [];
  const groups = subjectsOf(t, state ? tools.filter((x) => !isWaiting(state, x)) : tools, query);
  const toggle = (subject: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(subject)) next.delete(subject);
      else next.add(subject);
      return next;
    });
  return (
    <>
      {review && waiting.length === 0 ? (
        <Done
          summary={levelSummary(t, countLevels(tools.map((x) => ({ level: levelOf(x) }))))}
          reviewable={tools.filter((x) => x.pending).length}
          onReview={() => review.onChange(reviewAgain(review.state))}
        />
      ) : null}
      <Text variant="footnote" tone="faint" style={styles.label}>
        {t("toolReview.all", { count: tools.length })}
      </Text>
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder={t("toolReview.search")}
        accessibilityLabel={t("toolReview.search")}
      />
      {review && hits.length > 0 ? (
        <Waiting
          count={waiting.length}
          hits={hits}
          searching={searching}
          state={review.state}
          onChange={review.onChange}
        />
      ) : null}
      {groups.map((g) => (
        <Subject
          key={g.subject}
          group={g}
          open={searching || open.has(g.subject)}
          searching={searching}
          onToggle={() => toggle(g.subject)}
          levelOf={levelOf}
          onLevel={review ? (tool, level) => review.onChange(choose(review.state, tool, level)) : undefined}
        />
      ))}
      {groups.length === 0 && hits.length === 0 ? (
        <Text variant="small" tone="muted">
          {t("toolReview.noMatch", { q: query.trim() })}
        </Text>
      ) : null}
    </>
  );
}

/** Nothing waits: it says so, how the levels came out, and "Rever as sugestões" when there were any. */
function Done({ summary, reviewable, onReview }: { summary: string; reviewable: number; onReview: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.done}>
      <Text variant="body" style={styles.bold}>
        {t("toolReview.doneTitle")}
      </Text>
      {summary ? (
        <Text variant="small" tone="muted">
          {summary}
        </Text>
      ) : null}
      {reviewable > 0 ? (
        <Pressable onPress={onReview} accessibilityRole="button" hitSlop={6} style={styles.link}>
          <Text variant="small" style={styles.bold}>
            {t("toolReview.review", { count: reviewable })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** "Precisam da sua decisão": the tools whose names don't say what they do, each with our suggestion. */
function Waiting({
  count,
  hits,
  searching,
  state,
  onChange,
}: {
  count: number;
  hits: { tool: ReviewTool; tech: boolean }[];
  searching: boolean;
  state: ReviewState;
  onChange: (state: ReviewState) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={[styles.box, { borderColor: c.line }]}>
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold}>
          {t("toolReview.decideTitle", { count })}
        </Text>
        <Text variant="small" tone="muted">
          {t("toolReview.decideHelp")}
        </Text>
      </View>
      {searching ? null : (
        <Button
          variant="secondary"
          size="sm"
          label={t("toolReview.acceptAll")}
          onPress={() =>
            onChange(
              acceptAll(
                state,
                hits.map((h) => h.tool),
              ),
            )
          }
        />
      )}
      {hits.map(({ tool, tech }) => (
        <ToolRow
          key={tool.name}
          tool={tool}
          tech={tech}
          level={chosenLevel(state, tool)}
          waiting
          onLevel={(level) => onChange(choose(state, tool, level))}
          onOk={() => onChange(confirm(state, tool))}
        />
      ))}
    </View>
  );
}

/** One subject: its name, how many tools and how they're set; open, its tools. */
function Subject({
  group,
  open,
  searching,
  onToggle,
  levelOf,
  onLevel,
}: {
  group: SubjectGroup;
  open: boolean;
  searching: boolean;
  onToggle: () => void;
  levelOf: (tool: ReviewTool) => ToolDecision;
  onLevel: ((tool: ReviewTool, level: ToolDecision) => void) | undefined;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const summary = levelSummary(t, countLevels(group.tools.map((x) => ({ level: levelOf(x) }))));
  const count = searching
    ? t("toolReview.subjectHits", { hits: group.hits.length, count: group.tools.length })
    : t("toolReview.subjectCount", { count: group.tools.length });
  const line = summary ? `${count} · ${summary}` : count;
  return (
    <View style={[styles.box, { borderColor: c.line }]}>
      <Pressable
        onPress={onToggle}
        disabled={searching}
        accessibilityRole="button"
        accessibilityLabel={`${group.label}, ${line}`}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        style={styles.head}
      >
        <View style={styles.grow}>
          <Text variant="body" numberOfLines={1} style={styles.bold}>
            {group.label}
          </Text>
          <Text variant="small" tone="muted">
            {line}
          </Text>
        </View>
        {searching ? null : <Icon name={open ? "chev" : "right"} size={15} color={c.faint} />}
      </Pressable>
      {open
        ? group.hits.map(({ tool, tech }) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              tech={tech}
              level={levelOf(tool)}
              onLevel={onLevel ? (level) => onLevel(tool, level) : undefined}
            />
          ))
        : null}
    </View>
  );
}

/**
 * A tool: its readable name (the technical one when the search matched it), our suggestion while it waits,
 * and the web's choices (Consulta · Muda · Aprovação · Desligada; sensitive ones only the last two); read-only,
 * its level.
 */
function ToolRow({
  tool,
  tech,
  level,
  waiting = false,
  onLevel,
  onOk,
}: {
  tool: ReviewTool;
  tech: boolean;
  level: ToolDecision;
  waiting?: boolean;
  onLevel: ((level: ToolDecision) => void) | undefined;
  onOk?: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={[styles.tool, { borderTopColor: c.line }]}>
      <View style={styles.head}>
        <View style={styles.grow}>
          <Text variant="body" numberOfLines={2}>
            {tool.label}
          </Text>
          {waiting ? (
            <Text variant="small" tone="muted">
              <Trans
                i18nKey="toolReview.suggestion"
                values={{
                  level: t(`toolReview.one.${tool.suggested}`),
                  reason: t(`toolReview.reason.${tool.reason ?? "unknown"}`, {
                    defaultValue: t("toolReview.reason.unknown"),
                  }),
                }}
                components={{ b: <Text variant="small" style={styles.bold} /> }}
              />
            </Text>
          ) : null}
          {tech ? (
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.mono}>
              {tool.name}
            </Text>
          ) : null}
        </View>
        {onLevel ? null : (
          <Text variant="small" tone="muted">
            {t(`toolReview.choice.${level}`)}
          </Text>
        )}
        {onOk ? <Button variant="secondary" size="sm" label={t("toolReview.ok")} onPress={onOk} /> : null}
      </View>
      {onLevel ? (
        // Four choices can be wider than a small phone's sheet: they scroll sideways there.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Segmented
            items={choicesOf(tool).map((l) => ({ key: l, label: t(`toolReview.short.${l}`) }))}
            value={level}
            onChange={(k) => onLevel(k as ToolDecision)}
          />
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  label: { letterSpacing: 0.3 },
  mono: { fontFamily: MONO },
  done: { gap: 2 },
  link: { alignSelf: "flex-start", marginTop: 6 },
  // The sheet's card (as each agent's in who uses it): a hairline, radius 14.
  box: { gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  tool: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
