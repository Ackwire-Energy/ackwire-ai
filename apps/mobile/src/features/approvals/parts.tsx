import {
  type Approval,
  type ApprovalEmail,
  useCancelApproval,
  useCatalog,
  useCustomServers,
} from "@agenteschat/client";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { approvalDoing, approvalTitle } from "@agenteschat/client/lib/approval-words";
import { fromServer, itemName } from "@agenteschat/client/lib/connected";
import { nextLabel } from "@agenteschat/client/lib/format";
import { connectorName } from "@agenteschat/client/lib/scopes";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Chip, Fuse, Icon, LineIcon, Text, useToast } from "@/ui";
import { ConnectorIcon, IconTile } from "../connectors/ConnectorIcon";
import { AgentFace } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { fuseRemaining, minutesLeft } from "../shared/logic";
import {
  approvalSaid,
  approvalTable,
  approvalTraits,
  approveAlwaysHint,
  approveAlwaysLabel,
  approveAlwaysOffered,
} from "./logic";

/**
 * The exact request, in reading order: the action in words, the action itself (an email as it will be,
 * else the details table: Por onde, then the values it runs with), what the agent said, what it affects
 * as chips, and the amber fuse until it expires. The chat's question and the sheet draw the same pieces.
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
 * The action as a card's title, in words and in the person's language: an email's and the app's own titles as
 * `approvalTitle` says them; a connector's tool by what it does ("Gerar imagem", never the server's
 * "mcp.higgsfield.ai: Generate image", which the details keep).
 */
export function approvalHeadline(t: TFunction, a: Approval, locale: string) {
  if (a.email || !a.connector) return approvalTitle(t, a);
  const doing = approvalDoing(t, a, locale);
  return doing.charAt(0).toLocaleUpperCase(locale) + doing.slice(1);
}

/**
 * The app a request goes through: the connector (a server connected by address goes by its preset's mark and its
 * own name), a mailbox for an email, our own tools otherwise. Its name heads the request's source line.
 */
export function useApprovalSource(a: Approval) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const customId = a.connector?.startsWith("custom:") ? a.connector.slice("custom:".length) : null;
  const servers = useCustomServers(orgId, customId !== null);
  if (a.email) return { kind: "mail" as const, name: a.email.mailbox, def: null, image: undefined };
  if (!a.connector)
    return { kind: "builtin" as const, name: t("approvals.panel.builtIn"), def: null, image: undefined };
  const server = customId ? servers.data?.find((s) => s.id === customId) : undefined;
  const custom = server ? fromServer(server, catalog.data?.connectors ?? []) : null;
  const def = custom ? custom.def : (catalog.data?.connectors.find((d) => d.id === a.connector) ?? null);
  const name = custom
    ? itemName(t, custom)
    : customId
      ? t("approvals.panel.orgConnector")
      : def
        ? connectorName(t, def)
        : a.connector;
  return { kind: "connector" as const, name, def, image: custom?.image };
}

/** The app a request goes through, as a mark on a tile (`useApprovalSource`); its name is read aloud. */
export function ApprovalMark({ approval: a, size = 20 }: { approval: Approval; size?: number }) {
  const source = useApprovalSource(a);
  return (
    <View accessible accessibilityLabel={source.name}>
      {source.kind === "mail" ? (
        <IconTile name="mail" size={size} />
      ) : source.kind === "builtin" ? (
        <IconTile name="shield" size={size} />
      ) : (
        <ConnectorIcon def={source.def} image={source.image} label={source.name} size={size} />
      )}
    </View>
  );
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

/**
 * Por onde, then the exact values (at most `max` rows; `long`: whole, every one), on a sunken plate.
 * `stacked`: each label above its value and no plate, for a request card where a label column squeezes the values.
 */
export function ApprovalDetails({
  approval: a,
  max = 3,
  long = false,
  stacked = false,
}: {
  approval: Approval;
  max?: number;
  long?: boolean;
  stacked?: boolean;
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
    // Stacked it opens inside a request card: flat on it, divided by hairlines (never a plate in a card).
    <View style={stacked ? undefined : [styles.facts, { backgroundColor: c.sunken }]}>
      {rows.map((r, i) => (
        <View
          key={r.label ?? "via"}
          style={[
            stacked ? styles.factStacked : styles.fact,
            i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 },
          ]}
        >
          <Text
            variant={stacked ? "footnote" : "small"}
            tone="muted"
            style={stacked ? undefined : styles.factKey}
            numberOfLines={1}
          >
            {r.label ?? t("mobile.approval.via")}
          </Text>
          <Text
            variant="small"
            tone="ink"
            style={stacked ? styles.wrapAnywhere : styles.grow}
            numberOfLines={long ? undefined : stacked ? 4 : 2}
          >
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

/** A request for an action prepared ahead: that approving covers a later run, and when, as on the web. */
export function ApprovalAheadLine({
  approval: a,
}: {
  approval: Pick<Approval, "runAt" | "status" | "executedAt" | "decidedAt">;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  if (aheadPhase(a) !== "asking" || !a.runAt) return null;
  return (
    <View style={styles.origin}>
      <LineIcon name="clock" size={14} color={c.ink2} variant="small" />
      <Text variant="small" tone="ink" style={[styles.grow, styles.medium]}>
        {t("approval.ahead.line", { when: nextLabel(i18n.language, a.runAt) })}
      </Text>
    </View>
  );
}

/** Withdraws an action approved ahead before its time (its routine's run won't do it), and says so. */
export function useCancelAhead() {
  const { t } = useTranslation();
  const toast = useToast();
  const cancel = useCancelApproval(useOrgId());
  return {
    pending: cancel.isPending,
    cancel: (id: string, onDone?: () => void) =>
      cancel.mutate(id, {
        onSuccess: () => {
          toast({ title: t("approval.ahead.canceled") });
          onDone?.();
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      }),
  };
}

/**
 * "Aprovar sempre" ("Aprovar sempre leituras" for a SQL tool's reads) where the request offers it, and under it
 * exactly what one tap approves for good and where to undo it, as on the web.
 */
export function ApproveAlways({
  approval: a,
  name,
  disabled,
  onPress,
}: {
  approval: Approval;
  name: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  if (!approveAlwaysOffered(a)) return null;
  return (
    <View style={styles.always}>
      <Button variant="ghost" wide label={approveAlwaysLabel(t, a)} disabled={disabled} onPress={onPress} />
      <Text variant="caption" tone="faint" style={styles.alwaysHint}>
        {approveAlwaysHint(t, a, name || t("channel.unknownAgent"))}
      </Text>
    </View>
  );
}

/** "Aprovar sempre" in a request card's row of buttons, the same size as the others (its hint: `ApproveAlwaysHint`). */
export function ApproveAlwaysButton({
  approval: a,
  disabled,
  onPress,
}: {
  approval: Approval;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  if (!approveAlwaysOffered(a)) return null;
  return (
    <Button variant="secondary" size="card" label={approveAlwaysLabel(t, a)} disabled={disabled} onPress={onPress} />
  );
}

/** What "Aprovar sempre" covers and where to undo it, on a line of its own under the row of buttons. */
export function ApproveAlwaysHint({ approval: a, name }: { approval: Approval; name: string }) {
  const { t } = useTranslation();
  if (!approveAlwaysOffered(a)) return null;
  return (
    <Text variant="caption" tone="faint">
      {approveAlwaysHint(t, a, name || t("channel.unknownAgent"))}
    </Text>
  );
}

/** The amber fuse burning to the expiry and "expira em N min" (amber: it waits on a person). */
export function ApprovalFuse({ approval: a }: { approval: Pick<Approval, "createdAt" | "expiresAt"> }) {
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
  factStacked: { gap: 2, paddingVertical: 7 },
  wrapAnywhere: { flexShrink: 1 },
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
  always: { gap: 4 },
  alwaysHint: { textAlign: "center" },
});
