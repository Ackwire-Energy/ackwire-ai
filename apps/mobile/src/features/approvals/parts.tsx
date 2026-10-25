import { type Approval, type ApprovalEmail, useCatalog, useCustomServers } from "@agenteschat/client";
import { approvalOriginShort, approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { fromServer, itemName } from "@agenteschat/client/lib/connected";
import { connectorName } from "@agenteschat/client/lib/scopes";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, Fuse, Icon, LineIcon, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { fuseRemaining, minutesLeft } from "../shared/logic";
import { approvalSaid, approvalTable, approvalTraits } from "./logic";

/**
 * The exact request, in reading order: the action in words, the action itself (an email as it will be,
 * else the details table: Por onde, then the values it runs with), what the agent said, what it affects
 * as chips, and the amber fuse until it expires. The chat's card and the sheet draw the same pieces.
 */

const TRAIT_ICON = {
  production: "globe",
  irreversible: "x",
  reversible: "undo",
  external: "send",
  unsent: "archive",
  deletable: "undo",
} as const;

/**
 * The action in words, as the web says it: an email's ("Salvar um rascunho de resposta para…"), a tool run by
 * name ("Ver stack trace do evento", never "Sentry: Execute sentry tool"), the app's own tools, else the server's.
 */
export function approvalTitleText(
  t: TFunction,
  a: Pick<Approval, "tool" | "title" | "params" | "email"> & Partial<Pick<Approval, "connector">>,
) {
  return approvalTitle(t, a);
}

/** "rotina «X»" / "sem ninguém acompanhando", for the card's top line; null when a person was there. */
export function useOriginShort(a: Pick<Approval, "origin">) {
  const { t } = useTranslation();
  const origin = approvalOriginShort(a);
  if (!origin) return null;
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return tt(origin.key, origin.values);
}

/**
 * The email an approval writes, as it will be, one column (label above its value): De (the mailbox and
 * its provider), Para, Assunto, the text folded to four lines ("Ler tudo") unless `full`, and the
 * message it answers.
 */
export function ApprovalEmailLetter({ email, full }: { email: ApprovalEmail; full?: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const long = email.body.length > 180 || email.body.split("\n").length > 4;
  const rows: { label: string; value: string; note?: string }[] = [
    { label: t("approval.email.from"), value: email.from || email.mailbox, note: email.provider ?? undefined },
    ...(email.to.length > 0 ? [{ label: t("approval.email.to"), value: email.to.join(", ") }] : []),
    ...(email.cc.length > 0 ? [{ label: t("approval.email.cc"), value: email.cc.join(", ") }] : []),
    ...(email.bcc.length > 0 ? [{ label: t("approval.email.bcc"), value: email.bcc.join(", ") }] : []),
    { label: t("approval.email.subject"), value: email.subject || t("approval.email.noSubject") },
  ];
  const answers = email.original
    ? t(
        email.verb === "forward"
          ? email.original.from
            ? "mobile.approval.forwardsFrom"
            : "mobile.approval.forwards"
          : email.original.from
            ? "mobile.approval.answersFrom"
            : "mobile.approval.answers",
        { subject: email.original.subject, from: email.original.from ?? "" },
      )
    : null;
  return (
    <View style={[styles.letter, { borderColor: c.line2 }]}>
      <View style={[styles.letterHead, { borderBottomColor: c.line2 }]}>
        {rows.map((r) => (
          <View key={r.label}>
            <Text variant="footnote" tone="muted">
              {r.label}
            </Text>
            <Text variant="small" tone="ink" style={styles.medium}>
              {r.value}
            </Text>
            {r.note ? (
              <Text variant="footnote" tone="muted">
                {r.note}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      {email.body ? (
        <View style={styles.letterBody}>
          <Text variant="small" tone="ink2" style={styles.said} numberOfLines={full || open ? undefined : 4}>
            {email.body}
          </Text>
          {!full && long ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setOpen((o) => !o)}>
              <Text variant="footnote" tone="ink2" style={[styles.medium, styles.underline]}>
                {open ? t("approval.email.less") : t("approval.email.more")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {answers ? (
        <View style={[styles.answers, { backgroundColor: c.sunken, borderTopColor: c.line2 }]}>
          <Icon name="reply" size={13} color={c.muted} />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            {answers}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** What the agent said before asking, after the action: its face, "Lisa:" and its words. */
export function ApprovalSaid({
  approval: a,
  name,
}: {
  approval: Pick<Approval, "agentId" | "why" | "trail">;
  name: string;
}) {
  const { t } = useTranslation();
  const said = approvalSaid(a);
  if (!said) return null;
  return (
    <View style={styles.saidRow}>
      <AgentFace agentId={a.agentId} size={20} />
      <Text variant="small" tone="ink2" style={[styles.grow, styles.said]}>
        <Text variant="small" tone="ink" style={styles.medium}>
          {name}:{" "}
        </Text>
        {t("mobile.approval.saidText", { text: said })}
      </Text>
    </View>
  );
}

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

/** Por onde, then the exact values (at most `max` rows; `long`: whole, every one), on a sunken plate. */
export function ApprovalDetails({
  approval: a,
  max = 3,
  long = false,
}: {
  approval: Approval;
  max?: number;
  long?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const catalog = useCatalog();
  // A server connected by address (`custom:{connectionId}`) goes by its own name ("Sentry"), as on the web.
  const customId = a.connector?.startsWith("custom:") ? a.connector.slice("custom:".length) : null;
  const servers = useCustomServers(orgId, customId !== null);
  // The connector's name from the catalog ("GitHub"); the raw id until it loads.
  const rows = approvalTable(
    a,
    max,
    (id) => {
      if (customId) {
        const server = servers.data?.find((s) => s.id === customId);
        return server
          ? itemName(t, fromServer(server, catalog.data?.connectors ?? []))
          : t("approvals.panel.orgConnector");
      }
      const def = catalog.data?.connectors.find((d) => d.id === id);
      return def ? connectorName(t, def) : id;
    },
    long,
  );
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
          <Text variant="small" tone="ink" style={styles.grow} numberOfLines={long ? undefined : 2}>
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
          <LineIcon name="clock" size={13} color={c.muted} variant="footnote" />
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
  origin: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  fuse: { flexDirection: "row", alignItems: "center", gap: 10 },
  letter: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, borderBottomLeftRadius: 4, overflow: "hidden" },
  letterHead: { gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  letterBody: { gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  answers: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  medium: { fontWeight: "600" },
  underline: { textDecorationLine: "underline" },
  saidRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  expiry: { fontWeight: "500", fontVariant: ["tabular-nums"] },
});
