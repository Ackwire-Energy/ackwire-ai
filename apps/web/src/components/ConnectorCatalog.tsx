import type { ConnectorCategory, ConnectorDef } from "@agenteschat/client";
import type { MailChoice } from "@agenteschat/client/lib/mail";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import { Chip, Dialog, FilterToggle, Icon, initialsOf, SearchField, Toolbar } from "@agenteschat/ui";
import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingCards } from "@/components/Loading";
import { MailIcon, mailAuthKind, mailChoiceName } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";

export const CATEGORIES: ConnectorCategory[] = [
  "dev",
  "product",
  "docs",
  "payments",
  "support",
  "marketing",
  "automation",
];

/** Connector search over label, id and description, plus the text shown (`shown`: the name and description in the app's language). */
export function searchCatalog(list: ConnectorDef[], query: string, shown: (d: ConnectorDef) => string = () => "") {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description} ${shown(d)}`.toLowerCase().includes(q)) : list;
}

/** How it connects, for the card: one click (OAuth), OAuth or a key, or a key only. */
export function authKind(d: ConnectorDef): "oneClick" | "oauthOrKey" | "key" {
  if (d.kind === "remote_mcp") return "oneClick";
  return d.oauthConfigured && d.auth.includes("oauth") ? "oauthOrKey" : "key";
}

/** Only our own icons (`/connectors/{name}.svg`), never an arbitrary URL in CSS. */
const ICON_URL = /^\/connectors\/[a-z0-9-]+\.svg$/;

/**
 * The service's brand icon (Simple Icons, CC0) drawn as a mask in its brand
 * color (the ink for near-black brands); a monogram when there is none.
 */
export function ConnectorIcon({
  def,
  label,
  size = "md",
}: {
  def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  label: string;
  size?: "md" | "lg";
}) {
  const cls = `connector-icon${size === "lg" ? " connector-icon--lg" : ""}`;
  if (def?.iconUrl && ICON_URL.test(def.iconUrl)) {
    const style = {
      "--connector-icon": `url("${def.iconUrl}")`,
      ...(def.brandColor && /^#[0-9a-fA-F]{6}$/.test(def.brandColor) ? { "--connector-color": def.brandColor } : {}),
    } as CSSProperties;
    return (
      <span className={`${cls} connector-icon--brand`} aria-hidden="true">
        <span className="connector-icon__mark" style={style} />
      </span>
    );
  }
  return (
    <span className={`${cls} connector-icon--mono connector-icon--initial`} aria-hidden="true">
      {initialsOf(label)}
    </span>
  );
}

/**
 * "Adicionar conector": one catalog (our connectors and the vendors'
 * official MCP servers) with search and categories. A card opens the connect
 * flow; the dashed card connects any MCP server by its address.
 */
export function ConnectorCatalogDialog({
  open,
  onOpenChange,
  connectors,
  connected,
  loading,
  onPick,
  onOther,
  mail,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorDef[];
  /** Catalog ids already connected ("Conectado"). */
  connected: Set<string>;
  /** The catalog is still loading. */
  loading?: boolean;
  onPick: (def: ConnectorDef) => void;
  /** "Outro servidor MCP". */
  onOther: () => void;
  /** The "Email" group (ADR 0038): the mailboxes this server connects, which already have one, and the pick. */
  mail?: { choices: MailChoice[]; connected: Set<MailChoice>; onPick: (choice: MailChoice) => void };
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | "email" | "all">("all");
  const mailChoices = mail?.choices ?? [];
  const present = [
    ...(mailChoices.length > 0 ? (["email"] as const) : []),
    ...CATEGORIES.filter((c) => connectors.some((d) => d.category === c)),
  ];
  const shown = searchCatalog(connectors, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`).filter(
    (d) => category === "all" || d.category === category,
  );
  const needle = q.trim().toLowerCase();
  const mailShown =
    category === "all" || category === "email"
      ? mailChoices.filter(
          (c) =>
            !needle ||
            `${c} email ${t("connectors.category.email")} ${mailChoiceName(t, c)} ${t(`mail.choice.${c}.text`)}`
              .toLowerCase()
              .includes(needle),
        )
      : [];
  // Ready to connect first; "Em breve" last.
  const sorted = [...shown].sort((a, b) => Number(b.available) - Number(a.available));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("connectors.addTitle")}
      description={t("connectors.catalogText", { org: org.name })}
      closeLabel={t("common.close")}
      width={760}
    >
      <div className="ac-dialog__tools catalog__tools">
        <SearchField
          size="sm"
          aria-label={t("connectors.search")}
          placeholder={t("connectors.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
        />
        {present.length > 0 && (
          <Toolbar size="sm" label={t("connectors.categories")}>
            {(["all", ...present] as const).map((c) => (
              <FilterToggle key={c} pressed={category === c} onPressedChange={() => setCategory(c)}>
                {t(`connectors.category.${c}`)}
              </FilterToggle>
            ))}
          </Toolbar>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="ac-dialog__list catalog__list" role="region" aria-label={t("connectors.catalog")}>
        {loading ? (
          <LoadingCards count={6} className="catalog-grid catalog-grid--loading" />
        ) : (
          <ul className="catalog-grid">
            {mailShown.map((c) => (
              <li key={`mail-${c}`}>
                <button
                  type="button"
                  className="catalog-card"
                  aria-label={t("connectors.connectName", { name: mailChoiceName(t, c) })}
                  onClick={() => mail?.onPick(c)}
                >
                  <MailIcon choice={c} />
                  <span className="catalog-card__text">
                    <span className="catalog-card__head">
                      <span className="catalog-card__name">{mailChoiceName(t, c)}</span>
                      {mail?.connected.has(c) && (
                        <Chip icon="check" tone="done">
                          {t("connectors.connected")}
                        </Chip>
                      )}
                    </span>
                    <span className="catalog-card__desc">{t(`mail.choice.${c}.text`)}</span>
                    <span className="catalog-card__meta">
                      <Chip icon={mailAuthKind(c) === "oneClick" ? "bolt" : "lock"}>
                        {t(`mail.auth.${mailAuthKind(c)}`)}
                      </Chip>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {sorted.map((d) => {
              const isConnected = connected.has(d.id);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    className="catalog-card"
                    disabled={!d.available}
                    aria-label={t(isConnected ? "connectors.reconnectName" : "connectors.connectName", {
                      name: connectorName(t, d),
                    })}
                    onClick={() => onPick(d)}
                  >
                    <ConnectorIcon def={d} label={d.label} />
                    <span className="catalog-card__text">
                      <span className="catalog-card__head">
                        <span className="catalog-card__name">{connectorName(t, d)}</span>
                        {isConnected && (
                          <Chip icon="check" tone="done">
                            {t("connectors.connected")}
                          </Chip>
                        )}
                      </span>
                      <span className="catalog-card__desc">{connectorDescription(t, d)}</span>
                      {/* One tag, at the bottom: how it connects (the category is the filter above). */}
                      <span className="catalog-card__meta">
                        {d.available ? (
                          <Chip icon={authKind(d) === "key" ? "lock" : "bolt"}>
                            {t(`connectors.auth.${authKind(d)}`)}
                          </Chip>
                        ) : (
                          <Chip icon="waiting">{t("connectors.soon")}</Chip>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!q.trim() && category === "all" ? null : sorted.length === 0 && mailShown.length === 0 ? (
              <li className="catalog-grid__empty">
                <p className="ac-dialog__empty">
                  {q.trim() ? t("connectors.empty", { q }) : t("connectors.emptyCategory")}
                </p>
              </li>
            ) : null}
            <li>
              <button type="button" className="catalog-card catalog-card--other" onClick={onOther}>
                <span className="connector-icon connector-icon--mono" aria-hidden="true">
                  <Icon name="plus" />
                </span>
                <span className="catalog-card__text">
                  <span className="catalog-card__name">{t("connectors.other")}</span>
                  <span className="catalog-card__desc">{t("connectors.otherText")}</span>
                </span>
              </button>
            </li>
          </ul>
        )}
      </div>
    </Dialog>
  );
}
