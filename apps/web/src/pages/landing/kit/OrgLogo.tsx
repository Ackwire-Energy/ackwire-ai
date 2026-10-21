import { cx } from "@agenteschat/ui";
import type { OrgKey } from "../cast";

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** The startup's mark: dithered pixels pressed toward the base (it compresses files). */
const PRESS: { x: number; y: number; id: string }[] = [];
for (let y = 0; y < 7; y++)
  for (let x = 0; x < 7; x++)
    if (((y + 1) / 7) * 1.15 * 16 > (BAYER[y % 4]?.[x % 4] ?? 0) + 0.5) PRESS.push({ x, y, id: `${x}-${y}` });

/** A sample company's logo, cut like an agent (same corner as the app's org mark). */
export function OrgLogo({ org, className }: { org: OrgKey; className?: string }) {
  return (
    <svg className={cx("lp-org-logo", className)} viewBox="0 0 28 28" aria-hidden="true">
      {org === "shop" ? (
        <>
          <rect width="28" height="28" fill="#7a4a2b" />
          <ellipse cx="14" cy="14" rx="6.4" ry="8.6" transform="rotate(28 14 14)" fill="#f3e2cf" />
          <path
            d="M11.2 7.6c3.6 3.4-1.4 9.4 2.4 13"
            fill="none"
            stroke="#7a4a2b"
            strokeWidth="1.6"
            strokeLinecap="round"
            transform="rotate(28 14 14) translate(1 0)"
          />
        </>
      ) : (
        <>
          <rect width="28" height="28" fill="#2a1f5c" />
          <g fill="#ff8a5c">
            {PRESS.map((c) => (
              <rect key={c.id} x={c.x * 4} y={c.y * 4} width="4" height="4" />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}
