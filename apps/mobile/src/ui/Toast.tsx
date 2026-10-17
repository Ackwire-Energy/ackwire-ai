import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Text as RNText, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { type AgentLookInput, lookOf } from "@/agent/looks";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { useTheme } from "./theme";

export interface ToastInput {
  title: string;
  subtitle?: string;
  /** Default: a check (done). */
  icon?: IconName;
  /** Show this agent's face instead of the icon (looks from `rememberAgentLooks`). */
  agentId?: string;
  /** Or pass the look directly. */
  agent?: AgentLookInput;
}

type ToastFn = (input: ToastInput) => void;

const ToastContext = createContext<ToastFn | null>(null);
const SHOW_MS = 2600;

const noop: ToastFn = () => {};

/** `const toast = useToast(); toast({ title, subtitle?, icon?, agentId? })`: a glass note from the top. */
export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop;
}

/** Provides `useToast` and draws the toast above everything (place it once, near the root). */
export function ToastHost({ children }: { children?: ReactNode }) {
  const [current, setCurrent] = useState<(ToastInput & { key: number }) | null>(null);
  const counter = useRef(0);
  const toast = useCallback<ToastFn>((input) => {
    counter.current += 1;
    setCurrent({ ...input, key: counter.current });
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {current ? <ToastView key={current.key} item={current} onDone={() => setCurrent(null)} /> : null}
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDone }: { item: ToastInput; onDone: () => void }) {
  const { colors, fonts, shadows, motion, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const y = useSharedValue(reducedMotion ? 0 : -200);
  const opacity = useSharedValue(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    y.value = reducedMotion ? 0 : withSpring(0, motion.pop);
    opacity.value = withTiming(1, { duration: 250 });
    const hide = setTimeout(() => {
      opacity.value = withTiming(0, { duration: 250 });
      if (!reducedMotion) y.value = withTiming(-200, { duration: 300 });
    }, SHOW_MS);
    const done = setTimeout(() => doneRef.current(), SHOW_MS + 320);
    return () => {
      clearTimeout(hide);
      clearTimeout(done);
    };
  }, [y, opacity, reducedMotion, motion.pop]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: y.value }] }));
  const look = item.agent ?? (item.agentId ? lookOf(item.agentId) : undefined);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        { position: "absolute", top: insets.top + 6, left: 12, right: 12, borderRadius: 22, boxShadow: shadows.e3 },
        style,
      ]}
    >
      <Glass
        intensity={70}
        style={{
          borderRadius: 22,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 12,
          paddingHorizontal: 14,
        }}
      >
        {look ? (
          <AgentAvatar agent={look} size={34} />
        ) : (
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              backgroundColor: colors.raised,
              boxShadow: shadows.e1,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              name={item.icon ?? "check"}
              size={18}
              color={item.icon && item.icon !== "check" ? colors.ink2 : colors.ok}
            />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <RNText numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 14.5, color: colors.ink }}>
            {item.title}
          </RNText>
          {item.subtitle ? (
            <RNText numberOfLines={2} style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.muted }}>
              {item.subtitle}
            </RNText>
          ) : null}
        </View>
      </Glass>
    </Animated.View>
  );
}
