import { useTranslation } from "react-i18next";
import { TabStack } from "@/ui";

/** Conversas: a stack whose root has the native large title. */
export default function ChatsStack() {
  const { t } = useTranslation();
  return <TabStack title={t("mobile.chats.title")} />;
}
