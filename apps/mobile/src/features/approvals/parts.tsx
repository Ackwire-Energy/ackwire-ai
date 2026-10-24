import { type Approval, useCatalog } from "@agenteschat/client";
import { approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Chip, Fuse, Icon, Text } from "@/ui";
import { useColors, useNow } from "../shared/hooks";
import { fuseRemaining, minutesLeft } from "../shared/logic";
import { approvalSaid, approvalTable, approvalTraits } from "./logic";

/**
 * The exact request, in reading order: what it affects as
 * chips, the details table (Por onde, then the values it runs with), what the agent said before, and the
 * amber fuse until it expires. The chat's card and the sheet draw the same pieces.
 */

const TRAIT_ICON = { production: "globe", irreversible: "x", reversible: "undo", external: "send" } as const;

/** "Para todos, em produção", "Dá para desfazer": only what the request itself says. */
export function ApprovalTraits({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const traits = approvalTraits(a);
  if (traits.length === 0) return null;
  return (
    <View style={styles.chips}>
      {traits.map((tr) => (
        <Chip key={tr} icon={TRAIT_ICON[tr]} label={t(`mobile.approval.trait.${tr}`)} />
      ))}
    </View>
  );
}

/** Por onde, then the exact values (at most `max` rows), on a sunken plate. */
export function ApprovalDetails({ approval: a, max = 3 }: { approval: Approval; max?: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const catalog = useCatalog();
  // The connector's name from the catalog ("GitHub"); the raw id until it loads.
  const rows = approvalTable(a, max, (id) => {
    const def = catalog.data?.connectors.find((d) => d.id === id);
    return def ? connectorName(t, def) : id;
  });
  if (rows.length === 0) return null;
  return (
    <View style={[styles.facts, { backgroundColor: c.sunken }]}>
      {rows.map((r, i) => (
        <View
          key={r.label ?? "via"}
          style={[styles.fact, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 }]}
        >
          <Text variant="small" tone="muted" style={styles.factKey} numberOfLines={1}>
            {r.label ?? t("mobile.approval.via")}
          </Text>
          <Text variant="small" tone="ink" style={styles.grow} numberOfLines={2}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Why it asks, read before the action (ADR 0053 §8): "Pedido pela rotina «X» enquanto ninguém
 * acompanhava" when nobody was watching, then "Theo disse: “…”" (its reason, else its last words).
 * The request itself, or its notification (only its origin and why).
 */
export function ApprovalWhy({
  approval: a,
  name,
}: {
  approval: Pick<Approval, "origin" | "why" | "trail">;
  name: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const said = approvalSaid(a);
  const origin = approvalOriginWords(a);
  if (!said && !origin) return null;
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <View style={styles.why}>
      {origin ? (
        <View style={styles.origin}>
          <Icon name="clock" size={13} color={c.muted} />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            {tt(origin.key, origin.values)}
          </Text>
        </View>
      ) : null}
      {said ? (
        <Text variant="small" tone="ink2" style={styles.said}>
          {t("mobile.approval.why", { name, text: said })}
        </Text>
      ) : null}
    </View>
  );
}

/** The amber fuse burning to the expiry and "expira em N min" (amber: it waits on a person). */
export function ApprovalFuse({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow();
  return (
    <View style={styles.fuse}>
      <View style={styles.grow}>
        <Fuse color="amber" remaining={fuseRemaining(a.createdAt, a.expiresAt, now)} />
      </View>
      <Text variant="footnote" style={[styles.expiry, { color: c.amber }]}>
        {t("mobile.approval.expiresIn", { count: minutesLeft(a.expiresAt, now) })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  facts: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4 },
  fact: { flexDirection: "row", gap: 10, paddingVertical: 7 },
  factKey: { width: 92 },
  grow: { flex: 1, minWidth: 0 },
  said: { lineHeight: 20 },
  why: { gap: 4 },
  origin: { flexDirection: "row", alignItems: "center", gap: 6 },
  fuse: { flexDirection: "row", alignItems: "center", gap: 10 },
  expiry: { fontWeight: "500", fontVariant: ["tabular-nums"] },
});
