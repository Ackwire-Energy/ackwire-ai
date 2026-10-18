import { Redirect, useLocalSearchParams } from "expo-router";
import { ConversationListScreen } from "@/features/chats/ConversationListScreen";
import { isListKind } from "@/features/chats/logic";

/** A section's "Ver todos" from Conversas: all agents, channels or people. Threads and missions are a tab. */
export default function ConversationListRoute() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  if (isListKind(kind)) return <ConversationListScreen kind={kind} />;
  return <Redirect href={kind === "threads" ? "/threads" : "/"} />;
}
