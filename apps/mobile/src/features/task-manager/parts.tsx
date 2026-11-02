import { type ManagedTask, useCatalog } from "@agenteschat/client";
import { taskClock, taskProgram, taskSince, taskState } from "@agenteschat/client/lib/task-manager";
import { callLogo } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { Button, fieldText, Icon, PixelOrbit, PixelStop, PixelStopped, ProviderLogo, Text, weights } from "@/ui";
import { useCallLogo } from "../chat/ToolCalls";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { isHeld, type RowState, stateText, usingNow } from "./logic";

/**
 * The pieces the task manager's list, a task's screen and an agent's tasks share (ADR 0127): a task's mark and state,
 * what it uses now, its "Parar", and the confirmation that stopping several asks for.
 */

/** A reason's length at most: the server's (ADR 0127). */
const REASON_MAX = 500;

/** A task's mark: the agent's orbit while it works, the waiting clock (amber: it waits on you), queued, stopping. */
export function TaskMark({ state, color, size = 12 }: { state: RowState; color: AgentColorName; size?: number }) {
  const c = useColors();
  return (
    <View style={[styles.mark, { width: size + 4, height: size + 4 }]}>
      {state === "working" ? (
        <PixelOrbit color={color} size={size} />
      ) : state === "stopping" ? (
        <PixelStopped size={size} />
      ) : state === "queued" || isHeld(state) ? (
        <Icon name="clock" size={size + 1} color={c.faint} />
      ) : (
        <Icon name="wait" size={size + 1} color={c.amber} />
      )}
    </View>
  );
}

/** The agent's color, for its orbit. */
export function useAgentColor(agentId: string): AgentColorName {
  return agentLook(useDirectory().anyAgent(agentId)).color;
}

/** "Trabalhando · 6:12", "Espera seu ok · 18:03" (amber: it waits on a person), "Parando…". */
export function StateLine({ task, state, now }: { task: ManagedTask; state: RowState; now: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const color = useAgentColor(task.agentId);
  const waits = state === "ok" || state === "answer";
  return (
    <View style={styles.row}>
      <TaskMark state={state} color={color} />
      <Text
        variant="footnote"
        numberOfLines={1}
        style={[styles.semibold, styles.shrink, { color: waits ? c.amber : c.ink2 }]}
      >
        {stateText(t, state)}
      </Text>
      {state === "stopping" ? null : (
        <Text variant="caption" tone="faint" style={styles.num}>
          · {taskClock(now - taskSince(task))}
        </Text>
      )}
    </View>
  );
}

/**
 * "Usando agora": the program's logo, its name and what it does there, on one line ("Claude Code · Navegador ·
 * página de cancelar", "GitHub · PR #231"); "Pensando" while it works with nothing open yet.
 */
export function UsingLine({ task }: { task: ManagedTask }) {
  const { t, i18n } = useTranslation();
  const logo = useCallLogo();
  const catalog = useCatalog();
  const using = usingNow(t, taskProgram(task), {
    locale: i18n.language,
    appName: (a) => {
      const mark = callLogo(a, catalog.data?.connectors ?? []);
      return mark.kind === "service" ? mark.label : "";
    },
  });
  if (!using)
    return taskState(task) === "working" ? (
      <Text variant="footnote" tone="faint" numberOfLines={1}>
        {t("taskManager.program.thinking")}
      </Text>
    ) : null;
  const said = [using.name, using.detail].filter(Boolean).join(" · ");
  return (
    <View style={styles.row} accessible accessibilityLabel={`${t("taskManager.columns.using")}: ${said}`}>
      {using.brain ? <ProviderLogo id={using.brain} size="chip" /> : using.activity ? logo(using.activity, 20) : null}
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
        <Text variant="footnote" tone="ink2" style={styles.semibold}>
          {using.name}
        </Text>
        {using.detail ? ` · ${using.detail}` : ""}
      </Text>
    </View>
  );
}

/**
 * A task's "Parar": one tap, nothing asked (what it did stays, and the agent is told); a spinner while it stops.
 */
export function StopButton({ label, stopping, onPress }: { label: string; stopping: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  if (stopping)
    return (
      <View style={styles.stopping} accessible accessibilityLabel={t("taskManager.state.stopping")}>
        <ActivityIndicator size="small" color={c.muted} />
      </View>
    );
  return (
    <Button
      variant="secondary"
      size="sm"
      label={label}
      leading={(color) => <PixelStop size={10} color={color} moving={false} />}
      onPress={onPress}
    />
  );
}

/** The optional "why" the agent reads when it is stopped. */
export function ReasonField({
  value,
  onChange,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const c = useColors();
  return (
    <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={placeholder}
        style={[fieldText("subhead"), styles.input, { color: c.ink }]}
        maxLength={REASON_MAX}
        autoFocus={autoFocus}
        returnKeyType="done"
      />
    </View>
  );
}

/**
 * Stopping several of an agent's tasks asks first, in place (never a floating card): how many and whose, that the
 * agent is told, an optional reason it reads, Cancelar and "Parar N".
 */
export function StopConfirm({
  agentId,
  count,
  onCancel,
  onStop,
}: {
  agentId: string;
  count: number;
  onCancel: () => void;
  onStop: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const [why, setWhy] = useState("");
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  return (
    <View style={styles.confirm} accessibilityRole="alert">
      <View style={styles.confirmHead}>
        <AgentFace agentId={agentId} size={24} live={false} />
        <Text variant="footnote" tone="muted" style={styles.grow}>
          <Text variant="footnote" tone="ink" style={styles.semibold}>
            {t("taskManager.confirm.title", { count, name })}
          </Text>
          {` ${t("taskManager.confirm.short", { name })}`}
        </Text>
      </View>
      <View style={styles.confirmRow}>
        <View style={styles.grow}>
          <ReasonField value={why} onChange={setWhy} placeholder={t("taskManager.confirm.reason")} />
        </View>
        <Button variant="ghost" size="sm" label={t("mobile.common.cancel")} onPress={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={t("taskManager.confirm.stop", { count })}
          leading={(color) => <PixelStop size={10} color={color} moving={false} />}
          onPress={() => onStop(why)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  semibold: { fontWeight: weights.semibold },
  shrink: { flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  num: { fontVariant: ["tabular-nums"], flexShrink: 0 },
  // As tall as the button it stands in for, so the row doesn't move.
  stopping: { minWidth: 36, height: 36, alignItems: "center", justifyContent: "center" },
  field: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, minHeight: 36 },
  input: { paddingVertical: 8 },
  confirm: { gap: 10 },
  confirmHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: 6 },
});
