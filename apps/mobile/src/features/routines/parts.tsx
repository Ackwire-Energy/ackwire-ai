import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { useDirectory } from "../shared/hooks";

/**
 * The routine's agent can't read what its trigger needs (none of the mailboxes, the picked one, a connection), as the
 * web's: the cause, and its profile, where who connected it gives the agent access.
 */
export function AgentAccessNote({
  agentId,
  words,
  values,
}: {
  agentId: string;
  words: string;
  values?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const name = useDirectory().agentById.get(agentId)?.name ?? "";
  return (
    <View style={accessStyles.note}>
      <Note icon="lock">{t(words, { ...agentGrammar(name), ...values })}</Note>
      <Button
        variant="secondary"
        size="sm"
        label={t("mail.routine.giveAccess")}
        onPress={() => router.push(`/agent/${agentId}` as never)}
      />
    </View>
  );
}

const accessStyles = StyleSheet.create({
  note: { gap: 8, paddingHorizontal: 16, paddingTop: 12, alignItems: "flex-start" },
});
