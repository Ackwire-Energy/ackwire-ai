import { useAgentStatuses, useAiStatus, useOverview, useRoutines } from "@agenteschat/client";
import { type FirstStep, firstSteps, startingOut, stepPermissions } from "@agenteschat/client/lib/home";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { Icon, ListRow } from "@/ui";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { CollapsibleSection } from "./HomeSection";
import { FIRST_STEP_SCREENS } from "./logic";

/** The section's key among Conversas' closed ones. */
const SECTION = "steps";

/** The first steps while the workspace is starting out; null once it isn't, or before their checks have loaded. */
function useFirstSteps(): FirstStep[] | null {
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const ai = useAiStatus(orgId);
  const statuses = useAgentStatuses(orgId);
  const overview = useOverview(orgId);
  const routines = useRoutines(orgId);
  if (dir.loading || !ai.isFetched || !statuses.isFetched || !overview.isFetched || !routines.isFetched) return null;
  const steps = firstSteps({
    agents: dir.agents.length,
    hasAi: ai.data?.any ?? true,
    asked: (statuses.data ?? []).some((s) => s.activeAt !== null),
    people: overview.data?.people ?? 1,
    routines: routines.data?.length ?? 0,
    may: stepPermissions(org, meId, dir.agents),
  });
  return startingOut(steps) ? steps : null;
}

/**
 * "Primeiros passos" on Conversas (ADR 0108), the steps of Início's card on the web: each a row that does it, a done
 * one checked. A section like the others, closed and opened the same way, while the workspace is starting out (an
 * agent, its AI or a first request still to do): with no hide of its own, it leaves once those are done.
 */
export function FirstSteps({ collapsed, onToggle }: { collapsed: readonly string[]; onToggle: (key: string) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const steps = useFirstSteps();
  if (!steps) return null;
  return (
    <CollapsibleSection
      title={t("home.steps.title")}
      count={steps.length}
      collapsed={collapsed.includes(SECTION)}
      onToggle={() => onToggle(SECTION)}
    >
      {steps.map((s, i) => {
        const title = t(`home.steps.${s.id}.title`);
        // The web's "ask" line points at Início's composer, which the phone doesn't have.
        const text = s.done
          ? t("home.steps.done")
          : s.id === "ask"
            ? t("mobile.home.stepAsk")
            : t(`home.steps.${s.id}.text`);
        return (
          <ListRow
            key={s.id}
            divider={i > 0}
            leading={
              <Tile size={44}>
                <Icon
                  name={s.done ? "check" : FIRST_STEP_SCREENS[s.id].icon}
                  size={22}
                  color={s.done ? c.ink : c.muted}
                />
              </Tile>
            }
            title={title}
            sub={text}
            trailing={s.done ? null : <Icon name="right" size={16} color={c.faint} />}
            disabled={s.done}
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${text}`}
            accessibilityState={{ disabled: s.done }}
            onPress={() => router.push(FIRST_STEP_SCREENS[s.id].href as never)}
          />
        );
      })}
    </CollapsibleSection>
  );
}
