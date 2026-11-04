import { useRevealVaultItem, useRoles, type VaultAccess, type VaultScope } from "@agenteschat/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, type TextInputProps, View } from "react-native";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Text,
  useToast,
} from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, copyText, MONO, successHaptic } from "../shared/parts";
import { agentOn, type Names, toggleAgent } from "./logic";

/*
 * What the Vault's screens share (ADR 0139): names for the summaries, a field row, the scope choice, the agents'
 * switches, and a saved value with Show and Copy.
 */

/** How long a shown value stays on screen before it hides again. */
const SHOWN_MS = 30_000;

/** Agents', roles' and people's names for the summaries (unknown ones still read as someone). */
export function useVaultNames(): Names {
  const { t } = useTranslation();
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  return useMemo(
    () => ({
      agent: (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent"),
      person: (id: string) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
      role: (id: string) => roles?.find((r) => r.id === id)?.name ?? "",
    }),
    [dir, roles, t],
  );
}

/** The workspace's agents that can be picked (not archived or deleted). */
export function usePickableAgents() {
  const dir = useDirectory();
  return useMemo(() => dir.agents.filter((a) => !a.former), [dir.agents]);
}

/** A labeled field row with its input (read-only as plain text when it can't change). */
export function InputField({
  label,
  value,
  onChange,
  editable = true,
  mono = false,
  ...input
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  editable?: boolean;
  /** Code (a variable's name). */
  mono?: boolean;
} & Pick<
  TextInputProps,
  | "placeholder"
  | "maxLength"
  | "keyboardType"
  | "autoCapitalize"
  | "secureTextEntry"
  | "textContentType"
  | "autoComplete"
  | "autoFocus"
  | "inputMode"
>) {
  const c = useColors();
  const font = mono ? styles.mono : fieldText("callout");
  return (
    <GroupedField label={label}>
      {editable ? (
        <TextInput
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
          spellCheck={false}
          placeholderTextColor={c.faint}
          accessibilityLabel={label}
          style={[font, styles.input, { color: c.ink }]}
          {...input}
        />
      ) : (
        <Text variant="callout" selectable numberOfLines={2} style={[mono ? styles.mono : null, styles.readOnly]}>
          {value}
        </Text>
      )}
    </GroupedField>
  );
}

/** "Personal" or "Team": the team only for who manages the workspace's keys (`manage_credentials`). */
export function ScopeRows({
  scope,
  onChange,
  canTeam,
}: {
  scope: VaultScope;
  onChange: (scope: VaultScope) => void;
  canTeam: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <GroupedHeader>{t("mobile.vault.scope.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="lock"
          label={t("mobile.vault.scope.personal")}
          sub={t("mobile.vault.scope.personalText")}
          subLines={2}
          checked={scope === "personal"}
          onPress={() => onChange("personal")}
        />
        <GroupedRow
          icon="members"
          label={t("mobile.vault.scope.team")}
          sub={canTeam ? t("mobile.vault.scope.teamText") : t("mobile.vault.scope.teamLocked")}
          subLines={2}
          checked={scope === "team"}
          disabled={!canTeam}
          faint={!canTeam}
          onPress={() => onChange("team")}
        />
      </GroupedList>
    </>
  );
}

/**
 * The agents that may use it: "All agents" (new ones included), then each agent's own switch, which "All agents"
 * keeps on. Personal items say they're used only when their owner asks.
 */
export function AgentRows({
  scope,
  access,
  onChange,
  disabled = false,
}: {
  scope: VaultScope;
  access: VaultAccess;
  onChange: (access: VaultAccess) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const agents = usePickableAgents();
  return (
    <>
      <GroupedHeader>{t("mobile.vault.agents.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="agent"
          label={t("mobile.vault.access.allAgents")}
          sub={t("mobile.vault.agents.allText")}
          subLines={2}
          toggle={access.allAgents}
          disabled={disabled}
          onPress={() => onChange({ ...access, allAgents: !access.allAgents })}
        />
        {agents.map((a) => (
          <GroupedRow
            key={a.id}
            leading={<AgentFace agentId={a.id} size={32} live={false} />}
            label={a.name}
            {...(a.role ? { sub: a.role } : {})}
            toggle={agentOn(access, a.id)}
            disabled={disabled || access.allAgents}
            onPress={() => onChange(toggleAgent(access, a.id))}
          />
        ))}
      </GroupedList>
      <GroupedFooter>
        {scope === "personal" ? t("mobile.vault.agents.personalHelp") : t("mobile.vault.agents.teamHelp")}
      </GroupedFooter>
    </>
  );
}

/**
 * The agents' switches in the request card's sheet (a short choice over the conversation): it keeps its own state
 * and tells the card each change.
 */
export function AgentPickSheet({
  initial,
  onChange,
  onDone,
}: {
  initial: Pick<VaultAccess, "allAgents" | "agentIds">;
  onChange: (pick: Pick<VaultAccess, "allAgents" | "agentIds">) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const agents = usePickableAgents();
  const [pick, setPick] = useState(initial);
  const change = (next: Pick<VaultAccess, "allAgents" | "agentIds">) => {
    setPick(next);
    onChange(next);
  };
  return (
    <>
      <SheetTitle title={t("mobile.vault.agents.title")} subtitle={t("mobile.vault.card.agentsText")} />
      <ActionList
        items={[
          {
            key: "all",
            icon: "agent",
            label: t("mobile.vault.access.allAgents"),
            checked: pick.allAgents,
            onPress: () => change({ ...pick, allAgents: !pick.allAgents }),
          },
          ...agents.map((a) => ({
            key: a.id,
            leading: <AgentFace agentId={a.id} size={28} live={false} />,
            label: a.name,
            ...(a.role ? { hint: a.role } : {}),
            checked: agentOn(pick, a.id),
            disabled: pick.allAgents,
            onPress: () => {
              const on = pick.agentIds.includes(a.id);
              change({ ...pick, agentIds: on ? pick.agentIds.filter((id) => id !== a.id) : [...pick.agentIds, a.id] });
            },
          })),
        ]}
      />
      <Button variant="primary" wide label={t("mobile.common.done")} onPress={onDone} />
    </>
  );
}

/**
 * A saved password or key, hidden: "Show" for 30 seconds and "Copy", for who may (each one recorded as a use on the
 * item). The value is asked of the server at that moment and kept only while it shows, never in a cache. A key shows
 * in code type (`code`); a password in the text's own.
 */
export function SavedValue({
  itemId,
  label,
  canReveal,
  code = false,
}: {
  itemId: string;
  label: string;
  canReveal: boolean;
  code?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reveal = useRevealVaultItem(useOrgId());
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState<"show" | "copy" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // Hidden again: the value leaves the screen and the request that brought it.
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setShown(null);
    reveal.reset();
  };
  const ask = async (purpose: "show" | "copy") => {
    setBusy(purpose);
    try {
      const { value } = await reveal.mutateAsync({ itemId, purpose });
      if (purpose === "show") {
        setShown(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(hide, SHOWN_MS);
      } else {
        const copied = await copyText(value);
        reveal.reset();
        if (copied) {
          successHaptic();
          toast({ title: t("mobile.vault.item.copied"), icon: "copy" });
        }
      }
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <GroupedField label={label}>
      <View style={styles.valueRow}>
        <Text
          variant="callout"
          selectable={shown !== null}
          numberOfLines={shown ? 3 : 1}
          style={[styles.grow, shown && code ? styles.mono : null]}
          accessibilityLabel={shown ? undefined : t("mobile.vault.item.hidden")}
        >
          {shown ?? "••••••••••"}
        </Text>
        {canReveal ? (
          <>
            <Pressable
              onPress={() => (shown ? hide() : void ask("show"))}
              disabled={busy !== null}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text variant="subhead" tone={busy === "show" ? "faint" : "ink2"} style={styles.action}>
                {shown ? t("mobile.vault.item.hide") : t("mobile.vault.item.show")}
              </Text>
            </Pressable>
            <Pressable onPress={() => void ask("copy")} disabled={busy !== null} accessibilityRole="button" hitSlop={8}>
              <Text variant="subhead" tone={busy === "copy" ? "faint" : "ink2"} style={styles.action}>
                {t("common.copy")}
              </Text>
            </Pressable>
          </>
        ) : (
          <Text variant="footnote" tone="faint">
            {t("mobile.vault.item.saved")}
          </Text>
        )}
      </View>
    </GroupedField>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  readOnly: { paddingVertical: 12 },
  mono: { fontFamily: MONO, fontSize: 14 },
  grow: { flex: 1, minWidth: 0 },
  valueRow: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 50 },
  action: { fontWeight: "600" },
});
