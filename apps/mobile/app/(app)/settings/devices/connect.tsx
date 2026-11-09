import { useLocalSearchParams } from "expo-router";
import { ConnectScreen } from "@/features/devices/ConnectScreen";

/** "Conectar um dispositivo": what to connect, then a server's or a computer's one-line link (`?kind=`). */
export default function SettingsConnectDeviceRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return <ConnectScreen kind={kind === "server" || kind === "computer" ? kind : null} />;
}
