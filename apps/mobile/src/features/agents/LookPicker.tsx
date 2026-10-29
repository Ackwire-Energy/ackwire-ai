import { AGENT_GRADIENTS } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { type FullLook, shuffleLook } from "./edit";

/**
 * An agent's look, as the web's picker: color swatches, then eyes and accessories drawn on the agent
 * itself, each in a row that scrolls sideways, and "Sortear". Used by "Criar agente" and "Editar".
 */
export function LookPicker({ look, onChange }: { look: FullLook; onChange: (next: FullLook) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const set = (patch: Partial<FullLook>) => {
    tapHaptic();
    onChange({ ...look, ...patch });
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Label text={t("look.color")} value={t(`look.colors.${look.color}`)} />
        <Button
          variant="secondary"
          size="sm"
          icon="sparkle"
          label={t("newAgent.shuffle")}
          onPress={() => {
            tapHaptic();
            onChange(shuffleLook(look));
          }}
        />
      </View>
      <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel={t("look.color")}>
        {AGENT_COLORS.map((color) => {
          const [top, bottom] = AGENT_GRADIENTS[color];
          const on = look.color === color;
          return (
            <Pressable
              key={color}
              onPress={() => set({ color })}
              accessibilityRole="radio"
              accessibilityLabel={t(`look.colors.${color}`)}
              accessibilityState={{ selected: on }}
              hitSlop={4}
              style={[styles.swatchRing, { borderColor: on ? c.ink : "transparent" }]}
            >
              <LinearGradient colors={[top, bottom]} style={styles.swatch}>
                {on ? <Icon name="check" size={16} color="#fff" /> : null}
              </LinearGradient>
            </Pressable>
          );
        })}
      </View>

      <Label text={t("look.eyes")} value={t(`look.eyesNames.${look.eyes}`)} />
      <Choices label={t("look.eyes")}>
        {AGENT_EYES.map((eyes) => (
          <Choice key={eyes} on={look.eyes === eyes} label={t(`look.eyesNames.${eyes}`)} onPress={() => set({ eyes })}>
            <AgentAvatar agent={{ ...look, eyes, accessory: "none" }} size={52} framed={false} live={false} />
          </Choice>
        ))}
      </Choices>

      <Label text={t("look.accessory")} value={t(`look.accessories.${look.accessory}`)} />
      <Choices label={t("look.accessory")}>
        {AGENT_ACCESSORIES.map((accessory) => (
          <Choice
            key={accessory}
            on={look.accessory === accessory}
            label={t(`look.accessories.${accessory}`)}
            onPress={() => set({ accessory })}
          >
            <AgentAvatar agent={{ ...look, accessory }} size={52} framed={false} live={false} />
          </Choice>
        ))}
      </Choices>
    </View>
  );
}

function Label({ text, value }: { text: string; value: string }) {
  return (
    <Text variant="footnote" tone="faint" style={styles.label}>
      {text}
      <Text variant="footnote" tone="muted">
        {`  ${value}`}
      </Text>
    </Text>
  );
}

function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.choices}
      style={styles.bleed}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {children}
    </ScrollView>
  );
}

function Choice({
  on,
  label,
  onPress,
  children,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [
        styles.choice,
        { backgroundColor: c.sunken, borderColor: on ? c.ink : "transparent" },
        pressed && styles.pressed,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { marginTop: 4 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  swatchRing: { borderWidth: 2, borderRadius: 999, padding: 2 },
  swatch: { width: 34, height: 34, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  bleed: { marginHorizontal: -18 },
  choices: { gap: 8, paddingHorizontal: 18 },
  choice: { width: 68, height: 68, borderRadius: 20, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  pressed: { transform: [{ scale: 0.96 }] },
});
