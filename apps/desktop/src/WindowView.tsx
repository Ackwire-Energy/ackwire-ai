import { Button, EmptyState } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "./app";
import { IPHONE_SETUP_PREF } from "./control/devices";
import { readPref, useOnShown, writePref } from "./hooks";
import type { WindowName } from "./host/types";
import { FirstRun } from "./windows/FirstRun";
import { IphoneSetup } from "./windows/IphoneSetup";
import { Notch } from "./windows/Notch";
import { Popover } from "./windows/Popover";
import { Prefs } from "./windows/Prefs";

/** One bundle, four windows: the Tauri window's label picks the screen. */
export function WindowView({ name }: { name: WindowName }) {
  useEffect(() => {
    document.body.dataset.window = name;
  }, [name]);
  if (name === "welcome") return <Welcome />;
  if (name === "prefs") return <Prefs />;
  if (name === "notch") return <Notch />;
  return <Popover />;
}

/** Preferences asked for the iPhone setup (`IPHONE_SETUP_PREF`, cleared once it shows): there, else the first run. */
function Welcome() {
  const host = useHost();
  const [iphone, setIphone] = useState(() => readPref(IPHONE_SETUP_PREF, false));
  useEffect(() => {
    if (iphone) writePref(IPHONE_SETUP_PREF, false);
  }, [iphone]);
  // Cleared here too: asked again while it already shows, the state doesn't change and the effect wouldn't run.
  useOnShown("welcome", () => {
    if (!readPref(IPHONE_SETUP_PREF, false)) return;
    writePref(IPHONE_SETUP_PREF, false);
    setIphone(true);
  });
  return iphone ? <IphoneSetup onClose={() => void host.hideWindow("welcome").catch(() => {})} /> : <FirstRun />;
}

/** A window that broke while drawing (main.tsx's boundary): what happened, and drawn again from the start. */
export function WindowError() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="alert"
      actions={
        <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
          {t("desktop.common.retry")}
        </Button>
      }
    >
      {t("desktop.common.error")}
    </EmptyState>
  );
}
