/**
 * Development only (`bun run dev` in a browser): a bar to switch windows and nudge the fake runners
 * (go offline, raise a folder request), and a frame the size of each real window. Not product UI.
 */
import { useEffect, useReducer } from "react";
import type { FakeHost } from "../host/fake";
import type { WindowName } from "../host/types";
import { WindowView } from "../WindowView";

const SIZES: Record<WindowName, { width: number; height: number | "auto" }> = {
  popover: { width: 380, height: "auto" },
  welcome: { width: 680, height: 560 },
  prefs: { width: 860, height: 600 },
};

export function DevFrame({ host }: { host: FakeHost }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.onDev(rerender), [host]);
  const name = host.window;
  const size = SIZES[name];
  const first = [...host.runners.values()][0];
  const toggleTheme = () => {
    const r = document.documentElement;
    r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
  };
  return (
    <div className="dk-dev">
      <div className="dk-dev__bar">
        {(["popover", "welcome", "prefs"] as const).map((w) => (
          <button key={w} type="button" aria-pressed={w === name} onClick={() => void host.showWindow(w)}>
            {w}
          </button>
        ))}
        <span className="dk-dev__sep" />
        <button type="button" onClick={() => first?.setOnline(false)}>
          offline
        </button>
        <button type="button" onClick={() => first?.setOnline(true)}>
          online
        </button>
        <button type="button" onClick={() => first?.raiseRequest()}>
          folder request
        </button>
        <button type="button" onClick={toggleTheme}>
          theme
        </button>
        <span className="dk-dev__tray">tray: {host.tray}</span>
      </div>
      <div
        className="dk-dev__window"
        data-window={name}
        style={{ width: size.width, height: size.height === "auto" ? undefined : size.height }}
      >
        <WindowView key={name} name={name} />
      </div>
    </div>
  );
}
