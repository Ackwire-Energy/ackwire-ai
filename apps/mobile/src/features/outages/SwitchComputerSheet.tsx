import {
  moveErrorOf,
  pickedTargetKey,
  type TargetOption,
  targetOptions,
} from "@agenteschat/client/lib/machine-outages";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Button, Card, Chip, Icon, SheetScreen, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { successHaptic, Tile, tapHaptic } from "../shared/parts";
import { computerIcon, type MachineOutage, moveToast, sheetDesc, targetText, waitingText } from "./logic";
import { useMachineOutages, useMoveAgents } from "./queries";

/**
 * "Trocar o computador" (ComputadorOffline.html, Celular `.sheet`), a native form sheet: "Para onde" (only the
 * targets that can run the waiting agents' brains; one that can't take them now is disabled with the reason),
 * "Quem troca" (a check per agent with what it has waiting), the plain hint that a task that already changed
 * files on the old computer waits for it, then "Trocar N agentes" and "Agora não". The result is a toast.
 */
export function SwitchComputerSheet({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const q = useMachineOutages();
  const outage = q.data?.outages.find((o) => o.machineId === machineId) ?? null;

  let body: ReactNode;
  if (!q.data) {
    body = q.isError ? <Text tone="muted">{t("mobile.app.failed")}</Text> : <ActivityIndicator color={c.muted} />;
  } else if (!outage || outage.agents.length === 0) {
    body = (
      <>
        <Text variant="body" tone="muted">
          {outage ? t("mobile.outage.sheet.gone", { computer: outage.name }) : t("mobile.outage.card.backSome")}
        </Text>
        <Button variant="secondary" wide label={t("mobile.common.close")} onPress={onClose} />
      </>
    );
  } else {
    body = <SwitchForm key={outage.machineId} outage={outage} targets={q.targets} onClose={onClose} />;
  }
  return (
    <SheetScreen>
      <SheetTitle title={t("mobile.outage.sheet.title")} />
      {body}
    </SheetScreen>
  );
}

function SwitchForm({
  outage: o,
  targets,
  onClose,
}: {
  outage: MachineOutage;
  targets: Parameters<typeof targetOptions>[1];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const move = useMoveAgents();
  // Everyone switches unless unchecked (agents that start waiting while the sheet is open join checked).
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = useMemo(
    () => new Set(o.agents.filter((a) => !unchecked.has(a.agentId)).map((a) => a.agentId)),
    [o.agents, unchecked],
  );
  const options = useMemo(() => targetOptions(o, targets, chosen), [o, targets, chosen]);
  const targetKey = pickedTargetKey(options, picked);
  const target = options.find((x) => x.key === targetKey) ?? null;
  const count = chosen.size;

  const toggle = (agentId: string) => {
    tapHaptic();
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };
  const submit = () => {
    if (!target || count === 0 || move.isPending) return;
    move.mutate(
      { machineId: o.machineId, agentIds: [...chosen], target: target.target },
      {
        onSuccess: (r) => {
          const said = moveToast(t, r, o.name);
          if (said.ok) successHaptic();
          toast({
            title: said.title,
            ...(said.subtitle ? { subtitle: said.subtitle } : {}),
            icon: said.ok ? "check" : "x",
          });
          onClose();
        },
        onError: (err) => {
          const code = moveErrorOf(err);
          toast({
            title: code
              ? t(`mobile.outage.error.${code.slice("machine.".length)}`, { computer: o.name })
              : t("mobile.app.failed"),
            icon: "x",
          });
        },
      },
    );
  };

  return (
    <>
      <Text variant="body" tone="muted">
        {sheetDesc(t, o, chosen)}
      </Text>

      <SectionLabel label={t("mobile.outage.sheet.where")} />
      {options.length > 0 ? (
        <Card>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("mobile.outage.sheet.where")}>
            {options.map((x, i) => (
              <TargetRow
                key={x.key}
                option={x}
                selected={x.key === targetKey}
                divider={i > 0}
                onPress={() => {
                  tapHaptic();
                  setPicked(x.key);
                }}
              />
            ))}
          </View>
        </Card>
      ) : null}
      {!options.some((x) => x.enabled) ? (
        <Text variant="small" tone="muted">
          {t("mobile.outage.sheet.none")}
        </Text>
      ) : null}

      <SectionLabel label={t("mobile.outage.sheet.who")} />
      <Card>
        {o.agents.map((a, i) => {
          const on = chosen.has(a.agentId);
          const waiting = waitingText(t, a);
          return (
            <Pressable
              key={a.agentId}
              onPress={() => toggle(a.agentId)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${a.name}, ${waiting}`}
              style={({ pressed }) => [
                styles.row,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
                pressed && { backgroundColor: c.sunken },
              ]}
            >
              <Icon name={on ? "checkc" : "circle"} size={22} color={on ? c.ink : c.faint} />
              <AgentFace agentId={a.agentId} size={28} mode="rest" live={false} />
              <Text variant="body" tone="ink" numberOfLines={1} style={styles.grow}>
                {a.name}
              </Text>
              <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
                {waiting}
              </Text>
            </Pressable>
          );
        })}
      </Card>

      <View style={[styles.hint, { backgroundColor: c.sunken }]}>
        <Icon name="help" size={16} color={c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {t("mobile.outage.sheet.hint", { computer: o.name })}
        </Text>
      </View>

      <View style={styles.acts}>
        <Button
          variant="primary"
          wide
          label={t("mobile.outage.sheet.submit", { count })}
          disabled={!target || count === 0 || move.isPending}
          onPress={submit}
        />
        <Button variant="ghost" wide label={t("mobile.outage.sheet.later")} onPress={onClose} />
      </View>
      <Text variant="footnote" tone="faint" style={styles.note}>
        {t("mobile.outage.sheet.note", { computer: o.name })}
      </Text>
    </>
  );
}

/** The small heading above a group (`.sect-h`). */
function SectionLabel({ label }: { label: string }) {
  return (
    <Text variant="footnote" tone="muted" accessibilityRole="header" style={styles.section}>
      {label}
    </Text>
  );
}

/** One target (our option row): the computer's tile, its name and tag, the line under it, a check when chosen. */
function TargetRow({
  option: x,
  selected,
  divider,
  onPress,
}: {
  option: TargetOption;
  selected: boolean;
  divider: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const text = targetText(t, x);
  return (
    <Pressable
      onPress={onPress}
      disabled={!x.enabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !x.enabled }}
      accessibilityLabel={[text.title, text.tag, text.desc].filter(Boolean).join(", ")}
      style={({ pressed }) => [
        styles.row,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
        pressed && { backgroundColor: c.sunken },
        !x.enabled && styles.off,
      ]}
    >
      <Tile icon={computerIcon(x.platform, x.kind === "cloud")} size={36} />
      <View style={styles.grow}>
        <View style={styles.titleLine}>
          <Text variant="body" tone="ink" numberOfLines={1} style={styles.shrink}>
            {text.title}
          </Text>
          {text.tag ? <Chip label={text.tag} /> : null}
        </View>
        {text.desc ? (
          <Text variant="small" tone="faint" numberOfLines={2}>
            {text.desc}
          </Text>
        ) : null}
      </View>
      {selected ? <Icon name="check" size={18} color={c.ink} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { fontWeight: "600", marginTop: 6, marginHorizontal: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 54,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  off: { opacity: 0.5 },
  hint: { flexDirection: "row", gap: 8, padding: 12, borderRadius: 14 },
  acts: { gap: 8, marginTop: 4 },
  note: { textAlign: "center", marginHorizontal: 6 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
});
