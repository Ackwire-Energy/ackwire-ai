import { type ErrorBoundaryProps, useLocalSearchParams } from "expo-router";
import { ConsultationScreen } from "@/features/chat/ConsultationScreen";
import { isSafeId } from "@/features/shared/logic";
import { ScreenError } from "@/features/shared/ScreenError";

/** A conversation that breaks while drawing shows what happened in its own screen; back still goes back. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * Two agents' conversation for a question asked in a conversation, read only, from its line in the reply's block
 * (`/consultation/<id>?channel=<channelId>[&group=<ids>]`, `consultationHref`).
 */
export default function ConsultationRoute() {
  const { id, channel, group } = useLocalSearchParams<{ id: string; channel?: string; group?: string }>();
  return (
    <ConsultationScreen
      key={id}
      consultationId={isSafeId(id) ? id : ""}
      channelId={isSafeId(channel) ? channel : ""}
      group={typeof group === "string" ? group.split(",").filter(isSafeId) : undefined}
    />
  );
}
