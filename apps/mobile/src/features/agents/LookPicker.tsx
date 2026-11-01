import { colorKey, gradientOf, isHexColor } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { ColorSheet } from "./ColorSheet";
import { type FullLook, shuffleLook } from "./edit";

/**
 * An agent's look, as the web's picker: color swatches, then eyes and accessories drawn on the agent
 * itself, each in a row that scrolls sideways, and "Sortear". Used by "Criar agente" and "Editar".
 */
export function LookPicker({ look, onChange }: { look: FullLook; onChange: (next: FullLook) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const [picking, setPicking] = useState(false);
  // A new sheet per opening starts from the color shown then; the same key lets it animate away.
  const [opens, setOpens] = useState(0);
  const custom = isHexColor(look.color);
  const set = (patch: Partial<FullLook>) => {
    tapHaptic();
    onChange({ ...look, ...patch });
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Label text={t("look.color")} value={t(`look.colors.${colorKey(look.color)}`)} />
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
          const [top, bottom] = gradientOf(color);
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
        <Pressable
          onPress={() => {
            tapHaptic();
            setOpens((n) => n + 1);
            setPicking(true);
          }}
          accessibilityRole="radio"
          accessibilityLabel={t("look.customColor")}
          accessibilityState={{ selected: custom }}
          hitSlop={4}
          style={[styles.swatchRing, { borderColor: custom ? c.ink : "transparent" }]}
        >
          <LinearGradient
            colors={custom ? gradientOf(look.color) : RAINBOW}
            start={custom ? undefined : { x: 0, y: 0 }}
            end={custom ? undefined : { x: 1, y: 1 }}
            style={styles.swatch}
          >
            {custom ? <Icon name="check" size={16} color="#fff" /> : null}
          </LinearGradient>
        </Pressable>
      </View>
      <ColorSheet
        key={opens}
        open={picking}
        value={look.color}
        onChange={(color) => onChange({ ...look, color })}
        onClose={() => setPicking(false)}
      />

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

/** The ninth swatch before a custom color is picked: the presets' tops, as a rainbow. */
const RAINBOW = ["#f58aa6", "#f3c25c", "#5fcf8b", "#8cc3ff", "#ae8cf7"] as const;

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
