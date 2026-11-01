import type { ArtifactDetail } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { LiveBlockCard } from "../blocks/LiveBlock";
import { PollCard } from "../blocks/PollCard";
import { useColors, useOrgId } from "../shared/hooks";
import { tapHaptic, useSurface } from "../shared/parts";
import { encodeFileList, extensionOf, type FileInfo, fileInfo, imageRows, singleImageHeight } from "./logic";
import { useArtifacts, useRemoteFile } from "./source";

/**
 * A message's files: pictures inline (one at its own shape, or two
 * side by side), tapping opens the viewer at that picture; other files as a card with the type's tile,
 * the real name and "Documento · 4 KB", tapping opens the document screen. `align="end"`: the viewer's own
 * message, its files sit on the right.
 */

export interface MessageFile {
  id: string;
  version?: number;
  title: string;
  deleted: boolean;
}

/** Widest a picture block gets in a message. */
const MAX_WIDTH = 300;
const GAP = 6;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"]);

export function MessageFiles({ files, align = "start" }: { files: MessageFile[]; align?: "start" | "end" }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const live = files.filter((f) => !f.deleted);
  const queries = useArtifacts(
    orgId,
    live.map((f) => (f.version !== undefined ? { id: f.id, version: f.version } : { id: f.id })),
  );
  const [width, setWidth] = useState(0);

  const images: { file: MessageFile; detail: ArtifactDetail | undefined }[] = [];
  // What lives in the conversation isn't a file: the thing itself (ADR 0109).
  const blocks: ArtifactDetail[] = [];
  const others: { file: MessageFile; detail: ArtifactDetail | undefined; failed: boolean }[] = [];
  live.forEach((file, i) => {
    const q = queries[i];
    const detail = q?.data;
    if (detail?.kind === "block" || detail?.kind === "poll") {
      blocks.push(detail);
      return;
    }
    // Until it loads, a name like "print.png" already says it's a picture (no jump into the grid).
    const isImage = detail ? fileInfo(detail).view === "image" : !q?.isError && IMAGE_EXT.has(extensionOf(file.title));
    if (isImage) images.push({ file, detail });
    else others.push({ file, detail, failed: Boolean(q?.isError) });
  });
  const removed = files.filter((f) => f.deleted);
  const blockWidth = Math.min(width || MAX_WIDTH, MAX_WIDTH);

  const openImage = (at: number) => {
    tapHaptic();
    router.push({
      pathname: "/images",
      params: {
        files: encodeFileList(
          images.map(({ file, detail }) => ({ id: file.id, version: detail?.shownVersion ?? file.version })),
        ),
        at: String(at),
      },
    });
  };

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[styles.wrap, align === "end" && styles.end]}>
      {images.length > 0 ? (
        <View style={[styles.images, { width: blockWidth }]}>
          {imageRows(images.length).map((row) => (
            <View key={row.join("-")} style={styles.row}>
              {row.map((i) => {
                const item = images[i];
                if (!item) return null;
                const cell = images.length === 1 ? blockWidth : (blockWidth - GAP) / 2;
                return (
                  <InlineImage
                    key={item.file.id}
                    file={item.file}
                    detail={item.detail}
                    width={cell}
                    single={images.length === 1}
                    label={
                      images.length > 1
                        ? t("mobile.files.imageOf", { index: i + 1, count: images.length })
                        : item.detail?.title || item.file.title
                    }
                    onPress={() => openImage(i)}
                  />
                );
              })}
            </View>
          ))}
        </View>
      ) : null}
      {blocks.map((b) =>
        b.kind === "poll" ? (
          <PollCard key={b.id} id={b.id} version={b.shownVersion} />
        ) : (
          <LiveBlockCard key={b.id} id={b.id} version={b.shownVersion} />
        ),
      )}
      {others.map(({ file, detail, failed }) => (
        <FileCard key={file.id} file={file} detail={detail} failed={failed} />
      ))}
      {removed.map((file) => (
        <RemovedCard key={file.id} />
      ))}
    </View>
  );
}

function InlineImage({
  file,
  detail,
  width,
  single,
  label,
  onPress,
}: {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
  width: number;
  single: boolean;
  label: string;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const version = detail?.shownVersion ?? file.version;
  const link = useRemoteFile(orgId, file.id, version);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const height = single ? singleImageHeight(width, size) : Math.round((width * 4) / 3);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={label || t("mobile.files.openImage")}
      accessibilityHint={t("mobile.files.openImage")}
      style={({ pressed }) => [
        styles.shot,
        { width, height, backgroundColor: c.sunken, borderColor: c.line2 },
        pressed && styles.pressed,
      ]}
    >
      {link.data && !failed ? (
        <Image
          source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${file.id}@${version ?? "latest"}` }}
          recyclingKey={`${file.id}@${version ?? "latest"}`}
          contentFit="cover"
          transition={160}
          style={StyleSheet.absoluteFill}
          onLoad={(e) => setSize({ width: e.source.width, height: e.source.height })}
          onError={() => setFailed(true)}
          accessible={false}
        />
      ) : null}
      {failed || link.isError ? (
        <View style={styles.center}>
          <Icon name="image" size={22} color={c.faint} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** The type and size line: "Documento · 4 KB". */
export function useFileLine() {
  const { t, i18n } = useTranslation();
  return (info: FileInfo, extra: string[] = []) =>
    [
      t(`mobile.files.type.${info.type}`),
      ...(info.size !== null ? [formatBytes(i18n.language || "pt-BR", info.size)] : []),
      ...extra.filter(Boolean),
    ].join(" · ");
}

/** The file type's tile: the extension in capitals on a folded page (or the file icon without one). */
export function FileTile({ ext, size = "md" }: { ext: string; size?: "md" | "lg" }) {
  const c = useColors();
  const lg = size === "lg";
  return (
    <View
      style={[styles.tile, lg && styles.tileLg, { backgroundColor: c.sunken }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.fold, lg && styles.foldLg, { backgroundColor: c.line2, borderColor: c.bg }]} />
      {ext ? (
        <Text variant="caption" tone="muted" style={[styles.ext, lg && styles.extLg]} numberOfLines={1}>
          {ext}
        </Text>
      ) : (
        <Icon name="file" size={lg ? 30 : 19} color={c.muted} />
      )}
    </View>
  );
}

function FileCard({
  file,
  detail,
  failed,
}: {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const surface = useSurface();
  const line = useFileLine();
  const info = detail ? fileInfo(detail) : null;
  const name = info?.name || file.title || t("mobile.chat.file");
  const open = () => {
    if (!detail) return;
    tapHaptic();
    router.push({
      pathname: "/file/[id]",
      params: { id: file.id, ...(detail.shownVersion < detail.version ? { v: String(detail.shownVersion) } : {}) },
    });
  };
  return (
    <Pressable
      onPress={open}
      disabled={!detail}
      accessibilityRole="button"
      accessibilityLabel={info ? `${name}, ${line(info)}` : name}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <FileTile ext={info?.ext ?? extensionOf(file.title).slice(0, 4).toUpperCase()} />
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold} numberOfLines={1}>
          {name}
        </Text>
        <Text variant="footnote" tone="faint" numberOfLines={1}>
          {info ? line(info) : failed ? t("mobile.files.loadFailed") : t("mobile.common.loading")}
        </Text>
      </View>
    </Pressable>
  );
}

function RemovedCard() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  return (
    <View style={[styles.card, surface]}>
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name="file" size={19} color={c.faint} />
      </View>
      <Text variant="body" tone="faint" style={styles.grow}>
        {t("mobile.chat.fileDeleted")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch" },
  end: { alignItems: "flex-end" },
  images: { marginTop: 8, gap: GAP },
  row: { flexDirection: "row", gap: GAP },
  shot: { borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.85 },
  card: {
    marginTop: 8,
    maxWidth: MAX_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
  },
  tile: { width: 40, height: 48, borderRadius: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tileLg: { width: 84, height: 100, borderRadius: 14 },
  fold: {
    position: "absolute",
    top: -1,
    right: -1,
    width: 13,
    height: 13,
    borderBottomLeftRadius: 3,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
  },
  foldLg: { width: 24, height: 24, borderBottomLeftRadius: 5 },
  ext: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  extLg: { fontSize: 17, letterSpacing: 0.6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
