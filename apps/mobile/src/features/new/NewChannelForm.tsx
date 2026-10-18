import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { Button, Icon, SheetScreen, systemText, Text, useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { closeSheetsAndOpen, SheetHeader } from "./parts";

/** "Novo canal": only the name; people and agents are called in later, by name. */
export function NewChannelForm() {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const surface = useSurface();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = name.trim().replace(/^#/, "");
  const submit = () => {
    if (!clean || busy) return;
    setBusy(true);
    api.chat
      .createChannel(orgId, { name: clean })
      .then((ch) => {
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
        closeSheetsAndOpen(chatHref(ch.id));
      })
      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }))
      .finally(() => setBusy(false));
  };
  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.chats.newChannel")} icon="back" />
      <View style={[styles.field, surface]}>
        <Icon name="hash" size={20} color={c.faint} />
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("mobile.chats.channelPlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("mobile.chats.newChannel")}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          style={[styles.input, { color: c.ink }]}
        />
      </View>
      <Text variant="footnote" tone="faint" style={styles.fine}>
        {t("mobile.new.channelFine")}
      </Text>
      <Button
        variant="primary"
        wide
        label={t("mobile.chats.createChannel")}
        disabled={!clean || busy}
        onPress={submit}
      />
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 50,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  input: { flex: 1, paddingVertical: 12, ...systemText("body") },
  fine: { marginHorizontal: 6, marginBottom: 4 },
});
