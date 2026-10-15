import { Button, Chip, Dialog, initialsOf, SearchInput } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectorCategory, ConnectorDef } from "@/api/types";
import { LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { connectorDescription } from "@/lib/scopes";

export const CATEGORIES: ConnectorCategory[] = ["dev", "product", "docs", "payments", "marketing", "support"];

/** Connector search over label, id and description. */
export function searchCatalog(list: ConnectorDef[], query: string) {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description}`.toLowerCase().includes(q)) : list;
}

/** Configured on this server (else "Em breve"). Older servers: OAuth app or an API key. */
export const isAvailable = (d: ConnectorDef) => d.available ?? (d.oauthConfigured || d.auth.includes("api_key"));

/** Signs in with OAuth (an official remote MCP server, or an OAuth app this server has). */
export const usesOAuth = (d: ConnectorDef) =>
  d.auth.includes("oauth") && (d.kind === "remote_mcp" || d.oauthConfigured);

/** The catalog's own asset when it gives one; else a neutral monogram (no copied brand logos). */
export function ConnectorIcon({ def }: { def: ConnectorDef }) {
  if (def.iconUrl?.startsWith("https://")) {
    return <img className="connector-icon" src={def.iconUrl} alt="" width={36} height={36} loading="lazy" />;
  }
  return (
    <span className="connector-icon connector-icon--mono" aria-hidden="true">
      {initialsOf(def.label)}
    </span>
  );
}

/**
 * "Adicionar conector": the catalog with search and categories; one card per
 * connector (icon, name, one line, "OAuth", "Conectar"). Not configured on
 * this server: "Em breve", disabled.
 */
export function ConnectorCatalogDialog({
  open,
  onOpenChange,
  connectors,
  connected,
  pendingId,
  loading,
  onPick,
  onOther,
}: {
  /** The catalog is still loading. */
  loading?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorDef[];
  connected: Set<string>;
  /** Connecting right now (a remote MCP server answering). */
  pendingId?: string | null;
  onPick: (def: ConnectorDef) => void;
  /** "Outro servidor MCP". */
  onOther?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | "all">("all");
  const present = CATEGORIES.filter((c) => connectors.some((d) => d.category === c));
  const shown = searchCatalog(connectors, q).filter((d) => category === "all" || d.category === category);
  // Ready to connect first; "Em breve" last.
  const sorted = [...shown].sort((a, b) => Number(isAvailable(b)) - Number(isAvailable(a)));
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
        ) : sorted.length === 0 ? (
          <p className="ac-dialog__empty">{q.trim() ? t("connectors.empty", { q }) : t("connectors.emptyCategory")}</p>
        ) : (
          <ul className="catalog-grid">
            {sorted.map((d) => {
              const available = isAvailable(d);
              const titleId = `cat-${d.id}`;
              return (
                <li
                  key={d.id}
                  className="catalog-card"
                  aria-labelledby={titleId}
                  data-disabled={!available || undefined}
                >
                  <ConnectorIcon def={d} />
                  <div className="catalog-card__text">
                    <span className="catalog-card__head">
                      <span id={titleId} className="catalog-card__name">
                        {d.label}
                      </span>
                      {usesOAuth(d) && <span className="catalog-card__badge">{t("connectors.oauthBadge")}</span>}
                    </span>
                    <span className="catalog-card__desc small muted">{connectorDescription(t, d)}</span>
                  </div>
                  <div className="catalog-card__action">
                    {connected.has(d.id) ? (
                      <Chip icon="check" tone="done">
                        {t("connectors.connected")}
                      </Chip>
                    ) : !available ? (
                      <Chip icon="waiting">{t("connectors.soon")}</Chip>
                    ) : (
                      <Button
                        size="sm"
                        loading={pendingId === d.id}
                        disabled={Boolean(pendingId)}
                        aria-label={t("connectors.connectName", { name: d.label })}
                        onClick={() => onPick(d)}
                      >
                        {t("connectors.connect")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {onOther && (
        <div className="catalog__other">
          <span className="small muted">{t("connectors.otherText")}</span>
          <Button size="sm" variant="ghost" onClick={onOther}>
            {t("customMcp.connectOther")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
