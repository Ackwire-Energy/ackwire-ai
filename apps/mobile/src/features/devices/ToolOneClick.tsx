import type { Machine, MachineTool, Message } from "@agenteschat/client";
import { useAllowMachineTool, useMachines } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { messageToolOff } from "@agenteschat/client/lib/machine-outages";
import { type ToolOneClick, toolOneClick, toolWords } from "@agenteschat/client/lib/machines";
import { useTranslation } from "react-i18next";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Button, Text, useToast } from "@/ui";
import { useMeId, useOrgId } from "../shared/hooks";

/**
 * The phone's one way out where a tool is off on a computer, as the web's (ADR 0036 §8): its owner turns it on here,
 * anyone else asks them, an app too old says to update it; nothing where nobody can. Several tools: one ask for all.
 */
export function ToolOneClickButton({
  machineId,
  machineName,
  oneClick,
  tool,
  label,
  onAllowed,
  disabled = false,
}: {
  machineId: string;
  machineName: string;
  oneClick: ToolOneClick | null;
  tool: MachineTool | readonly MachineTool[];
  label?: string;
  onAllowed?: () => void;
  /** Turning on waits (its computer offline): the caller says why beside it. Asking never waits. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const allow = useAllowMachineTool(useOrgId());
  if (!oneClick) return null;
  if (oneClick.kind === "outdated")
    return (
      <Text variant="caption" tone="muted">
        {t("machines.oneClick.outdated", { machine: machineName })}
      </Text>
    );
  const fail = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  const tools: readonly MachineTool[] = typeof tool === "string" ? [tool] : tool;
  if (oneClick.kind === "ask") {
    const name = firstName(oneClick.ownerName);
    return (
      <Button
        variant="secondary"
        size="sm"
        label={t("machines.oneClick.ask", { name })}
        loading={allow.isPending}
        onPress={() =>
          Promise.all(tools.map((x) => allow.mutateAsync({ machineId, tool: x, ask: true }))).then(
            () => toast({ title: t("machines.oneClick.asked", { name }) }),
            fail,
          )
        }
      />
    );
  }
  return (
    <Button
      variant="primary"
      size="sm"
      label={label ?? t("machines.oneClick.allow", { tool: toolWords(t, tools[0] as MachineTool) })}
      loading={allow.isPending}
      disabled={disabled}
      onPress={() =>
        allow.mutate(
          { machineId, tool: tools[0] as MachineTool },
          {
            onSuccess: () =>
              onAllowed ? onAllowed() : toast({ title: t("machines.oneClick.done", { machine: machineName }) }),
            onError: fail,
          },
        )
      }
    />
  );
}

/**
 * Under an agent's message that needs a switch on its computer (a wait for its CLI or commands, a call refused for
 * the browser or the desktop): the one click, until on. Anyone but whoever connected it asks for all in one.
 */
export function WaitToolOffAction({ message }: { message: Pick<Message, "meta"> }) {
  const meId = useMeId();
  const off = messageToolOff(message.meta);
  const machine = useMachines(useOrgId(), Boolean(off)).data?.find((m) => m.id === off?.machineId);
  const tools = off && machine ? off.tools.filter((tool) => machine.access?.tools[tool] !== true) : [];
  if (!machine || tools.length === 0) return null;
  const ask = toolOneClick(machine, meId)?.kind === "ask";
  return (
    <View style={styles.wait}>
      {ask ? (
        <MachineToolButton machine={machine} tool={tools} />
      ) : (
        tools.map((tool) => <MachineToolButton key={tool} machine={machine} tool={tool} />)
      )}
    </View>
  );
}

/**
 * The way out where a program is off on a computer, under the line that says so, as the web's `ToolOffWayOut`:
 * whoever connected it turns it on here, or waits for it to come online, anyone else asks them, an app too old says to
 * update it there. Nothing on the Cloud's own computer, or one with nobody behind it.
 */
export function ToolOffWayOut({
  machine,
  tool,
  style,
}: {
  machine: Machine;
  tool: MachineTool;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const oneClick = toolOneClick(machine, useMeId());
  if (!oneClick) return null;
  if (oneClick.kind === "outdated")
    return (
      <View style={style}>
        <Text variant="caption" tone="muted">
          {t("machines.oneClick.outdated", { machine: machine.name })}
        </Text>
      </View>
    );
  const offline = oneClick.kind === "allow" && !machine.online;
  return (
    <View style={[styles.way, style]}>
      {offline ? (
        <Text variant="caption" tone="muted">
          {t("machines.oneClick.offline", { machine: machine.name, tool: toolWords(t, tool) })}
        </Text>
      ) : null}
      <MachineToolButton machine={machine} tool={tool} disabled={offline} />
    </View>
  );
}

const styles = StyleSheet.create({
  wait: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  way: { gap: 8, alignItems: "flex-start" },
});

/** The same for a computer the screen already has. */
export function MachineToolButton({
  machine,
  tool,
  label,
  onAllowed,
  disabled,
}: {
  machine: Machine;
  tool: MachineTool | readonly MachineTool[];
  label?: string;
  onAllowed?: () => void;
  disabled?: boolean;
}) {
  const meId = useMeId();
  return (
    <ToolOneClickButton
      machineId={machine.id}
      machineName={machine.name}
      oneClick={toolOneClick(machine, meId)}
      tool={tool}
      disabled={disabled}
      {...(label ? { label } : {})}
      {...(onAllowed ? { onAllowed } : {})}
    />
  );
}
