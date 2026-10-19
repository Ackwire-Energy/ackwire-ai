import { useNotifications } from "@agenteschat/client";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { handoffHref } from "@/features/links/logic";
import { useColors, useOrgId } from "@/features/shared/hooks";

/**
 * A bare link to an agent's request for help in its browser (`agenteschat://handoff/<id>`): the request
 * lives in its conversation, so this finds the conversation (from the request's notice in "Esperando
 * você") and goes there with the card in control; without it, to the activity.
 */
export default function HandoffRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = useOrgId();
  const c = useColors();
  const waiting = useNotifications(orgId, "waiting");
  useEffect(() => {
    if (!waiting.data && !waiting.isError) return;
    const notice = waiting.data?.pages.flatMap((p) => p.items).find((n) => n.source.handoffId === id);
    const href = notice ? handoffHref(id, notice.source.channelId ?? notice.source.dmId, notice.source.threadId) : null;
    router.replace(href && !href.startsWith("/handoff/") ? href : "/activity");
  }, [waiting.data, waiting.isError, id]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}
