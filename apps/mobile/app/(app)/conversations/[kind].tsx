import { useLocalSearchParams } from "expo-router";
import { ConversationListScreen } from "@/features/chats/ConversationListScreen";
import { isListKind } from "@/features/chats/logic";

/** A list of one kind from Conversas: threads and missions, or all agents, channels or people. */
export default function ConversationListRoute() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  return <ConversationListScreen kind={isListKind(kind) ? kind : "threads"} />;
}
