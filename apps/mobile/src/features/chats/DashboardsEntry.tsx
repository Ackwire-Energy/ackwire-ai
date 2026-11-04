import { useDashboards } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Icon, LIST_AVATAR, ListRow } from "@/ui";
import { dashboardsEntryLine } from "../dashboards/logic";
import { useColors, useOrgId } from "../shared/hooks";
import { Tile } from "../shared/parts";

/**
 * Dashboards' way in on the phone (ADR 0135 §15): a row at the top of the home, in the list's own shape (a tile
 * like a channel's, the name, "My Home · 3 dashboards" muted, a chevron). It pushes the Dashboards list; the tab
 * bar stays as it is.
 */
export function DashboardsEntry() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const list = useDashboards(orgId);
  const title = t("dashboards.title");
  const line = dashboardsEntryLine(list.data?.dashboards.length, {
    home: t("dashboards.home"),
    count: (count) => t("mobile.dashboards.count", { count }),
  });
  return (
    <ListRow
      onPress={() => router.push("/dashboards")}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${line}`}
      leading={<Tile icon="chart" size={LIST_AVATAR} />}
      title={title}
      sub={line}
      subLines={1}
      trailing={<Icon name="right" size={15} color={c.faint} />}
    />
  );
}
