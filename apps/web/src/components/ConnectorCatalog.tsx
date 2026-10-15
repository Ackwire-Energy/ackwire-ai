import { Chip, Dialog, Icon, initialsOf, SearchInput } from "@agenteschat/ui";
import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectorCategory, ConnectorDef } from "@/api/types";
import { LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { connectorDescription } from "@/lib/scopes";

export const CATEGORIES: ConnectorCategory[] = [
  "dev",
  "product",
  "docs",
  "payments",
  "support",
  "marketing",
  "automation",
];

/** Connector search over label, id and description. */
export function searchCatalog(list: ConnectorDef[], query: string) {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description}`.toLowerCase().includes(q)) : list;
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
    <span className={`${cls} connector-icon--mono`} aria-hidden="true">
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
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | "all">("all");
  const present = CATEGORIES.filter((c) => connectors.some((d) => d.category === c));
  const shown = searchCatalog(connectors, q).filter((d) => category === "all" || d.category === category);
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
        <SearchInput
          aria-label={t("connectors.search")}
          placeholder={t("connectors.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {present.length > 0 && (
          <fieldset className="catalog__cats">
            <legend className="ac-visually-hidden">{t("connectors.categories")}</legend>
            {(["all", ...present] as const).map((c) => (
              <button
                key={c}
                type="button"
                className="catalog__cat"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {t(`connectors.category.${c}`)}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="ac-dialog__list catalog__list" role="region" aria-label={t("connectors.catalog")}>
        {loading ? (
          <LoadingCards count={6} className="catalog-grid catalog-grid--loading" />
        ) : (
          <ul className="catalog-grid">
            {sorted.map((d) => {
              const isConnected = connected.has(d.id);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    className="catalog-card"
                    disabled={!d.available}
                    aria-label={t(isConnected ? "connectors.reconnectName" : "connectors.connectName", {
                      name: d.label,
                    })}
                    onClick={() => onPick(d)}
                  >
                    <ConnectorIcon def={d} label={d.label} />
                    <span className="catalog-card__text">
                      <span className="catalog-card__head">
                        <span className="catalog-card__name">{d.label}</span>
                        {isConnected && (
                          <Chip icon="check" tone="done">
                            {t("connectors.connected")}
                          </Chip>
                        )}
                      </span>
                      <span className="catalog-card__desc">{connectorDescription(t, d)}</span>
                      <span className="catalog-card__meta">
                        <Chip icon="link">{t(`connectors.category.${d.category}`)}</Chip>
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
            {!q.trim() && category === "all" ? null : sorted.length === 0 ? (
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
