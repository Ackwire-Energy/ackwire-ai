import { useLocalSearchParams } from "expo-router";
import { InstallSkillScreen } from "@/features/settings/SkillsScreen";

/** "Instalar skill", pushed over Skills; `url`: an agent's card, the link read to pick from. */
export default function SettingsInstallSkillRoute() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  return <InstallSkillScreen initialUrl={url} />;
}
