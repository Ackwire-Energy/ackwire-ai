import { type ArtifactDetail, useApi, useArtifact } from "@agenteschat/client";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { Button, IconButton, Text, ToastHost } from "@/ui";
import { MessageText } from "../chat/MessageText";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { goBack, MONO } from "../shared/parts";
import { useFileActions } from "./actions";
import { type FileInfo, fileInfo } from "./logic";
import { FileTile, useFileLine } from "./MessageFiles";
import { fileText, useRemoteFile } from "./source";

/**
 * A file opened from a message: Markdown and text drawn by the
 * app, PDF in a web view (iOS draws PDFs natively there), anything else as its card. Top: close, the
 * name and "Documento · 4 KB · Theo". Bottom: Ver no Drive and Compartilhar.
 */
export function DocumentViewer({ id, version }: { id: string; version?: number }) {
  return (
    <ToastHost>
      <Viewer id={id} {...(version !== undefined ? { version } : {})} />
    </ToastHost>
  );
}

function Viewer({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const line = useFileLine();
  const query = useArtifact(orgId, id, version);
  const detail = query.data;
  const actions = useFileActions(detail);
  const info = detail ? fileInfo(detail) : null;
  const close = () => goBack();
  // A PDF is drawn in the web view on iOS only (Android's WebView has no PDF viewer).
  const pdf = info?.view === "pdf" && Platform.OS === "ios";
  const shows = info ? info.view === "markdown" || info.view === "text" || pdf : false;

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="x" plate label={t("mobile.common.close")} onPress={close} />
        <View style={styles.title}>
          <Text variant="subhead" style={styles.bold} numberOfLines={1}>
            {info?.name ?? ""}
          </Text>
          <Text variant="footnote" tone="faint" numberOfLines={1}>
            {info && detail ? line(info, [dir.nameOf(detail.createdBy)]) : ""}
          </Text>
        </View>
        <IconButton
          icon="more"
          plate
          label={t("mobile.files.more")}
          onPress={() => actions.more(false)}
          disabled={!detail}
        />
      </View>

      <View style={styles.body}>
        {query.isError ? (
          <Center>
            <Text variant="body" tone="muted">
              {t("mobile.files.loadFailed")}
            </Text>
          </Center>
        ) : !detail || !info ? (
          <Center>
            <ActivityIndicator color={c.faint} />
          </Center>
        ) : info.view === "markdown" || info.view === "text" ? (
          <TextPage detail={detail} markdown={info.view === "markdown"} />
        ) : pdf ? (
          <PdfPage detail={detail} />
        ) : (
          <BigCard info={info} />
        )}
      </View>

      <View style={[styles.bar, { paddingBottom: insets.bottom + 12, borderTopColor: c.line2, backgroundColor: c.bg }]}>
        {shows ? (
          <View style={styles.half}>
            <Button variant="secondary" wide icon="drive" label={t("mobile.files.drive")} onPress={actions.drive} />
          </View>
        ) : null}
        <View style={styles.half}>
          <Button
            variant="primary"
            wide
            icon="share"
            label={t("mobile.files.share")}
            disabled={!detail || actions.busy !== null}
            onPress={actions.share}
          />
        </View>
      </View>
    </View>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

/** Markdown with the messages' renderer, plain text in mono, on a raised page. */
function TextPage({ detail, markdown }: { detail: ArtifactDetail; markdown: boolean }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const text = useQuery({
    queryKey: ["org", orgId, "artifacts", "text", detail.id, detail.shownVersion] as const,
    queryFn: () => fileText(api, orgId, detail),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <View style={[styles.page, { backgroundColor: c.raised }]}>
      {text.data !== undefined ? (
        <ScrollView contentContainerStyle={styles.pageInner}>
          {markdown ? (
            <MessageText body={text.data} />
          ) : (
            <RNText selectable style={[styles.mono, { color: c.ink2 }]}>
              {text.data}
            </RNText>
          )}
        </ScrollView>
      ) : text.isError ? (
        <Center>
          <Text variant="body" tone="muted">
            {t("mobile.files.loadFailed")}
          </Text>
        </Center>
      ) : (
        <Center>
          <ActivityIndicator color={c.faint} />
        </Center>
      )}
    </View>
  );
}

/** A PDF from its short-lived link (with the session when the link is ours). */
function PdfPage({ detail }: { detail: ArtifactDetail }) {
  const orgId = useOrgId();
  const c = useColors();
  const link = useRemoteFile(orgId, detail.id, detail.shownVersion);
  return (
    <View style={[styles.page, styles.clip, { backgroundColor: c.raised }]}>
      {link.data ? (
        <WebView
          source={{ uri: link.data.uri, headers: link.data.headers }}
          originWhitelist={["https://*", "http://*"]}
          javaScriptEnabled={false}
          startInLoadingState
          renderLoading={() => (
            <Center>
              <ActivityIndicator color={c.faint} />
            </Center>
          )}
          style={styles.web}
        />
      ) : (
        <Center>
          <ActivityIndicator color={c.faint} />
        </Center>
      )}
    </View>
  );
}

/** A type the app doesn't draw: its card, big, and Compartilhar opens it elsewhere. */
function BigCard({ info }: { info: FileInfo }) {
  const { t } = useTranslation();
  const line = useFileLine();
  return (
    <Center>
      <FileTile ext={info.ext} size="lg" />
      <Text variant="title" style={styles.bigName} numberOfLines={3}>
        {info.name}
      </Text>
      <Text variant="footnote" tone="faint">
        {line(info)}
      </Text>
      <Text variant="small" tone="muted" style={styles.note}>
        {t("mobile.files.noPreview")}
      </Text>
    </Center>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingBottom: 10 },
  title: { flex: 1, minWidth: 0, alignItems: "center" },
  bold: { fontWeight: "600" },
  body: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 6 },
  page: { flex: 1, marginTop: 4, marginHorizontal: 16, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  clip: { overflow: "hidden" },
  pageInner: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 28 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  web: { flex: 1, backgroundColor: "transparent" },
  bigName: { marginTop: 14, textAlign: "center" },
  note: { marginTop: 10, textAlign: "center" },
  bar: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  half: { flex: 1 },
});
