import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { computerIcon, type MachineOutage, named, noticeText } from "./logic";
import { useMachineOutages } from "./queries";

/** Opens "Trocar o computador" for an offline computer (a native form sheet). */
export const openSwitchComputer = (machineId: string) => router.push(`/switch-computer/${machineId}`);

/**
 * Under the greeting on Conversas: one neutral card per computer
 * that went offline with agents waiting for it, the attention color only on its icon. "O MacBook Air
 * desconectou", "Ada e Theo esperam por ele · 3 tarefas", and "Trocar computador". The app has no computer
 * screen yet, so the design's "Ver computador" is left out. Shows only for who can manage the agents
 * (the endpoint refuses the others); nothing while none is offline.
 */
export function OutageNotices() {
  const { t } = useTranslation();
  const orgName = useOrg().org?.name ?? "";
  const { outages } = useMachineOutages();
  if (outages.length === 0) return null;
  return (
    <View style={styles.list}>
      {outages.map((o) => (
        <OutageNotice key={o.machineId} outage={named(t, o, orgName)} />
      ))}
    </View>
  );
}

function OutageNotice({ outage: o }: { outage: MachineOutage }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const text = noticeText(t, o);
  return (
    <View style={[styles.card, surface]}>
      <View
        style={styles.line}
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`${t("mobile.outage.a11y")}. ${text.title}. ${text.sub}`}
      >
        <Icon name={computerIcon(o.platform, o.managed)} size={22} color={c.amber} />
        <View style={styles.tx}>
          <Text variant="callout" tone="ink" style={styles.bold} numberOfLines={2}>
            {text.title}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={2}>
            {text.sub}
          </Text>
        </View>
      </View>
      <Button
        variant="primary"
        size="sm"
        wide
        label={t("mobile.outage.switch")}
        onPress={() => openSwitchComputer(o.machineId)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 10 },
  card: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  line: { flexDirection: "row", alignItems: "center", gap: 10 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
