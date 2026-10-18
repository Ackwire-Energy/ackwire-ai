import { LinearGradient } from "expo-linear-gradient";
import { Text as RNText } from "react-native";
import { useTheme } from "@/ui/theme";

export interface PersonAvatarProps {
  name: string;
  size: number;
}

/** A person: a neutral circle with the first letter (agents are the ones with color). */
export function PersonAvatar({ name, size }: PersonAvatarProps) {
  const { scheme } = useTheme();
  const dark = scheme === "dark";
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <LinearGradient
      colors={dark ? ["#3a3a37", "#2a2a28"] : ["#e9e9e5", "#d4d4cf"]}
      start={{ x: 0.3, y: 0 }}
      end={{ x: 0.7, y: 1 }}
      style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
    >
      <RNText
        allowFontScaling={false}
        style={{ fontWeight: "600", fontSize: size * 0.42, color: dark ? "#efefec" : "#2a2a28" }}
      >
        {initial}
      </RNText>
    </LinearGradient>
  );
}
