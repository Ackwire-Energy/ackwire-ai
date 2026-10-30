import { Redirect, useLocalSearchParams } from "expo-router";
import { ConversationListScreen } from "@/features/chats/ConversationListScreen";
import { categoryOfListKind, isListKind } from "@/features/chats/logic";

/**
 * A section's "Ver todos" from Conversas: all agents, channels or people, or one channel category's channels
 * (`category-<id>`, ADR 0080). Threads and missions are a tab.
 */
export default function ConversationListRoute() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  if (isListKind(kind)) return <ConversationListScreen kind={kind} />;
  const categoryId = categoryOfListKind(kind ?? "");
  if (categoryId) return <ConversationListScreen kind="channels" categoryId={categoryId} />;
  return <Redirect href={kind === "threads" ? "/threads" : "/"} />;
}
