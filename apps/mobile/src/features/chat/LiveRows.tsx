import type { LiveConsult, LiveRun } from "@agenteschat/client";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, View } from "react-native";
import { PixelOrbit, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { type WorkingEntry, workingLine } from "./logic";
import { MessageText } from "./MessageText";

/** An agent's reply while it is being written: the words so far and the blue caret. */
export function StreamingRow({ run }: { run: LiveRun }) {
  const dir = useDirectory();
  const agent = dir.agentById.get(run.agentId);
  return (
    <View style={styles.msg}>
      <View style={styles.avslot}>
        <AgentFace agentId={run.agentId} size={32} mode="run" />
      </View>
      <View style={styles.body}>
        <View style={styles.who}>
          <Text variant="footnote" tone="ink" style={styles.name}>
            {agent?.name ?? ""}
          </Text>
          {agent?.role ? (
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
              {agent.role}
            </Text>
          ) : null}
        </View>
        <MessageText body={run.text} streaming={run.status !== "canceled"} />
      </View>
    </View>
  );
}

const isWriting = (r: LiveRun) => r.text.length > 0 && (r.status === "running" || r.status === "canceled");
const isWorking = (r: LiveRun) =>
  !isWriting(r) && (r.status === "thinking" || r.status === "queued" || r.status === "running");

/** The runs that stream as rows (words arrived). */
export const writingRuns = (runs: LiveRun[]) => runs.filter(isWriting);

/**
 * "Theo está trabalhando…", "Theo, Iris e mais 2…", "Dev está perguntando ao
 * Infra…": the orbit in the first agent's color, their faces, names in ink.
 */
export function WorkingLine({ runs, consults }: { runs: LiveRun[]; consults: LiveConsult[] }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const asking = new Map(consults.filter((x) => x.status === "asking").map((x) => [x.agentId, x.consultedAgentId]));
  const entries: WorkingEntry[] = [...runs.filter(isWorking).map((r) => r.agentId), ...[...asking.keys()]].map(
    (agentId) => {
      const to = asking.get(agentId);
      return {
        agentId,
        name: dir.agentById.get(agentId)?.name ?? "",
        asking: to ? { agentId: to, name: dir.agentById.get(to)?.name ?? "" } : null,
      };
    },
  );
  const line = workingLine(entries, genderOf);
  if (!line) return null;
  const first = entries[0];
  const bold = (s: string) => (
    <RNText key={s} style={[styles.ink, { color: c.ink }]}>
      {s}
    </RNText>
  );
  let words: ReactNode[];
  switch (line.key) {
    case "one":
      words = [bold(line.params.name), ` ${t("mobile.chat.working.isWorking")}`];
      break;
    case "two":
      words = [
        bold(line.params.first),
        ` ${t("mobile.chat.working.and")} `,
        bold(line.params.second),
        ` ${t("mobile.chat.working.areWorking")}`,
      ];
      break;
    case "many":
      words = [
        bold(line.params.first),
        ", ",
        bold(line.params.second),
        ` ${t("mobile.chat.working.andMore", { count: line.params.count })} ${t("mobile.chat.working.areWorking")}`,
      ];
      break;
    case "asking":
      words = [
        bold(line.params.from),
        ` ${t(`mobile.chat.working.asking${line.params.toGender}`)} `,
        bold(line.params.to),
        "…",
      ];
      break;
  }
  return (
    <View style={styles.work} accessibilityLiveRegion="polite">
      {first ? <PixelOrbit color={agentLook(dir.agentById.get(first.agentId)).color} size={13} /> : null}
      <View style={styles.faces}>
        {entries.slice(0, 4).map((e, i) => (
          <View key={e.agentId} style={i > 0 ? styles.overlap : undefined}>
            <AgentFace agentId={e.agentId} size={18} mode="run" />
          </View>
        ))}
      </View>
      <Text variant="small" tone="muted" style={styles.grow} numberOfLines={2}>
        {words}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "baseline", gap: 7 },
  name: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
  work: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingLeft: 18, paddingRight: 14 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -5 },
  grow: { flex: 1 },
  ink: { fontWeight: "600" },
});
