import { View } from "react-native";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { useTheme } from "./theme";

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  /** For screen readers (always required: the button has no visible text). */
  label: string;
  /** On a glass plate (over the sky or content). */
  plate?: boolean;
  disabled?: boolean;
}

/** A 40-point icon button: transparent, or on a glass plate. */
export function IconButton({ icon, onPress, label, plate = false, disabled = false }: IconButtonProps) {
  const { colors, shadows } = useTheme();
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[{ width: 40, height: 40, borderRadius: 13 }, plate ? { boxShadow: shadows.e1 } : null]}
    >
      {plate ? (
        <Glass intensity={40} style={{ flexGrow: 1, borderRadius: 13, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={20} color={colors.ink2} />
        </Glass>
      ) : (
        <View style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={20} color={colors.ink2} />
        </View>
      )}
    </PressScale>
  );
}
