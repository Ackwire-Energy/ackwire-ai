import type { Agent } from "@agenteschat/client";
import { WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { planMark, SCENE_PLANS } from "@agenteschat/client/lib/no-ai";
import { rightHandOf, sceneTeam } from "@agenteschat/client/lib/right-hand";
import {
  ComputerPortrait,
  cx,
  DAWN_MS,
  type Expression,
  PixelSky,
  ProviderLogo,
  teamSky,
  useDawn,
} from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import "./arrival.css";

// The onboarding's AI step takes it from here.
export { sceneTeam };

/*
 * The team on a pixel sky (ADR 0160): the agents the person has, standing under a sky that is night while they have
 * no AI and day once they think. Decorative, as every sky is: what it says is said in words beside it.
 */

export { DAWN_MS, teamSky, useDawn };

export interface SceneAgent {
  id: string;
  name: string;
}

/**
 * `agents` (at most four, the one that leads drawn larger) under the sky. `asleep`: every one sleeps; else they are
 * up, `writing` or making `expression`. `children` stand beside them (a plan's mark, an envelope).
 */
export function TeamScene({
  agents,
  lead,
  day = 1,
  asleep = false,
  writing = false,
  expression,
  shape = "band",
  quiet = 0,
  className,
  children,
}: {
  agents: readonly SceneAgent[];
  /** The agent drawn larger (the right hand); none: the first. */
  lead?: string;
  day?: number;
  asleep?: boolean;
  writing?: boolean;
  expression?: Expression;
  /** `band`: a strip over a dialog. `tall`: a dialog's whole side, the team at its foot. */
  shape?: "band" | "tall";
  /** The top share of the sky kept without stars, for words over it. */
  quiet?: number;
  className?: string;
  children?: ReactNode;
}) {
  const options = useMemo(() => teamSky(day, quiet), [day, quiet]);
  const first = lead ?? agents[0]?.id;
  return (
    <div className={cx("team-scene", `team-scene--${shape}`, className)} aria-hidden="true">
      <PixelSky options={options} />
      <div className="team-scene__row">
        <div className="team-scene__cast" data-awake={asleep ? undefined : ""}>
          {agents.map((a, i) => (
            <span
              key={a.id}
              className="team-scene__agent"
              data-lead={a.id === first ? "" : undefined}
              style={{ "--i": i } as CSSProperties}
            >
              <AgentAvatar
                agentId={a.id}
                name={a.name}
                size="lg"
                framed={false}
                state={asleep ? "sleeping" : writing ? "writing" : "idle"}
                expression={asleep || writing ? undefined : expression}
              />
            </span>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

type ScenePlan = (typeof SCENE_PLANS)[number];
export const isScenePlan = (choice: string | null | undefined): choice is ScenePlan =>
  SCENE_PLANS.includes(choice as ScenePlan);

/** Pixels between two things on the sky, `--n` counted from the AI's side so the walk goes toward the team. */
function Trail({ from, state }: { from: number; state: "walk" | "done" | undefined }) {
  return (
    <span className="team-scene__trail" data-state={state}>
      {[4, 3, 2, 1, 0].map((n) => (
        <i key={n} style={{ "--n": from + n } as CSSProperties} />
      ))}
    </span>
  );
}

/**
 * The band over "Conectar uma IA": the team asleep under the night, the workspace's computer and the AIs' marks, with
 * pixels walking from the marks to the team while there is something to connect (`waiting`: a plan comes first, so
 * nothing walks). `connected`: day comes and the team gets up. `lit`: the plan the person picked, the others dimmed.
 */
export function ConnectScene({
  agents,
  connected,
  waiting = false,
  lit,
}: {
  agents: readonly (SceneAgent & Pick<Agent, "builtin">)[];
  connected: boolean;
  waiting?: boolean;
  lit?: ScenePlan | null;
}) {
  const day = useDawn(connected);
  const lead = rightHandOf(agents);
  const team = sceneTeam(agents, lead).slice(0, 3);
  const state = connected ? "done" : waiting ? undefined : "walk";
  return (
    <TeamScene
      className="connect-scene"
      agents={team}
      lead={lead?.id}
      asleep={!connected}
      day={day}
      expression={connected ? "happy" : undefined}
    >
      {/* No team to walk to (none yet, or still loading): the trail would end in the air. */}
      {team.length > 0 && <Trail from={5} state={state} />}
      <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state={connected ? "online" : "paused"} />
      <Trail from={0} state={state} />
      <span className="connect-scene__marks">
        {SCENE_PLANS.map((plan) => (
          <span key={plan} className="team-scene__mark">
            <ProviderLogo id={planMark(plan)} size="sm" off={Boolean(lit) && lit !== plan} />
          </span>
        ))}
      </span>
    </TeamScene>
  );
}
