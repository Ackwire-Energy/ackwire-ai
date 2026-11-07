import { useAnswerChoices, useArtifact, useChoices } from "@agenteschat/client";
import {
  answeredFirst,
  type ChoiceDraft,
  choiceLetter,
  choiceSummary,
  emptyDraft,
  moveStep,
  pickChoice,
} from "@agenteschat/client/lib/choices";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Icon, Sky, Text, useToast } from "@/ui";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";

/**
 * An agent asks the person to pick (ADR 0124): big rows lettered A, B, C…, one question at a time. A tap answers at
 * once, as the person's own message to the agent; then the card shows what was picked to everyone.
 */
export function ChoicesCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const artifact = useArtifact(orgId, id, version);
  const query = useChoices(orgId, id);
  const answer = useAnswerChoices(orgId, id);
  const [draft, setDraft] = useState<ChoiceDraft | null>(null);
  const [closed, setClosed] = useState(false);
  const a = artifact.data;
  if (a?.content.kind !== "choices" || !query.data) {
    return (
      <View style={[styles.card, styles.loading, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <ActivityIndicator color={c.faint} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.building")}
        </Text>
      </View>
    );
  }
  const { questions } = a.content;
  const answered = query.data.answer;
  const sky = (
    <Sky
      color={agentLook(dir.agentById.get(a.createdBy.id)).color}
      surface="raised"
      depth={0.95}
      fade={0}
      style={styles.sky}
    />
  );

  if (answered) {
    const by = dir.memberById.get(answered.userId)?.name ?? t("mobile.blocks.someone");
    return (
      <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        {sky}
        <View style={styles.head}>
          <Text variant="subhead" style={styles.bold}>
            {a.title}
          </Text>
          <Text variant="footnote" tone="faint">
            {t("mobile.choices.answeredBy", { name: by })}
          </Text>
        </View>
        <View style={styles.options}>
          {choiceSummary(questions, answered.picks).map((s) => (
            <View key={s.question} style={styles.summary}>
              {questions.length > 1 ? (
                <Text variant="footnote" tone="muted">
                  {s.question}
                </Text>
              ) : null}
              <View style={styles.row}>
                <View style={[styles.letter, { backgroundColor: c.ink, borderColor: c.ink }]}>
                  <Text variant="caption" style={[styles.bold, { color: c.raised }]}>
                    {s.letter}
                  </Text>
                </View>
                <Text variant="body" style={[styles.flex, styles.bold]}>
                  {s.label}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (closed) {
    return (
      <Pressable accessibilityRole="button" onPress={() => setClosed(false)} style={styles.closed}>
        <Text variant="footnote" tone="faint">
          {t("mobile.choices.closed", { title: a.title })}
        </Text>
        <Text variant="footnote" tone="ink" style={styles.bold}>
          {t("mobile.choices.reopen")}
        </Text>
      </Pressable>
    );
  }

  const d = draft ?? emptyDraft(questions);
  const q = questions[d.step];
  if (!q) return null;
  const pick = (option: number) => {
    if (answer.isPending) return;
    tapHaptic();
    const next = pickChoice(d, option);
    setDraft(next.draft);
    if (next.send)
      answer.mutate(next.send, {
        onError: (e) => {
          if (!answeredFirst(e)) toast({ title: t("mobile.choices.failed"), icon: "x" });
          void query.refetch();
        },
      });
  };
  return (
    <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      {sky}
      <View style={[styles.head, styles.row]}>
        <View style={styles.flex}>
          <Text variant="subhead" style={styles.bold}>
            {a.title}
          </Text>
          {questions.length > 1 ? (
            <Text variant="footnote" tone="faint">
              {t("mobile.choices.step", { step: d.step + 1, total: questions.length })}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.choices.close")}
          hitSlop={10}
          onPress={() => setClosed(true)}
        >
          <Icon name="x" size={16} color={c.faint} />
        </Pressable>
      </View>
      <Text variant="body" style={styles.question}>
        {q.question}
      </Text>
      {/* Not `Locked`: it closes the keyboard, and in a conversation that's the composer's. */}
      <View style={[styles.options, answer.isPending && styles.sending]}>
        {q.options.map((o, i) => {
          const on = d.picks[d.step] === i;
          return (
            <Pressable
              key={o.label}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: answer.isPending }}
              accessibilityLabel={`${choiceLetter(i)}. ${o.label}${o.description ? `. ${o.description}` : ""}`}
              disabled={answer.isPending}
              onPress={() => pick(i)}
              style={({ pressed }) => [styles.option, { borderColor: c.line2 }, pressed && { backgroundColor: c.line }]}
            >
              <View
                style={[styles.letter, { borderColor: c.line2 }, on && { backgroundColor: c.ink, borderColor: c.ink }]}
              >
                <Text
                  variant="caption"
                  tone={on ? undefined : "muted"}
                  style={[styles.bold, on && { color: c.raised }]}
                >
                  {choiceLetter(i)}
                </Text>
              </View>
              <View style={styles.flex}>
                <Text variant="body" style={styles.bold}>
                  {o.label}
                </Text>
                {o.description ? (
                  <Text variant="footnote" tone="muted">
                    {o.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {questions.length > 1 ? (
        <View style={[styles.foot, { borderTopColor: c.line2 }]}>
          <Pressable
            accessibilityRole="button"
            disabled={d.step === 0}
            onPress={() => setDraft(moveStep(d, -1))}
            // An 18-point line: 13 of slop around it gives the 44-point target.
            hitSlop={13}
          >
            <Text variant="footnote" tone={d.step === 0 ? "faint" : "ink"} style={styles.bold}>
              {t("mobile.choices.back")}
            </Text>
          </Pressable>
          <View style={styles.dots}>
            {questions.map((qq, i) => (
              <View
                key={qq.question}
                style={[
                  styles.dot,
                  { backgroundColor: i === d.step ? c.ink : d.picks[i] !== null ? c.faint : c.line2 },
                ]}
              />
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={d.step === questions.length - 1 || d.picks[d.step] === null}
            onPress={() => setDraft(moveStep(d, 1))}
            hitSlop={13}
          >
            <Text
              variant="footnote"
              tone={d.step === questions.length - 1 || d.picks[d.step] === null ? "faint" : "ink"}
              style={styles.bold}
            >
              {t("mobile.choices.next")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // As wide as the message, under what comes before it (the files' cards keep the same gap).
  card: {
    alignSelf: "stretch",
    marginTop: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 8, opacity: 0.7 },
  head: { gap: 1, paddingHorizontal: 14, paddingTop: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  flex: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  question: { paddingHorizontal: 14, paddingTop: 6 },
  options: { gap: 6, padding: 14, paddingTop: 10 },
  sending: { opacity: 0.6 },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
  },
  letter: {
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    borderWidth: 1,
    borderRadius: 8,
    borderBottomLeftRadius: 3,
  },
  summary: { gap: 4 },
  closed: { flexDirection: "row", flexWrap: "wrap", columnGap: 8, paddingVertical: 6 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: "row", gap: 6 },
  dot: { width: 6, height: 6 },
});
