import { Redirect, useLocalSearchParams } from "expo-router";
import { isSafeId } from "@/features/shared/logic";
import { ComputerQueueScreen } from "@/features/task-manager/ComputerQueueScreen";

/** A computer's line (`/computer-queue/<machineId>`): from the task manager, a task or an agent's tasks (ADR 0127). */
export default function ComputerQueueRoute() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  if (!isSafeId(machineId)) return <Redirect href="/task-manager" />;
  return <ComputerQueueScreen key={machineId} machineId={machineId} />;
}
