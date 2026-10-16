import {
  AffixInput,
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAppearance,
  Avatar,
  agentGradient,
  Field,
  Icon,
  Select,
  type SelectOption,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Credential, Member, Model } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { QUICK_BUDGETS, readBudget } from "@/lib/new-agent";
import { type ModelChoice, providerLabel } from "@/lib/providers";

/*
 * The pieces "Criar agente" and the agent page share (same markup, same
 * `newag__*` styles): the look, the owner and key pickers, the model cards,
 * the budget and the instruction tips.
 */

/** Select value for "Sem responsável" (the API takes `ownerUserId: null`). */
export const NO_OWNER = "__none__";
/** Value of the "Chave padrão do workspace" option (the API takes `credentialId: null`). */
export const DEFAULT_KEY = "__default__";

/** "US$ 10", "US$ 12,50": whole amounts without cents. */
export const usd = (t: TFunction, locale: string, n: number) =>
  t("format.usd", { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n) });

/** 1–3 bars by price among the catalog's models (cheapest third = 1). */
export function priceTier(model: Model, models: Model[]) {
  const prices = [...new Set(models.map((m) => m.outputUsdPerMTok))].sort((a, b) => a - b);
  const rank = prices.indexOf(model.outputUsdPerMTok);
  return prices.length <= 1 ? 2 : Math.min(3, 1 + Math.floor((3 * rank) / prices.length));
}

/** Model descriptions of the approved screen, by model family. */
export function modelDescription(t: TFunction, locale: string, model: Model) {
  const id = model.id.toLowerCase();
  if (id.includes("sonnet")) return t("newAgent.modelDesc.sonnet");
  if (id.includes("opus")) return t("newAgent.modelDesc.opus");
  if (id.includes("haiku")) return t("newAgent.modelDesc.haiku");
  const fmt = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  return t("newAgent.modelDesc.other", { input: fmt(model.inputUsdPerMTok), output: fmt(model.outputUsdPerMTok) });
}

/** Key choices: the workspace default first (with its masked hint), then the other stored keys. */
export function keyOptions(t: TFunction, credentials: Credential[], defaultId: string | null): SelectOption[] {
  const live = credentials.filter((c) => !c.revokedAt);
  const def = live.find((c) => c.id === defaultId);
  return [
    {
      value: DEFAULT_KEY,
      label: t("newAgent.defaultKey"),
      description: def
        ? t("newAgent.defaultKeyDesc", { provider: providerLabel(def.provider), hint: def.keyHint })
        : undefined,
    },
    ...live
      .filter((c) => c.id !== defaultId)
      .map((c) => ({
        value: c.id,
        label: c.label,
        description: t("newAgent.otherKeyDesc", { provider: providerLabel(c.provider), hint: c.keyHint }),
      })),
  ];
}

type LookPatch = Partial<Required<AgentAppearance>>;

/** A model's cost without money (members and owners): cheapest, mid, most expensive. */
const TIER_KEY = { 1: "agentPage.tier.1", 2: "agentPage.tier.2", 3: "agentPage.tier.3" } as const;

/** Color swatches, eyes and an accessory, each a live symbol. `onPick` gets what changed. */
export function LookPicker({ look, onPick }: { look: Required<AgentAppearance>; onPick: (patch: LookPatch) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="newag__look-row">
        <span className="newag__label">
          {t("look.color")} <span className="newag__opt-label">{t(`look.colors.${look.color}`)}</span>
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: pressable swatches, not a native fieldset */}
        <div className="newag__swatches" role="group" aria-label={t("look.color")}>
          {AGENT_COLORS.map((c) => {
            const [top, bottom] = agentGradient(c);
            return (
              <button
                key={c}
                type="button"
                className="newag__swatch"
                aria-label={t(`look.colors.${c}`)}
                aria-pressed={look.color === c}
                style={{ "--a": top, "--b": bottom } as CSSProperties}
                onClick={() => onPick({ color: c })}
              />
            );
          })}
        </div>
      </div>
      <div className="newag__look-row">
        <span className="newag__label">{t("look.eyes")}</span>
        {/* biome-ignore lint/a11y/useSemanticElements: pressable options, not a native fieldset */}
        <div className="newag__opts" role="group" aria-label={t("look.eyes")}>
          {AGENT_EYES.map((e) => (
            <button
              key={e}
              type="button"
              className="newag__opt"
              aria-pressed={look.eyes === e}
              onClick={() => onPick({ eyes: e })}
            >
              <span className="newag__stage">
                <AgentAvatar name={t(`look.eyesNames.${e}`)} appearance={{ ...look, eyes: e, accessory: "none" }} />
              </span>
              {t(`look.eyesNames.${e}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="newag__look-row">
        <span className="newag__label">
          {t("look.accessory")} <span className="newag__opt-label">{t("newAgent.optional")}</span>
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: pressable options, not a native fieldset */}
        <div className="newag__opts newag__opts--acc" role="group" aria-label={t("look.accessory")}>
          {AGENT_ACCESSORIES.map((a) => (
            <button
              key={a}
              type="button"
              className="newag__opt"
              aria-pressed={look.accessory === a}
              onClick={() => onPick({ accessory: a })}
            >
              <span className="newag__stage">
                {a === "none" ? (
                  <Icon name="block" />
                ) : (
                  <AgentAvatar size="sm" name={t(`look.accessories.${a}`)} appearance={{ ...look, accessory: a }} />
                )}
              </span>
              {t(`look.accessories.${a}`)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** A picker shaped like the cards around it: the option's leading, name and description. */
const pickerValue = (o: SelectOption) => (
  <span className="newag__sel-value">
    {o.leading}
    <span className="newag__sel-text">
      <b>{o.label}</b>
      {o.description && <span>{o.description}</span>}
    </span>
  </span>
);

/** "Responsável": a member (you marked) or "Sem responsável". */
export function OwnerSelect({
  value,
  onChange,
  members,
  meId,
}: {
  value: string;
  onChange: (value: string) => void;
  members: Member[];
  meId: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      className="newag__sel"
      aria-label={t("newAgent.owner")}
      value={value}
      onValueChange={onChange}
      options={[
        ...members.map((m) => ({
          value: m.userId,
          label: m.userId === meId ? t("newAgent.you", { name: m.name }) : m.name,
          description: t(`roles.${m.role}`),
          leading: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
        })),
        {
          value: NO_OWNER,
          label: t("newAgent.noOwnerOption"),
          description: t("newAgent.noOwnerShort"),
          leading: (
            <span className="newag__ib">
              <Icon name="members" size={16} />
            </span>
          ),
        },
      ]}
      renderValue={pickerValue}
    />
  );
}

/** "Chave": the workspace default first, then the other stored keys. */
export function KeySelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
}) {
  const { t } = useTranslation();
  return (
    <Select
      className="newag__sel"
      aria-label={t("newAgent.key")}
      value={value}
      onValueChange={onChange}
      placeholder={t("newAgent.noKeys")}
      options={options.map((k) => ({
        ...k,
        leading: (
          <span className="newag__ib">
            <Icon name="key" size={16} />
          </span>
        ),
      }))}
      renderValue={pickerValue}
    />
  );
}

/** One model as a card: name, provider, what it's for, and its cost (money for admins, a tier for everyone else). */
function ModelCard({
  model,
  provider,
  available,
  all,
  money,
  pressed,
  onPick,
}: {
  model: Model;
  provider: string;
  available: boolean;
  all: Model[];
  money: boolean;
  pressed?: boolean;
  onPick?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const tier = priceTier(model, all);
  const body = (
    <>
      <span className="newag__model-head">
        <b>{model.label}</b>
        <span className="newag__model-prov">{providerLabel(provider)}</span>
      </span>
      {/* Other models describe themselves by price: only for those who see money. */}
      {(money || !available || /sonnet|opus|haiku/i.test(model.id)) && (
        <span className="newag__model-desc">
          {available
            ? modelDescription(t, locale, model)
            : t("newAgent.modelNeedsKey", { provider: providerLabel(provider) })}
        </span>
      )}
      {available ? (
        <span className="newag__cost">
          <span className="newag__meter" aria-hidden="true">
            {[1, 2, 3].map((n) => (
              <i key={n} data-on={n <= tier || undefined} />
            ))}
          </span>
          {money
            ? t("newAgent.price", {
                input: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(model.inputUsdPerMTok),
                output: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(model.outputUsdPerMTok),
              })
            : t(TIER_KEY[tier as 1 | 2 | 3])}
        </span>
      ) : (
        <span className="newag__cost">
          <Icon name="key" size={14} />
          {t("newAgent.noKeyFor", { provider: providerLabel(provider) })}
        </span>
      )}
    </>
  );
  if (!onPick) return <div className="newag__model newag__model--ro">{body}</div>;
  return (
    <button
      type="button"
      className="newag__model"
      aria-pressed={pressed}
      aria-disabled={!available || undefined}
      onClick={() => available && onPick()}
    >
      {body}
    </button>
  );
}

/** The models as cards, grouped by provider; those without a key say why. */
export function ModelCards({
  choices,
  value,
  onChange,
  money,
}: {
  choices: [string, ModelChoice[]][];
  value: string | undefined;
  onChange: (id: string) => void;
  money: boolean;
}) {
  const { t } = useTranslation();
  const all = choices.flatMap(([, list]) => list.map((c) => c.model));
  return (
    // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
    <div className="newag__models" role="group" aria-label={t("newAgent.model")}>
      {choices.flatMap(([provider, list]) =>
        list.map(({ model, available }) => (
          <ModelCard
            key={model.id}
            model={model}
            provider={provider}
            available={available}
            all={all}
            money={money}
            pressed={value === model.id}
            onPick={() => onChange(model.id)}
          />
        )),
      )}
    </div>
  );
}

/** The current model, read-only (a cost tier, never money). */
export function ModelCardView({ model, all, money }: { model: Model; all: Model[]; money: boolean }) {
  return <ModelCard model={model} provider={model.provider} available all={all} money={money} />;
}

/** "US$ [  ]" with quick amounts; empty = the workspace default. */
export function BudgetField({
  id,
  value,
  onChange,
  defaultBudget,
  error,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  defaultBudget: number | undefined;
  error?: string;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { amount } = readBudget(value);
  return (
    <div className="newag__money">
      <Field
        label={<span className="ac-visually-hidden">{t("newAgent.budget")}</span>}
        id={id}
        error={error}
        className="newag__money-field"
      >
        <AffixInput
          prefix="US$"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defaultBudget === undefined ? undefined : new Intl.NumberFormat(locale).format(defaultBudget)}
        />
      </Field>
      {QUICK_BUDGETS.map((v) => (
        <button
          key={v}
          type="button"
          className="newag__tog"
          aria-pressed={amount === v}
          onClick={() => onChange(String(v))}
        >
          {usd(t, locale, v)}
        </button>
      ))}
      {children}
    </div>
  );
}

/** "O que fazer", "O que evitar", "A quem pedir ajuda": a line added to the instructions. */
export function InstructionTips({ helper, onAdd }: { helper: string; onAdd: (text: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="newag__tips">
      {(["do", "avoid", "help"] as const).map((tip) => (
        <button
          key={tip}
          type="button"
          className="newag__tip"
          onClick={() => onAdd(t(`newAgent.tips.${tip}.text`, { name: helper }))}
        >
          <b>
            <Icon name="plus" size={14} />
            {t(`newAgent.tips.${tip}.title`)}
          </b>
          <span>{t(`newAgent.tips.${tip}.desc`)}</span>
        </button>
      ))}
    </div>
  );
}
