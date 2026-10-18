import { useEffect } from "react";
import type { WindowName } from "./host/types";
import { Popover } from "./windows/Popover";
import { Prefs } from "./windows/Prefs";
import { Welcome } from "./windows/Welcome";

/** One bundle, three windows: the Tauri window's label picks the screen. */
export function WindowView({ name }: { name: WindowName }) {
  useEffect(() => {
    document.body.dataset.window = name;
  }, [name]);
  if (name === "welcome") return <Welcome />;
  if (name === "prefs") return <Prefs />;
  return <Popover />;
}
