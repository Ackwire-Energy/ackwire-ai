import { Redirect, useLocalSearchParams } from "expo-router";
import { IssueScreen } from "@/features/issues/IssueScreen";
import { issueNumberOf } from "@/features/issues/logic";

/** One issue by its number (`/issues/134`). */
export default function IssueRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const number = issueNumberOf(id);
  if (number === null) return <Redirect href="/issues" />;
  return <IssueScreen key={number} number={number} />;
}
