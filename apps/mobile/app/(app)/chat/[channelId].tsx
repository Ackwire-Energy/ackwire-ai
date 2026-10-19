import { useLocalSearchParams } from "expo-router";
import { ChatScreen } from "@/features/chat/ChatScreen";
import { isSafeId } from "@/features/shared/logic";
import { FocusLive } from "@/features/shared/parts";

/**
 * A conversation (deep link `agenteschat://chat/<channelId>?thread=<rootId>`). `handoff=<id>`: an agent's
 * request for help in its browser, whose card opens in place, in control.
 */
export default function ChatRoute() {
  const { channelId, thread, handoff } = useLocalSearchParams<{
    channelId: string;
    thread?: string;
    handoff?: string;
  }>();
  return (
    <FocusLive>
      <ChatScreen
        key={`${channelId}:${thread ?? ""}`}
        channelId={channelId}
        threadId={isSafeId(thread) ? thread : null}
        handoffId={isSafeId(handoff) ? handoff : null}
      />
    </FocusLive>
  );
}
