import type { ConnectorCategory, ConnectorDef } from "@agenteschat/client";
import type { MailChoice } from "@agenteschat/client/lib/mail";
import { connectorDescription, connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { Button, Dialog, FilterToggle, Icon, type IconName, initialsOf, SearchField, Toolbar } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseIcon } from "@/components/DatabaseConnect";
import { LoadingCards } from "@/components/Loading";
import { MailIcon, mailAuthKind, mailChoiceName } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { ConnectorSky } from "@/components/Sky";

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

/** How a service connects, for the detail pane. */
type HowKind = "oneClick" | "oauthOrKey" | "key" | "appPassword" | "addressPassword";

/** One service in the catalog: a catalog connector, a mailbox kind or the Postgres database. */
interface Entry {
  key: string;
  name: string;
  description: string;
  category: ConnectorCategory | "email";
  connected: boolean;
  available: boolean;
  icon: (size: "md" | "lg") => ReactNode;
  brandColor: string | null;
  how: HowKind;
  /** What agents could do there; `asks` = it always asks a person first. */
  can: { text: string; asks: boolean }[];
  /** Starts this service's connect flow (the same flows as before). */
  pick: () => void;
}

/** i18n key of an id (`cloudflare-bindings` → `cloudflare_bindings`). */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "_");

/**
 * The capability lines of a service: our plain-language lines (`connectors.can.<id>`: "1", "2", "3",
 * and "ask" for what always asks approval), or else its scopes.
 */
function capabilities(t: TFunction, exists: (key: string) => boolean, id: string, def?: ConnectorDef) {
  const tt = t as unknown as (key: string) => string;
  const base = `connectors.can.${safeId(id)}`;
  if (exists(`${base}.1`)) {
    const lines = (["1", "2", "3"] as const)
      .filter((n) => exists(`${base}.${n}`))
      .map((n) => ({ text: tt(`${base}.${n}`), asks: false }));
    if (exists(`${base}.ask`)) lines.push({ text: tt(`${base}.ask`), asks: true });
    return lines;
  }
  return (def?.scopes ?? []).map((s) => ({ text: scopeText(t, s).label, asks: s.sensitive }));
}

/** Suggestions, in order: the first three not connected yet (and ready on this server). */
const SUGGESTED = ["github", "database", "linear", "notion", "mail-gmail", "drive", "sentry", "stripe", "slack"];

/** The pane's "Não achou?" entry. */
const OTHER = "other";

/**
 * "Adicionar conector" (telas/CatalogoConectores.html, B+C): a gallery with search and one line of
 * category filters, three suggestions on top, then every service as an even tile (no tags: a check on
 * the icon when connected). A tile opens the detail beside it (what agents could do, how it connects,
 * Conectar); "Não achou?" connects any service by its address.
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
  database,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorDef[];
  /** Catalog ids already connected. */
  connected: Set<string>;
  /** The catalog is still loading. */
  loading?: boolean;
  onPick: (def: ConnectorDef) => void;
  /** Any service by its address (a custom server). */
  onOther: () => void;
  /** The "Email" group (ADR 0038): the mailboxes this server connects, which already have one, and the pick. */
  mail?: { choices: MailChoice[]; connected: Set<MailChoice>; onPick: (choice: MailChoice) => void };
  /** The Postgres database (ADR 0039), in "Desenvolvimento"; it can be connected more than once. */
  database?: { connected: boolean; onPick: () => void };
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ConnectorCategory | "email" | "all" | "connected">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const exists = (key: string) => i18n.exists(key);

  const entries: Entry[] = [
    ...(mail?.choices ?? []).map(
      (c): Entry => ({
        key: `mail-${c}`,
        name: mailChoiceName(t, c),
        description: t(`mail.choice.${c}.text`),
        category: "email",
        connected: mail?.connected.has(c) ?? false,
        available: true,
        icon: (size) => <MailIcon choice={c} size={size} />,
        brandColor: c === "gmail" ? "#EA4335" : c === "icloud" ? "#3693F3" : null,
        how: mailAuthKind(c),
        can: capabilities(t, exists, `mail-${c}`),
        pick: () => mail?.onPick(c),
      }),
    ),
    ...(database
      ? [
          {
            key: "database",
            name: t("database.name"),
            description: t("database.cardText"),
            category: "dev",
            connected: database.connected,
            available: true,
            icon: (size: "md" | "lg") => <DatabaseIcon size={size} />,
            brandColor: null,
            how: "addressPassword",
            can: capabilities(t, exists, "database"),
            pick: database.onPick,
          } satisfies Entry,
        ]
      : []),
    ...connectors.map(
      (d): Entry => ({
        key: d.id,
        name: connectorName(t, d),
        description: connectorDescription(t, d),
        category: d.category,
        connected: connected.has(d.id),
        available: d.available,
        icon: (size) => <ConnectorIcon def={d} label={d.label} size={size} />,
        brandColor: d.brandColor,
        how: authKind(d),
        can: capabilities(t, exists, d.id, d),
        pick: () => onPick(d),
      }),
    ),
  ];
  // Ready to connect first; "Em breve" last.
  entries.sort((a, b) => Number(b.available) - Number(a.available));

  const present = [
    ...((mail?.choices.length ?? 0) > 0 ? (["email"] as const) : []),
    ...CATEGORIES.filter((c) => entries.some((e) => e.category === c)),
  ];
  const countOf = (c: typeof category) =>
    c === "all"
      ? entries.length
      : c === "connected"
        ? entries.filter((e) => e.connected).length
        : entries.filter((e) => e.category === c).length;
  const needle = q.trim().toLowerCase();
  const matches = (e: Entry) =>
    !needle ||
    `${e.key} ${e.name} ${e.description} ${t(`connectors.category.${e.category}`)} ${e.key === "database" ? "postgres postgresql sql" : ""} ${e.category === "email" ? "email" : ""}`
      .toLowerCase()
      .includes(needle);
  const inCategory = (e: Entry) =>
    category === "all" || (category === "connected" ? e.connected : e.category === category);
  const showSuggestions = category === "all" && !needle;
  const suggested = showSuggestions
    ? SUGGESTED.map((k) => entries.find((e) => e.key === k))
        .filter((e): e is Entry => !!e && !e.connected && e.available)
        .slice(0, 3)
    : [];
  const shown = entries.filter((e) => inCategory(e) && matches(e) && !suggested.includes(e));
  const current = selected === OTHER ? null : (entries.find((e) => e.key === selected) ?? null);
  const paneOpen = selected === OTHER || !!current;

  const toggle = (key: string) => {
    setSelected((s) => (s === key ? null : key));
    // The pane takes focus once it renders (its heading), so keyboard people land in it.
    requestAnimationFrame(() => paneRef.current?.focus());
  };
  const close = (next: boolean) => {
    if (!next) {
      setSelected(null);
      setQ("");
      setCategory("all");
    }
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t("connectors.addTitle")}
      closeLabel={t("common.close")}
      width={1080}
      className="catalog"
      onEscapeKeyDown={(e) => {
        // Esc closes the detail first, then the dialog.
        if (paneOpen) {
          e.preventDefault();
          setSelected(null);
        }
      }}
    >
      <div className="catalog__tools">
        <SearchField
          size="sm"
          className="catalog__search"
          aria-label={t("connectors.search")}
          placeholder={t("connectors.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
        />
        <Toolbar size="sm" label={t("connectors.categories")} className="catalog__filters">
          {(["all", "connected", ...present] as const).map((c) => (
            <FilterToggle key={c} pressed={category === c} count={countOf(c)} onPressedChange={() => setCategory(c)}>
              {c === "connected" ? t("connectors.connectedFilter") : t(`connectors.category.${c}`)}
            </FilterToggle>
          ))}
        </Toolbar>
      </div>
      <div className="catalog__body" data-pane={paneOpen || undefined}>
        {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
        <div className="catalog__list" role="region" aria-label={t("connectors.catalog")}>
          {loading ? (
            <LoadingCards count={6} className="catalog-grid catalog-grid--loading" />
          ) : (
            <>
              {suggested.length > 0 && (
                <section className="catalog__section" aria-labelledby="catalog-suggested">
                  <h3 id="catalog-suggested" className="catalog__h">
                    {t("connectors.suggested", { org: org.name })}
                  </h3>
                  <ul className="catalog-feat">
                    {suggested.map((e) => (
                      <li key={e.key}>
                        <button
                          type="button"
                          className="catalog-feat__card"
                          aria-label={e.name}
                          aria-pressed={selected === e.key}
                          onClick={() => toggle(e.key)}
                        >
                          <ConnectorSky brand={e.brandColor} />
                          <span className="catalog-feat__icon">{e.icon("lg")}</span>
                          <span className="catalog-feat__name">{e.name}</span>
                          <span className="catalog-feat__desc">{e.description}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className="catalog__section" aria-labelledby={suggested.length > 0 ? "catalog-more" : undefined}>
                {suggested.length > 0 && (
                  <h3 id="catalog-more" className="catalog__h">
                    {t("connectors.more")}
                  </h3>
                )}
                <ul className="catalog-grid">
                  {shown.map((e) => (
                    <li key={e.key}>
                      <button
                        type="button"
                        className="catalog-tile"
                        aria-pressed={selected === e.key}
                        aria-label={e.connected ? t("connectors.tileConnected", { name: e.name }) : e.name}
                        data-soon={!e.available || undefined}
                        onClick={() => toggle(e.key)}
                      >
                        <span className="catalog-tile__head">
                          <TileIcon entry={e} size="md" />
                          <span className="catalog-tile__name">{e.name}</span>
                        </span>
                        <span className="catalog-tile__desc">{e.description}</span>
                      </button>
                    </li>
                  ))}
                  {shown.length === 0 && (needle || category !== "all") && (
                    <li className="catalog-grid__empty">
                      <p className="ac-dialog__empty">
                        {needle ? t("connectors.empty", { q }) : t("connectors.emptyCategory")}
                      </p>
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      className="catalog-tile catalog-tile--other"
                      aria-pressed={selected === OTHER}
                      onClick={() => toggle(OTHER)}
                    >
                      <span className="catalog-tile__head">
                        <span className="connector-icon connector-icon--mono" aria-hidden="true">
                          <Icon name="link" />
                        </span>
                        <span className="catalog-tile__name">{t("connectors.other")}</span>
                      </span>
                      <span className="catalog-tile__desc">{t("connectors.otherText")}</span>
                    </button>
                  </li>
                </ul>
              </section>
            </>
          )}
        </div>
        {paneOpen && (
          <aside
            ref={paneRef}
            className="catalog-detail"
            tabIndex={-1}
            aria-label={t("connectors.detail.label", { name: current?.name ?? t("connectors.otherTitle") })}
          >
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              className="catalog-detail__close"
              aria-label={t("connectors.detail.close")}
              onClick={() => setSelected(null)}
            />
            {current ? (
              <Detail
                entry={current}
                onConnect={() => {
                  setSelected(null);
                  current.pick();
                }}
              />
            ) : (
              <OtherDetail
                onConnect={() => {
                  setSelected(null);
                  onOther();
                }}
              />
            )}
          </aside>
        )}
      </div>
    </Dialog>
  );
}

/** A tile's icon; a green check on it when the service is connected. */
function TileIcon({ entry, size }: { entry: Entry; size: "md" | "lg" }) {
  return (
    <span className="catalog-icon">
      {entry.icon(size)}
      {entry.connected && (
        <span className="catalog-icon__check" aria-hidden="true">
          <Icon name="check" size={14} />
        </span>
      )}
    </span>
  );
}

const HOW_ICON: Record<HowKind, IconName> = {
  oneClick: "bolt",
  oauthOrKey: "bolt",
  key: "key",
  appPassword: "lock",
  addressPassword: "lock",
};

/** The pane for one service: what agents could do, then how it connects and the button. */
function Detail({ entry, onConnect }: { entry: Entry; onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <TileIcon entry={entry} size="lg" />
      <div className="catalog-detail__intro">
        <h3 className="catalog-detail__name">{entry.name}</h3>
        <p className="catalog-detail__desc">{entry.description}</p>
      </div>
      {entry.can.length > 0 && (
        <div className="catalog-detail__part">
          <h4 className="catalog-detail__h">{t("connectors.detail.can")}</h4>
          <ul className="catalog-detail__caps">
            {entry.can.map((c) => (
              <li key={c.text} data-asks={c.asks || undefined}>
                <Icon name={c.asks ? "shield" : "check"} size={14} />
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="catalog-detail__part">
        <h4 className="catalog-detail__h">{t("connectors.detail.after")}</h4>
        <p className="catalog-detail__text">{t("connectors.detail.afterText")}</p>
      </div>
      <div className="catalog-detail__act">
        {entry.available ? (
          <Button
            variant="primary"
            block
            aria-label={t(entry.connected ? "connectors.reconnectName" : "connectors.connectName", {
              name: entry.name,
            })}
            onClick={onConnect}
          >
            {entry.connected ? t("connectors.detail.again") : t("connectors.connectName", { name: entry.name })}
          </Button>
        ) : (
          <Button variant="primary" block disabled>
            {t("connectors.soon")}
          </Button>
        )}
        <span className="catalog-detail__how">
          <Icon name={entry.connected ? "check" : HOW_ICON[entry.how]} size={14} />
          {entry.connected ? t("connectors.detail.connected") : t(`connectors.how.${entry.how}`)}
        </span>
      </div>
    </>
  );
}

/** "Não achou?": any service by its address (a custom server), in plain words. */
function OtherDetail({ onConnect }: { onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="connector-icon connector-icon--lg connector-icon--mono" aria-hidden="true">
        <Icon name="link" />
      </span>
      <div className="catalog-detail__intro">
        <h3 className="catalog-detail__name">{t("connectors.otherTitle")}</h3>
        <p className="catalog-detail__desc">{t("connectors.otherDetail")}</p>
      </div>
      <div className="catalog-detail__part">
        <h4 className="catalog-detail__h">{t("connectors.detail.how")}</h4>
        <ul className="catalog-detail__caps">
          {(["1", "2"] as const).map((n) => (
            <li key={n}>
              <Icon name="check" size={14} />
              <span>{t(`connectors.otherSteps.${n}`)}</span>
            </li>
          ))}
          <li data-asks>
            <Icon name="shield" size={14} />
            <span>{t("connectors.otherSteps.ask")}</span>
          </li>
        </ul>
      </div>
      <div className="catalog-detail__act">
        <Button variant="primary" block onClick={onConnect}>
          {t("connectors.otherConnect")}
        </Button>
      </div>
    </>
  );
}
