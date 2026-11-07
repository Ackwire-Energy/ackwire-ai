import { useLocalSearchParams } from "expo-router";
import { SetupStepScreen } from "@/features/agents/setup/SetupStepScreen";

/** One step of a new agent's setup checklist (`?step=apps|where|who|how`), from the card in its DM or on its screen. */
export default function AgentStepRoute() {
  const { id, step } = useLocalSearchParams<{ id: string; step?: string }>();
  return <SetupStepScreen key={`${id}-${step}`} agentId={id ?? ""} step={step} />;
}
