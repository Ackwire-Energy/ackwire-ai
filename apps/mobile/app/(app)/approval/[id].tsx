import { useLocalSearchParams } from "expo-router";
import { ApprovalSheet } from "@/features/approvals/ApprovalSheet";
import { useClosingSheet } from "@/features/shared/parts";

/** A request to approve, over whatever is on screen (deep link `agenteschat://approval/<id>`). */
export default function ApprovalRoute() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const sheet = useClosingSheet();
  return <ApprovalSheet id={id} refuse={mode === "refuse"} open={sheet.open} onClose={sheet.close} />;
}
