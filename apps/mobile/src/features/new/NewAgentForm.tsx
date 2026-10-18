import { useCreateAgent } from "@agenteschat/client";
import { handleFrom } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { AgentAvatar, Button, Icon, SheetScreen, Sky, systemText, Text, useToast } from "@/ui";
import { FIRST_AGENT_EXAMPLES } from "../chats/examples";
import { NEWBORN } from "../chats/Greeting";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { successHaptic, useSurface } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { suggestAgentName } from "./logic";
import { SheetHeader } from "./parts";
import { useOpenDm } from "./useOpenDm";

/**
 * "Novo agente" (MobileIntencional.html): one question first, "O que ele vai fazer?", with the examples
 * as taps that fill it in; the name comes after, already suggested. The rest is suggested and adjusted
 * later. `initialWhat` comes from an example in the empty Conversas. Created, it opens the direct
 * conversation with it.
 */
export function NewAgentForm({ initialWhat = "" }: { initialWhat?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const c = useColors();
  const surface = useSurface();
  const dir = useDirectory();
  const create = useCreateAgent(useOrgId());
  const openDm = useOpenDm();
  const [what, setWhat] = useState(initialWhat);
  // null = the suggestion (it follows the directory until the person types a name).
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? suggestAgentName(dir.agents.map((a) => a.name));
  const ready = name.trim().length >= 2 && what.trim().length > 0;
  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { name: name.trim(), handle: handleFrom(name), instructions: what.trim() },
      {
        onSuccess: (agent) => {
          successHaptic();
          toast({ title: t("mobile.agents.created", { name: agent.name }), agentId: agent.id });
          void openDm({ agentId: agent.id });
        },
        onError: () => toast({ title: t("mobile.agents.createFailed"), icon: "x" }),
      },
    );
  };
  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.agents.new")} />
      <View style={styles.sky}>
        <Sky color={NEWBORN.color} depth={0.9} style={StyleSheet.absoluteFill} />
        <AgentAvatar agent={NEWBORN} size={72} />
      </View>
      <Text variant="display2" style={styles.question} accessibilityRole="header">
        {t("mobile.new.agent.question")}
      </Text>
      <TextArea
        value={what}
        onChangeText={setWhat}
        placeholder={t("mobile.agents.whatPlaceholder")}
        accessibilityLabel={t("mobile.new.agent.question")}
        minHeight={96}
        autoFocus={!initialWhat}
      />
      <View style={styles.examples}>
        {FIRST_AGENT_EXAMPLES.map((ex) => (
          <Pressable
            key={ex.key}
            onPress={() => setWhat(t(`mobile.chats.first.example.${ex.key}.what`))}
            accessibilityRole="button"
            style={({ pressed }) => [styles.pill, surface, pressed && styles.pressed]}
          >
            <Icon name={ex.icon} size={15} color={c.muted} />
            <Text variant="subhead" tone="ink2" style={styles.bold}>
              {t(`mobile.chats.first.example.${ex.key}.title`)}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={[styles.field, surface]}>
        <Text variant="subhead" tone="faint" style={styles.bold}>
          {t("mobile.new.name")}
        </Text>
        <TextInput
          value={name}
          onChangeText={setTyped}
          placeholder={t("mobile.agents.namePlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("mobile.new.name")}
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={submit}
          style={[styles.input, { color: c.ink }]}
        />
      </View>
      <Text variant="footnote" tone="faint" style={styles.fine}>
        {t("mobile.new.agent.fine")}
      </Text>
      <Button
        variant="primary"
        wide
        label={t("mobile.agents.create")}
        disabled={!ready || create.isPending}
        onPress={submit}
      />
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  sky: {
    height: 150,
    marginHorizontal: -18,
    marginTop: -12,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 12,
    overflow: "hidden",
  },
  question: { textAlign: "center", marginHorizontal: 8 },
  examples: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  pressed: { transform: [{ scale: 0.96 }] },
  bold: { fontWeight: "600" },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 50,
    paddingHorizontal: 14,
    borderRadius: 16,
    marginTop: 4,
  },
  input: { flex: 1, paddingVertical: 12, ...systemText("body") },
  fine: { marginHorizontal: 6 },
});
