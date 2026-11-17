import { type CSSProperties, useMemo } from "react";
import { cx } from "../cx";
import { useDawn } from "../hooks/useDawn";
import { HOSTING_CAST, type Hosting, teamSky } from "../sky/team";
import { Avatar } from "./Avatar";
import { ComputerPortrait } from "./Computer";
import { PixelSky } from "./PixelSky";

export type { Hosting };

/**
 * The choice of where a workspace lives, drawn: on the Cloud, day, the always-on server lit and the team up under it;
 * on one's own server, night, the laptop dark and the team asleep (they stop when it does). Turns from one to the other
 * with the dawn's motion (held still with reduced motion). `tall`: a window's side, the server over the team. `band`:
 * a strip over a sheet, side by side. Decorative: the words beside it say the same.
 */
export function HostingScene({ hosting, shape = "band" }: { hosting: Hosting; shape?: "band" | "tall" }) {
  const cloud = hosting === "cloud";
  const day = useDawn(cloud, { dusk: true });
  const options = useMemo(() => teamSky(day), [day]);
  return (
    <div className={cx("ac-hosting", `ac-hosting--${shape}`)} data-hosting={hosting} aria-hidden="true">
      <PixelSky options={options} />
      <div className="ac-hosting__row">
        <span className="ac-hosting__cast" data-awake={cloud ? "" : undefined}>
          {HOSTING_CAST.map((a, i) => (
            <span key={a.name} className="ac-hosting__agent" style={{ "--i": i } as CSSProperties}>
              <Avatar
                kind="agent"
                name={a.name}
                appearance={a.look}
                size="lg"
                framed={false}
                state={cloud ? "idle" : "sleeping"}
                expression={cloud ? "happy" : undefined}
              />
            </span>
          ))}
        </span>
        <span className="ac-hosting__trail" data-lit={cloud ? "" : undefined}>
          {[0, 1, 2, 3, 4].map((n) => (
            <i key={n} />
          ))}
        </span>
        <ComputerPortrait kind={cloud ? "linux" : "mac"} state={cloud ? "online" : "offline"} size={96} />
      </div>
    </div>
  );
}

/** Where the desktop app's first screen says a workspace can live: the Cloud, this computer, or one always on. */
export type Place = "cloud" | "here" | "box";

/** A pixel cloud under the Cloud's agent: its body, and its underside every other pixel (`=`). */
const CLOUD = [
  "........########..........",
  ".....##############.......",
  "...##################.....",
  "..#####################...",
  ".#########################",
  "##########################",
  "##########################",
  "=.=.=.=.=.=.=.=.=.=.=.=.=.",
  ".=.=.=.=.=.=.=.=.=.=.=.=..",
];

function PixelCloud() {
  return (
    <svg
      className="ac-place__cloud"
      viewBox={`0 0 ${CLOUD[0]?.length ?? 0} ${CLOUD.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {CLOUD.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "." ? null : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing, cells by their place
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} className={c === "#" ? "body" : "under"} />
          ),
        ),
      )}
    </svg>
  );
}

/**
 * The desktop app's "Onde seu workspace vai ficar?" drawn (ADR 0066 §1, amended 2026-11-14): the team under the place
 * picked, day in every one: the Cloud as the Ackwire AI agent on a cloud, this computer as its portrait (`computer`),
 * one always on as the server tower. Decorative: the words beside it say the same.
 */
export function PlaceScene({
  place,
  computer = "mac",
  shape = "tall",
}: {
  place: Place;
  computer?: "mac" | "windows" | "linux";
  shape?: "band" | "tall";
}) {
  const options = useMemo(() => teamSky(1), []);
  return (
    <div className={cx("ac-hosting", `ac-hosting--${shape}`, "ac-place")} data-place={place} aria-hidden="true">
      <PixelSky options={options} />
      <div className="ac-hosting__row">
        <span className="ac-hosting__cast" data-awake="">
          {HOSTING_CAST.map((a, i) => (
            <span key={a.name} className="ac-hosting__agent" style={{ "--i": i } as CSSProperties}>
              <Avatar
                kind="agent"
                name={a.name}
                appearance={a.look}
                size="lg"
                framed={false}
                state="idle"
                expression={i === 1 ? "happy" : undefined}
              />
            </span>
          ))}
        </span>
        <span className="ac-hosting__trail ac-place__trail" data-lit="">
          {[0, 1, 2].map((n) => (
            <i key={n} />
          ))}
        </span>
        <span className="ac-place__subject" key={place}>
          {place === "cloud" ? (
            <span className="ac-place__brand">
              <Avatar
                kind="agent"
                name="Ackwire AI"
                appearance={{ color: "sky", eyes: "round" }}
                size="xl"
                framed={false}
                state="idle"
                expression="happy"
              />
              <PixelCloud />
            </span>
          ) : (
            <ComputerPortrait kind={place === "here" ? computer : "linux"} state="online" size={96} />
          )}
        </span>
      </div>
    </div>
  );
}
