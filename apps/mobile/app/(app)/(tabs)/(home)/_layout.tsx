import { useTranslation } from "react-i18next";
import { CoverTabStack } from "@/ui";

/** Início: a stack whose root has a clear native bar over the sky (the greeting is its large title). */
export default function HomeStack() {
  const { t } = useTranslation();
  return <CoverTabStack title={t("mobile.tabs.home")} />;
}
