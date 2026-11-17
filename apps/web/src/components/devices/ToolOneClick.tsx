import type { Machine, MachineTool } from "@agenteschat/client";
import { useAllowMachineTool, useMachines } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { messageToolOff } from "@agenteschat/client/lib/machine-outages";
import {
  allowsInApp,
  type ToolOneClick,
  toolOnCommand,
  toolOneClick,
  toolWords,
} from "@agenteschat/client/lib/machines";
import { Button, type ButtonProps, SettingNote } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TerminalFallback } from "@/components/machine-bits";
import { OpenPrefsButton, useIsThisMac } from "@/components/ThisMac";
import { useToast } from "@/lib/toast";
import { useOrg } from "../org-context";

/**
 * The one way out where a tool is off on a computer (ADR 0036 §8): its owner turns it on right here, anyone else asks
 * them (they get the same button in their inbox), an app too old says to update it. Nothing where nobody can.
 * `label` replaces "Ligar o navegador" where the click does more ("Ligar e fazer login"); `onAllowed` runs once on.
 * Several tools ask in one button (one ask each) and turn on one button each (`ToolOneClickButtons`).
 */
export function ToolOneClickButton({
  machineId,
  machineName,
  oneClick,
  tool,
  label,
  ariaLabel,
  onAllowed,
  size = "sm",
  variant = "primary",
  disabled,
}: {
  machineId: string;
  machineName: string;
  oneClick: ToolOneClick | null;
  tool: MachineTool | readonly MachineTool[];
  label?: string;
  ariaLabel?: string;
  onAllowed?: () => void;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  /** Turning on waits (its computer offline): the caller says why beside it. Asking never waits. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const allow = useAllowMachineTool(org.id);
  if (!oneClick) return null;
  if (oneClick.kind === "outdated")
    return <span className="small muted">{t("machines.oneClick.outdated", { machine: machineName })}</span>;
  const fail = (err: unknown) => toast.show(errorText(t, err), "error");
  const tools: readonly MachineTool[] = typeof tool === "string" ? [tool] : tool;
  if (oneClick.kind === "ask") {
    const name = firstName(oneClick.ownerName);
    return (
      <Button
        size={size}
        variant={variant === "primary" ? "default" : variant}
        loading={allow.isPending}
        aria-label={ariaLabel}
        onClick={() =>
          Promise.all(tools.map((x) => allow.mutateAsync({ machineId, tool: x, ask: true }))).then(
            () => toast.show(t("machines.oneClick.asked", { name })),
            fail,
          )
        }
      >
        {t("machines.oneClick.ask", { name })}
      </Button>
    );
  }
  return (
    <Button
      size={size}
      variant={variant}
      loading={allow.isPending}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() =>
        allow.mutate(
          { machineId, tool: tools[0] as MachineTool },
          {
            onSuccess: () =>
              onAllowed ? onAllowed() : toast.show(t("machines.oneClick.done", { machine: machineName })),
            onError: fail,
          },
        )
      }
    >
      {label ?? t("machines.oneClick.allow", { tool: toolWords(t, tools[0] as MachineTool) })}
    </Button>
  );
}

/** What one click does for this person on `machine` (null: nothing from here). */
export function useToolOneClick(machine: Machine | null | undefined) {
  const { me } = useOrg();
  return toolOneClick(machine, me.user.id);
}

/**
 * The way out where a program is off on a computer, under the line that says so (every screen that says it uses this
 * one): whoever connected it turns it on here, or waits for it to come online, anyone else asks them, an app too old
 * says to update it there, and in the app on that very computer its Preferences → Ferramentas turn it on instead.
 * `children`: the screen's other ways on the same line (a key). On a computer that may have no app, the command for
 * whoever turns it on there.
 */
export function ToolOffWayOut({
  machine,
  tool,
  children,
}: {
  machine: Machine;
  tool: MachineTool;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const oneClick = useToolOneClick(machine);
  const here = useIsThisMac(org.id, machine.id);
  const offline = oneClick?.kind === "allow" && !machine.online;
  const line = offline
    ? t("machines.oneClick.offline", { machine: machine.name, tool: toolWords(t, tool) })
    : oneClick?.kind === "outdated" && !here
      ? t("machines.oneClick.outdated", { machine: machine.name })
      : null;
  // In the app on that very computer its Preferences turn the program on at any app version: no update needed.
  const button =
    oneClick?.kind === "allow" || oneClick?.kind === "ask" ? (
      <MachineToolButton machine={machine} tool={tool} disabled={offline} />
    ) : here ? (
      <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
    ) : null;
  const command =
    machine.kind === "managed" || oneClick?.kind === "ask" || allowsInApp(machine.os)
      ? null
      : toolOnCommand(machine, tool);
  return (
    <>
      {line && <SettingNote icon="computer">{line}</SettingNote>}
      {(button || children) && (
        <div className="ac-acts tool-way">
          {button}
          {children}
        </div>
      )}
      <TerminalFallback command={command} />
    </>
  );
}

/**
 * Under an agent's message that needs a switch on its computer (a wait for its CLI or commands, a call refused for
 * the browser or the desktop): the one click, until it is on. The message says the cause; this is its way out.
 */
export function WaitToolOffAction({ meta }: { meta: Record<string, unknown> | null | undefined }) {
  const { org } = useOrg();
  const off = messageToolOff(meta);
  const machine = useMachines(org.id, Boolean(off)).data?.find((m) => m.id === off?.machineId);
  const tools = off && machine ? off.tools.filter((tool) => machine.access?.tools[tool] !== true) : [];
  if (!machine || tools.length === 0) return null;
  return (
    <div className="ac-acts" style={{ marginTop: "var(--space-2)" }}>
      <MachineToolButtons machine={machine} tools={tools} />
    </div>
  );
}

/** The same, for a computer the screen already has: who may do what follows from who paired it. */
export function MachineToolButton({
  machine,
  tool,
  ...rest
}: { machine: Machine; tool: MachineTool | readonly MachineTool[] } & Omit<
  Parameters<typeof ToolOneClickButton>[0],
  "machineId" | "machineName" | "oneClick" | "tool"
>) {
  const { me } = useOrg();
  return (
    <ToolOneClickButton
      machineId={machine.id}
      machineName={machine.name}
      oneClick={toolOneClick(machine, me.user.id)}
      tool={tool}
      {...rest}
    />
  );
}

/**
 * The switches a screen still needs on `machine`: one button each for whoever connected it, one ask for all of them
 * for anyone else.
 */
export function MachineToolButtons({
  machine,
  tools,
  onAllowed,
}: {
  machine: Machine;
  tools: readonly MachineTool[];
  onAllowed?: () => void;
}) {
  const oneClick = useToolOneClick(machine);
  if (tools.length === 0) return null;
  if (oneClick?.kind === "ask") return <MachineToolButton machine={machine} tool={tools} />;
  return (
    <>
      {tools.map((tool) => (
        <MachineToolButton key={tool} machine={machine} tool={tool} {...(onAllowed ? { onAllowed } : {})} />
      ))}
    </>
  );
}
