import {
  type AgentAppearance,
  Avatar,
  horizonCrest,
  horizonTones,
  mix,
  PixelSky,
  playAgentReaction,
} from "@agenteschat/ui";
import { type CSSProperties, useEffect, useRef } from "react";

/**
 * The scene of an answer to "what will you use agentes.chat for?" (ADR 0159), the onboarding's brand moment, drawn
 * with the app's own faces and the org chart's lines, over the cards' horizon (`CardHorizon`). For me: the person
 * signing up in the middle (their photo, or their initials as everywhere), their agents around them, each joined to
 * them. For a team: an org chart, them on top, people and agents under them. The other answer rests (its agents doze,
 * their zz); choosing one draws its lines and wakes its agents with a hop, and from then on they look at the pointer.
 * Decorative: the answer says it in words.
 *
 * Laid out on a fixed stage (`W`×`H`, scaled down on a phone), so the lines and the faces share one set of numbers.
 */
export type PurposeKind = "personal" | "team";

const W = 240;
const H = 172;

type Face = { x: number; y: number; size: number } & ({ look: AgentAppearance } | { photo: string } | { you: true });

/** Who is signing up: their account's name and photo (Google's, or one they set), if any. */
export type PurposeYou = { name: string; image: string | null };

/** For me: you in the middle and six agents around you. */
const ME: Face[] = [
  { x: 120, y: 86, size: 60, you: true },
  { x: 30, y: 86, size: 36, look: { color: "green", eyes: "round", accessory: "cap" } },
  { x: 70, y: 30, size: 36, look: { color: "amber", eyes: "wide", accessory: "headphones" } },
  { x: 170, y: 30, size: 36, look: { color: "rose", eyes: "happy", accessory: "flower" } },
  { x: 210, y: 86, size: 36, look: { color: "teal", eyes: "happy", accessory: "bow" } },
  { x: 170, y: 142, size: 36, look: { color: "sky", eyes: "dots", accessory: "beanie" } },
  { x: 70, y: 142, size: 36, look: { color: "violet", eyes: "round", accessory: "antenna" } },
];

/** For a team: you on top; an agent, a person and an agent under you; two agents under that person. */
const TEAM: Face[] = [
  { x: 120, y: 28, size: 40, you: true },
  { x: 46, y: 89, size: 34, look: { color: "amber", eyes: "round", accessory: "headset" } },
  // A pixel portrait of someone on the team (anyone).
  { x: 120, y: 89, size: 34, photo: "/onboarding/person-31.jpg" },
  { x: 194, y: 89, size: 34, look: { color: "green", eyes: "wide", accessory: "antenna" } },
  { x: 88, y: 145, size: 30, look: { color: "rose", eyes: "happy", accessory: "scarf" } },
  { x: 152, y: 145, size: 30, look: { color: "teal", eyes: "dots", accessory: "cap" } },
];

/** An org chart's line from a parent's foot down to a bar at `bar`, across, and down to a child's head; round turns. */
function elbow(from: Face, to: Face, bar: number): string {
  const top = from.y + from.size / 2;
  const end = to.y - to.size / 2;
  if (to.x === from.x) return `M${from.x} ${top}V${end}`;
  const r = 6;
  const dir = to.x > from.x ? 1 : -1;
  return `M${from.x} ${top}V${bar - r}Q${from.x} ${bar} ${from.x + dir * r} ${bar}H${to.x - dir * r}Q${to.x} ${bar} ${to.x} ${bar + r}V${end}`;
}

const FACES: Record<PurposeKind, Face[]> = { personal: ME, team: TEAM };

/** The lines: for me, from the person to each agent; for a team, from each lead to who is under them. */
const LINES: Record<PurposeKind, string[]> = {
  personal: ME.slice(1).map((a) => `M${ME[0]?.x} ${ME[0]?.y}L${a.x} ${a.y}`),
  team: (() => {
    const [lead, a, person, b, c, d] = TEAM as [Face, Face, Face, Face, Face, Face];
    return [
      elbow(lead, person, 60),
      elbow(lead, a, 60),
      elbow(lead, b, 60),
      elbow(person, c, 118),
      elbow(person, d, 118),
    ];
  })(),
};

export function PurposeScene({ kind, chosen, you }: { kind: PurposeKind; chosen: boolean; you: PurposeYou }) {
  const faces = FACES[kind];
  // Choosing it wakes its agents with a hop (the engine's "up" reaction), once per choice, as its lines arrive.
  const was = useRef(chosen);
  useEffect(() => {
    if (chosen && !was.current)
      faces.forEach((f, i) => {
        if ("look" in f) playAgentReaction(`purpose-${kind}-${i}`, "up");
      });
    was.current = chosen;
  }, [chosen, kind, faces]);
  const color = kind === "personal" ? "violet" : "sky";
  return (
    <span className="onb-scene" data-kind={kind} data-chosen={chosen || undefined} data-gaze="" aria-hidden="true">
      <span className="onb-scene__sky">
        <PixelSky
          // A new sky when the choice changes: a sky reads its surface once, and the chosen card's is another.
          key={chosen ? "chosen" : "resting"}
          options={{
            pixel: 4,
            surface: "--scene-surface",
            // The card's own ground paints nothing; `mix` spells it "#rrggbb" (a token may be "#fff").
            seeThrough: true,
            palette: (surface) =>
              horizonTones(color, mix(surface, surface, 0), document.documentElement.dataset.theme === "dark"),
            light: 0,
            // The cards' horizon (`CardHorizon`) at the drawing's foot, where its last faces stand: a crest, then down
            // into the color's light tones; resting, half as far.
            base: (u, v) => {
              const crest = horizonCrest(u * 0.85);
              if (v < crest) return 0;
              const f = Math.min(1, 0.2 + ((v - crest) / (1 - crest)) * 0.85);
              return chosen ? f : f * 0.5;
            },
          }}
        />
      </span>
      <span className="onb-scene__room">
        <span className="onb-scene__stage">
          <svg className="onb-scene__lines" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
            {LINES[kind].map((d, i) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
                key={i}
                d={d}
                pathLength={1}
                className="onb-scene__line"
                style={{ "--i": i } as CSSProperties}
              />
            ))}
          </svg>
          {faces.map((f, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed cast
              key={i}
              className="onb-scene__face"
              style={{ left: f.x - f.size / 2, top: f.y - f.size / 2, width: f.size, height: f.size }}
            >
              {"look" in f ? (
                <Avatar
                  kind="agent"
                  name={`purpose-${kind}-${i}`}
                  appearance={f.look}
                  size="md"
                  state={chosen ? "idle" : "sleeping"}
                  reactionKey={`purpose-${kind}-${i}`}
                />
              ) : "you" in f ? (
                <Avatar kind="person" name={you.name} imageUrl={you.image ?? undefined} size="lg" />
              ) : (
                <Avatar kind="person" name="" imageUrl={f.photo} size="lg" />
              )}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
