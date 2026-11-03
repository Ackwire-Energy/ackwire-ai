import { useTranslation } from "react-i18next";
import { TabStack } from "@/ui";

/** Dashboards (ADR 0134): a stack whose root has the native large title. */
export default function DashboardsStack() {
  const { t } = useTranslation();
  return <TabStack title={t("dashboards.title")} />;
}
