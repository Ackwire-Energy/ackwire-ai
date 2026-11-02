import { useArtifact } from "@agenteschat/client";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName, PressScale, Text, ToastHost } from "@/ui";
import { useDirectory, useOrgId } from "../shared/hooks";
import { savedAt, useFileActions, useSavedWhen } from "./actions";
import { decodeFileList, fileInfo } from "./logic";
import { useRemoteFile } from "./source";
import { tellViewerPlace } from "./viewer-place";
import { ZoomableImage } from "./ZoomableImage";

/**
 * A message's pictures, full screen: black, the name and who sent
 * it on top, pinch and double tap to zoom, swipe between the pictures (dots), drag down to close, and
 * Compartilhar, Salvar em Fotos, Ver no Drive at the bottom. A tap hides and shows the bars.
 */
export function ImageViewer({
  files: rawFiles,
  at,
  from,
}: {
  files: string | string[] | undefined;
  at: string | undefined;
  /** The stack it opened from, told where the person stops. */
  from?: string | undefined;
}) {
  return (
    // Toasts show inside the modal (the app's host sits under it).
    <ToastHost>
      <Viewer rawFiles={rawFiles} at={at} from={from} />
    </ToastHost>
  );
}

const WHITE = "#fff";
const DIM = "rgba(255,255,255,0.6)";
const PLATE = "rgba(255,255,255,0.14)";

function Viewer({
  rawFiles,
  at,
  from,
}: {
  rawFiles: string | string[] | undefined;
  at: string | undefined;
  from: string | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const savedWhen = useSavedWhen();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const files = decodeFileList(rawFiles);
  const first = Math.min(Math.max(Number(at) || 0, 0), Math.max(files.length - 1, 0));
  const [index, setIndex] = useState(first);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const drag = useSharedValue(0);
  const current = files[index];
  const detail = useArtifact(orgId, current?.id ?? null, current?.version).data;
  const actions = useFileActions(detail);
  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
  useEffect(() => {
    if (from) tellViewerPlace(from, index);
  }, [from, index]);

  const onPage = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index && i >= 0 && i < files.length) setIndex(i);
  };

  const backdrop = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(Math.abs(drag.value) / (height * 0.6), 0.85),
  }));

  const info = detail ? fileInfo(detail) : null;
  const author = detail ? dir.nameOf(detail.createdBy) : "";
  const sub = detail ? [author, savedWhen(savedAt(detail))].filter(Boolean).join(" · ") : "";

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden={!chrome} animated />
      <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
      <ScrollView
        horizontal
        pagingEnabled
        scrollEnabled={!zoomed && files.length > 1}
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: first * width, y: 0 }}
        onMomentumScrollEnd={onPage}
        style={StyleSheet.absoluteFill}
      >
        {files.map((f, i) => (
          <Page
            key={`${f.id}@${f.version ?? ""}`}
            id={f.id}
            {...(f.version !== undefined ? { version: f.version } : {})}
            width={width}
            height={height}
            drag={drag}
            near={Math.abs(i - index) <= 1}
            onZoomChange={setZoomed}
            onTap={() => setChrome((v) => !v)}
            onDismiss={close}
          />
        ))}
      </ScrollView>

      <Chrome visible={chrome} drag={drag} style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Round icon="x" label={t("mobile.common.close")} onPress={close} />
        <View style={styles.title}>
          <Text variant="subhead" style={[styles.bold, { color: WHITE }]} numberOfLines={1}>
            {info?.name ?? ""}
          </Text>
          <Text variant="footnote" style={{ color: DIM }} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        <Round icon="more" label={t("mobile.files.more")} onPress={() => actions.more(true)} disabled={!detail} />
      </Chrome>

      <Chrome visible={chrome} drag={drag} style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
        {files.length > 1 ? (
          <View
            style={styles.dots}
            accessible
            accessibilityLabel={t("mobile.files.imageOf", { index: index + 1, count: files.length })}
          >
            {files.map((f, i) => (
              <View
                key={`${f.id}@${f.version ?? ""}`}
                style={[styles.dot, { backgroundColor: i === index ? WHITE : "rgba(255,255,255,0.35)" }]}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.actions}>
          <Action
            icon="share"
            label={t("mobile.files.share")}
            busy={actions.busy === "share"}
            disabled={!detail}
            onPress={actions.share}
          />
          <Action
            icon="photos"
            label={t("mobile.files.savePhotos")}
            busy={actions.busy === "photos"}
            disabled={!detail}
            onPress={actions.savePhotos}
          />
          <Action icon="drive" label={t("mobile.files.drive")} disabled={!detail} onPress={actions.drive} />
        </View>
      </Chrome>
    </View>
  );
}

function Page({
  id,
  version,
  width,
  height,
  drag,
  near,
  onZoomChange,
  onTap,
  onDismiss,
}: {
  id: string;
  version?: number;
  width: number;
  height: number;
  drag: SharedValue<number>;
  /** Only the pictures next to the one on screen load. */
  near: boolean;
  onZoomChange: (z: boolean) => void;
  onTap: () => void;
  onDismiss: () => void;
}) {
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, near ? id : null, version);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {link.data ? (
        <ZoomableImage
          uri={link.data.uri}
          headers={link.data.headers}
          cacheKey={`${id}@${version ?? "latest"}`}
          width={width}
          height={height}
          drag={drag}
          onZoomChange={onZoomChange}
          onTap={onTap}
          onDismiss={onDismiss}
        />
      ) : link.isError ? (
        <Icon name="image" size={30} color={DIM} />
      ) : (
        <ActivityIndicator color={WHITE} />
      )}
    </View>
  );
}

/** The bars: fade with a tap, and while the picture is dragged away. */
function Chrome({
  visible,
  drag,
  style,
  children,
}: {
  visible: boolean;
  drag: SharedValue<number>;
  style: object[];
  children: ReactNode;
}) {
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.value = withTiming(visible ? 1 : 0, { duration: 180 });
  }, [visible, shown]);
  const anim = useAnimatedStyle(() => ({
    opacity: shown.value * (1 - Math.min(Math.abs(drag.value) / 80, 1)),
  }));
  return (
    <Animated.View pointerEvents={visible ? "box-none" : "none"} style={[...style, anim]}>
      {children}
    </Animated.View>
  );
}

function Round({
  icon,
  label,
  onPress,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[styles.round, { backgroundColor: PLATE }]}
      contentStyle={styles.center}
    >
      <Icon name={icon} size={20} color={WHITE} />
    </PressScale>
  );
}

function Action({
  icon,
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressScale
      to={0.92}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      style={styles.action}
      contentStyle={styles.actionIn}
    >
      <View style={[styles.circle, { backgroundColor: PLATE }]}>
        {busy ? <ActivityIndicator color={WHITE} /> : <Icon name={icon} size={21} color={WHITE} />}
      </View>
      <Text variant="caption" style={[styles.bold, { color: WHITE }]} numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  black: { backgroundColor: "#000" },
  top: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  title: { flex: 1, minWidth: 0, alignItems: "center" },
  bold: { fontWeight: "600" },
  round: { width: 44, height: 44, borderRadius: 22 },
  center: { alignItems: "center", justifyContent: "center" },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 6 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, paddingVertical: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  actions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: 20, paddingTop: 10 },
  action: { minWidth: 88 },
  actionIn: { alignItems: "center", gap: 5 },
  circle: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
});
