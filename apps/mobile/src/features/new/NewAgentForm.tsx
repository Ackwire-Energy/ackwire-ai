import { useCreateAgent } from "@agenteschat/client";
import { handleFrom } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { AgentAvatar, Button, SheetScreen, Sky, Text, useToast } from "@/ui";
import { NEWBORN } from "../chats/Greeting";
import { useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { SheetHeader } from "./parts";
import { useOpenDm } from "./useOpenDm";

/**
 * "Novo agente": its name and what it does (the rest is suggested and adjusted later), under the sky
 * where it is about to be born. `initialWhat` comes from an example in the empty Conversas. Created, it
 * opens the direct conversation with it.
 */
export function NewAgentForm({ initialWhat = "" }: { initialWhat?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateAgent(useOrgId());
  const openDm = useOpenDm();
  const [name, setName] = useState("");
  const [what, setWhat] = useState(initialWhat);
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
        <AgentAvatar agent={NEWBORN} size={84} />
      </View>
      <Text variant="small" tone="muted" style={styles.intro}>
        {t("mobile.agents.newIntro")}
      </Text>
      <Text variant="label" style={styles.label}>
        {t("mobile.new.name")}
      </Text>
      <TextArea
        value={name}
        onChangeText={setName}
        placeholder={t("mobile.agents.namePlaceholder")}
        accessibilityLabel={t("mobile.new.name")}
        multiline={false}
        minHeight={50}
        autoFocus={!initialWhat}
        returnKeyType="next"
      />
      <Text variant="label" style={styles.label}>
        {t("mobile.new.what")}
      </Text>
      <TextArea
        value={what}
        onChangeText={setWhat}
        placeholder={t("mobile.agents.whatPlaceholder")}
        accessibilityLabel={t("mobile.new.what")}
        minHeight={104}
      />
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
    height: 170,
    marginHorizontal: -18,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 14,
    overflow: "hidden",
  },
  intro: { textAlign: "center", marginHorizontal: 8, marginBottom: 6 },
  label: { paddingHorizontal: 4, marginTop: 4 },
});
