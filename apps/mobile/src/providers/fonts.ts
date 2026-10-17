import { useFonts } from "expo-font";
import { fonts } from "@/ui/theme";

/**
 * The app's fonts as static files (React Native has no variable axes): Onest 400–700, Funnel Display
 * Light for large titles and Doto at ROND 100 / weight 600 for every count. The family names are the
 * keys of `fonts` in the theme. All SIL Open Font License (assets/fonts/OFL-*.txt).
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts({
    [fonts.sans]: require("../../assets/fonts/Onest-Regular.ttf"),
    [fonts.medium]: require("../../assets/fonts/Onest-Medium.ttf"),
    [fonts.semibold]: require("../../assets/fonts/Onest-SemiBold.ttf"),
    [fonts.bold]: require("../../assets/fonts/Onest-Bold.ttf"),
    [fonts.display]: require("../../assets/fonts/FunnelDisplay-Light.ttf"),
    [fonts.dot]: require("../../assets/fonts/Doto-Rond100-SemiBold.ttf"),
  });
  // A font that fails to load falls back to the system font: never block the app on it.
  return loaded || Boolean(error);
}
