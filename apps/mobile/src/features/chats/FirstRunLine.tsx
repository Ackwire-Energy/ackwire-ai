import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { Icon, ListRow } from "@/ui";
import { useOpenDm } from "../new/useOpenDm";
import { useFirstRun } from "../right-hand/FirstRun";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";

/**
 * While the right hand's first-run checklist has a row left (ADR 0155 §6), Conversas has one line back to it, as
 * Início on the web: never a second list that could disagree with the card.
 */
export function FirstRunLine() {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const openDm = useOpenDm();
  const lodi = dir.agents.find(isRightHand);
  const run = useFirstRun(lodi, null);
  if (!lodi || !run.ready || run.state !== "open") return null;
  const text = t("home.firstRun", { done: run.steps.filter((s) => run.done.has(s)).length, total: run.steps.length });
  return (
    <ListRow
      leading={<AgentFace agentId={lodi.id} size={44} />}
      title={text}
      trailing={<Icon name="right" size={16} color={c.faint} />}
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={() => void openDm({ agentId: lodi.id })}
    />
  );
}
