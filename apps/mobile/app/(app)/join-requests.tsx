import { JoinRequestsSheet } from "@/features/members/JoinRequestsSheet";
import { goBack } from "@/features/shared/parts";

/**
 * Requests to join through the invitation link, as a native form sheet over whatever is on screen (presentation
 * set in `_layout`; deep link `agenteschat://join-requests`).
 */
export default function JoinRequestsRoute() {
  return <JoinRequestsSheet onClose={goBack} />;
}
