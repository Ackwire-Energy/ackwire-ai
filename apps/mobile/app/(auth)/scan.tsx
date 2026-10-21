import { parseConnectLink } from "@agenteschat/client/lib/server";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Linking, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ALLOW_HTTP } from "@/lib/server";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { Glass } from "@/ui/Glass";
import { haptics } from "@/ui/haptics";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";

/**
 * Escanear QR code: reads QR codes only. A connect link goes on to its confirmation (`/connect`); any other
 * code says it isn't one of ours.
 */
export default function Scan() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission, readPermission] = useCameraPermissions();
  const [notOurs, setNotOurs] = useState(false);
  const done = useRef(false);

  // Back from Ajustes: Android keeps the app running when the camera is allowed there, so read it again.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void readPermission();
    });
    return () => sub.remove();
  }, [readPermission]);

  if (!permission) return null;
  if (!permission.granted)
    return (
      <AuthScaffold
        title={t("mobile.auth.scan.cameraTitle")}
        subtitle={t("mobile.auth.scan.cameraText")}
        onBack={() => router.back()}
      >
        {permission.canAskAgain ? (
          <Button
            variant="primary"
            wide
            icon="camera"
            label={t("mobile.auth.scan.allow")}
            onPress={() => void requestPermission()}
          />
        ) : (
          <Button
            variant="primary"
            wide
            label={t("mobile.auth.scan.settings")}
            onPress={() => void Linking.openSettings()}
          />
        )}
      </AuthScaffold>
    );

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const link = parseConnectLink(data, { allowHttp: ALLOW_HTTP });
          if (!link) return setNotOurs(true);
          done.current = true;
          haptics.success();
          router.replace({ pathname: "/connect", params: link });
        }}
      />
      <View style={{ position: "absolute", top: insets.top + 6, left: 10 }}>
        <IconButton icon="back" label={t("mobile.common.back")} onPress={() => router.back()} plate />
      </View>
      <Glass
        style={{ position: "absolute", left: 16, right: 16, bottom: insets.bottom + 16, borderRadius: 18, padding: 16 }}
      >
        <Text variant="callout" tone={notOurs ? "danger" : undefined} style={{ textAlign: "center" }}>
          {notOurs ? t("mobile.auth.scan.notOurs") : t("mobile.auth.scan.hint")}
        </Text>
      </Glass>
    </View>
  );
}
