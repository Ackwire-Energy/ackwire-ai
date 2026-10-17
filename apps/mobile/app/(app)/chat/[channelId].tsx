import { useLocalSearchParams } from "expo-router";
import { ChatScreen } from "@/features/chat/ChatScreen";
import { isSafeId } from "@/features/shared/logic";
import { FocusLive } from "@/features/shared/parts";

/** A conversation (deep link `agenteschat://chat/<channelId>?thread=<rootId>`). */
export default function ChatRoute() {
  const { channelId, thread } = useLocalSearchParams<{ channelId: string; thread?: string }>();
  return (
    <FocusLive>
      <ChatScreen
        key={`${channelId}:${thread ?? ""}`}
        channelId={channelId}
        threadId={isSafeId(thread) ? thread : null}
      />
    </FocusLive>
  );
}
