import type { TFunction } from "i18next";
import type { WorkItem } from "./logic";

/** The line a working item shows: the mission, what the run works on, else where it is. */
export function workTitle(t: TFunction, w: WorkItem): string {
  if (w.kind === "mission") return t("mobile.home.missionTitle", { title: w.what ?? "" });
  if (w.what) return w.what;
  return workWhere(t, w);
}

/** "#produto", or "Conversa direta". */
export function workWhere(t: TFunction, w: WorkItem): string {
  return w.where.kind === "channel" && w.where.name ? `#${w.where.name}` : t("mobile.home.directChat");
}
