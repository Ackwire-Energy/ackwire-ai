import { useArtifact, usePoll, useVote } from "@agenteschat/client";
import { pollAnswered, pollIsOpen, pollTally, pollToggle } from "@agenteschat/client/lib/blocks";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Icon, Sky, Text, useToast } from "@/ui";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";

const FACES = 4;

/**
 * A vote in the conversation (ADR 0113), drawn by the app and never by a page: a vote is an act of the person's.
 * Everyone sees the marks arrive (`poll.updated`).
 */
export function PollCard({ id, version }: { id: string; version?: number }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const artifact = useArtifact(orgId, id, version);
  const query = usePoll(orgId, id);
  const vote = useVote(orgId, id);
  const a = artifact.data;
  const poll = query.data;
  if (!a || a.content.kind !== "poll" || !poll) {
    return (
      <View style={[styles.card, styles.loading, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <ActivityIndicator color={c.faint} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.building")}
        </Text>
      </View>
    );
  }
  const { options, multiple, question } = a.content;
  const open = pollIsOpen(poll);
  const tally = pollTally(options, poll);
  const top = Math.max(...tally.map((o) => o.voters.length));
  const nameOf = (userId: string) => dir.memberById.get(userId)?.name ?? t("mobile.blocks.someone");
  const closes = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(poll.closesAt),
  );
  return (
    <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <Sky
        color={agentLook(dir.agentById.get(a.createdBy.id)).color}
        surface="raised"
        depth={0.95}
        fade={0}
        style={styles.sky}
      />
      <View style={styles.head}>
        <Text variant="subhead" style={styles.bold}>
          {question}
        </Text>
        <Text variant="footnote" tone="faint">
          {open ? t("mobile.blocks.pollCloses", { time: closes }) : t("mobile.blocks.pollClosed")}
        </Text>
      </View>
      <View style={styles.options}>
        {tally.map((o) => {
          const mine = meId !== null && o.voters.includes(meId);
          const won = !open && top > 0 && o.voters.length === top;
          return (
            <Pressable
              key={o.option}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: mine, disabled: !open }}
              accessibilityLabel={`${o.label}, ${o.voters.length}`}
              disabled={!open || vote.isPending || !meId}
              onPress={() => {
                if (!meId) return;
                tapHaptic();
                vote.mutate(pollToggle(poll, meId, o.option, multiple), {
                  onError: () => toast({ title: t("mobile.blocks.voteFailed"), icon: "x" }),
                });
              }}
              style={[styles.option, { borderColor: c.line2 }]}
            >
              <View style={[styles.fill, { width: `${o.share * 100}%`, backgroundColor: c.line }]} />
              <View style={[styles.box, { borderColor: c.faint }, mine && { backgroundColor: c.ink, borderColor: c.ink }]}>
                {mine ? <Icon name="check" size={13} color={c.raised} /> : null}
              </View>
              <Text variant="body" style={[styles.label, styles.bold]}>
                {o.label}
              </Text>
              {won ? <View style={[styles.mark, { backgroundColor: c.ok }]} /> : null}
              <View style={styles.faces}>
                {o.voters.slice(0, FACES).map((v) => (
                  <View key={v} style={[styles.face, { backgroundColor: c.line2, borderColor: c.raised }]}>
                    <Text variant="caption" style={styles.bold}>
                      {nameOf(v).slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                ))}
                {o.voters.length > FACES ? (
                  <Text variant="caption" tone="muted">
                    {` +${o.voters.length - FACES}`}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {multiple && open ? (
        <Text variant="footnote" tone="faint" style={styles.note}>
          {t("mobile.blocks.pollMultiple")}
        </Text>
      ) : null}
      <View style={[styles.foot, { borderTopColor: c.line2 }]}>
        <View style={[styles.mark, { backgroundColor: open ? c.faint : c.ok }]} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.pollAnswered", { count: pollAnswered(poll), total: poll.people })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, borderBottomLeftRadius: 4 },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 8, opacity: 0.7 },
  head: { gap: 1, paddingHorizontal: 14, paddingTop: 12 },
  bold: { fontWeight: "600" },
  options: { gap: 6, padding: 14, paddingTop: 10 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 6,
    overflow: "hidden",
    borderWidth: 1,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
  },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0 },
  box: {
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    borderWidth: 1.6,
    borderRadius: 6,
    borderBottomLeftRadius: 2,
  },
  label: { flex: 1, minWidth: 0 },
  faces: { flexDirection: "row", alignItems: "center" },
  face: {
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    marginLeft: -4,
    borderWidth: 2,
    borderRadius: 8,
    borderBottomLeftRadius: 3,
  },
  note: { marginTop: -8, marginBottom: 10, paddingHorizontal: 14 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  mark: { width: 5, height: 5 },
});
