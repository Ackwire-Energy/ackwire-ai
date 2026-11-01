import { Button, EmptyState } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { WindowName } from "./host/types";
import { FirstRun } from "./windows/FirstRun";
import { Notch } from "./windows/Notch";
import { Popover } from "./windows/Popover";
import { Prefs } from "./windows/Prefs";

/** One bundle, four windows: the Tauri window's label picks the screen. */
export function WindowView({ name }: { name: WindowName }) {
  useEffect(() => {
    document.body.dataset.window = name;
  }, [name]);
  if (name === "welcome") return <FirstRun />;
  if (name === "prefs") return <Prefs />;
  if (name === "notch") return <Notch />;
  return <Popover />;
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
