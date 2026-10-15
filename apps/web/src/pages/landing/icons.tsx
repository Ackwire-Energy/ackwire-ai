/** Icons the landing page needs that the design system's set doesn't have (same 20px grid, 1.6 stroke). */
const PATHS = {
  sun: "M10 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zM10 2.5v1.6M10 15.9v1.6M2.5 10h1.6M15.9 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M4.7 15.3l1.1-1.1M14.2 5.8l1.1-1.1",
  moon: "M15.5 12.4A6.5 6.5 0 0 1 7.6 4.5a6.5 6.5 0 1 0 7.9 7.9z",
  coin: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12.2 7.6c-.4-.7-1.2-1.1-2.2-1.1-1.3 0-2.2.7-2.2 1.7 0 2.3 4.6 1.2 4.6 3.6 0 1-1 1.8-2.4 1.8-1.1 0-2-.5-2.4-1.3M10 5v1.5M10 13.6V15",
  shuffle:
    "M3 6h2.6c2 0 3 1 4.4 4s2.4 4 4.4 4H17M3 14h2.6c1 0 1.7-.3 2.3-.8M12 6.8c.6-.5 1.3-.8 2.3-.8H17M15 4l2 2-2 2M15 12l2 2-2 2",
} as const;

export function LpIcon({ name, size = 20 }: { name: keyof typeof PATHS; size?: 14 | 16 | 18 | 20 }) {
  return (
    <svg viewBox="0 0 20 20" className="ac-icon" style={{ width: size, height: size }} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
