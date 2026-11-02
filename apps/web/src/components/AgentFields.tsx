import type { Credential, Member } from "@agenteschat/client";
import { apiPickOptions, type BrainPickOption, brainPickText } from "@agenteschat/client/lib/brain-picker";
import { type ModelChoice, providerLabel } from "@agenteschat/client/lib/providers";
import {
  AffixInput,
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAppearance,
  Avatar,
  agentGradient,
  Carousel,
  ColorPicker,
  colorKey,
  Field,
  Icon,
  isHexColor,
  matchesWords,
  Popover,
  ProviderLogo,
  SearchSelect,
  Select,
  type SelectOption,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { QUICK_BUDGETS, readBudget } from "@/lib/new-agent";

/*
 * The pieces "Criar agente" and the agent page share (same markup, same
 * `newag__*` styles): the look, the owner and key pickers, "Quem pensa",
 * the budget and the instruction tips.
 */

/** Select value for "Sem responsável" (the API takes `ownerUserId: null`). */
export const NO_OWNER = "__none__";
/** Value of the "Chave padrão do workspace" option (the API takes `credentialId: null`). */
export const DEFAULT_KEY = "__default__";

/** "$10", "US$ 12,50": whole amounts without cents, as the language writes dollars. */
export const usd = (_t: TFunction, locale: string, n: number) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);

/**
 * The model picker's options: each provider's models under its name, OpenRouter's good picks before the rest of its
 * list; those without a key say why.
 */
export const modelOptions = (t: TFunction, locale: string, choices: [string, ModelChoice[]][]) =>
  apiPickOptions(t, locale, choices).map(pickSelectOption);

/** A "Quem pensa" option as a select's, its maker's mark before it (Automático's bulb). */
export const pickSelectOption = (o: BrainPickOption): SelectOption & BrainPickOption => ({
  ...o,
  leading: o.mark ? (
    <ProviderLogo id={o.mark} size="sm" />
  ) : (
    <span className="newag__ib">
      <Icon name="bulb" size={16} />
    </span>
  ),
});

/**
 * "Quem pensa" on the new agent's step: every model and plan the agent's page offers (`brainPickOptions`), in one
 * list searched by name, maker, plan or "free"; the chosen one reads as what thinks ("Sonnet pelo plano do Claude").
 */
export function BrainPickSelect({
  options,
  value,
  onChange,
  fallback,
}: {
  options: BrainPickOption[];
  value: string | undefined;
  onChange: (option: BrainPickOption) => void;
  /** What the trigger says for a choice the list doesn't have (the last setup's, a proposal's). */
  fallback: string;
}) {
  const { t } = useTranslation();
  const shown = useMemo(() => options.map(pickSelectOption), [options]);
  return (
    <SearchSelect
      className="agp-brainsel"
      aria-label={t("brain.title")}
      value={value}
      onValueChange={(v) => {
        const o = options.find((x) => x.value === v);
        if (o) onChange(o);
      }}
      options={shown}
      matches={(o, q) => matchesWords(brainPickText(o), q)}
      labels={{
        search: t("models.search"),
        searchPlaceholder: t("newAgent.brainPick.searchPlaceholder"),
        noResults: t("models.noResults"),
        list: t("models.list"),
      }}
      renderValue={(o) =>
        o ? pickerValue({ ...o, label: o.title }) : <span className="newag__sel-value">{fallback}</span>
      }
    />
  );
}

/** A model picker for a long list: a search over the models (name, maker, id), shaped like the cards around it. */
export function ModelSelect({
  value,
  onChange,
  options,
  className,
  "aria-label": label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  return (
    <SearchSelect
      className={className}
      aria-label={label}
      value={value}
      onValueChange={onChange}
      options={options}
      labels={{
        search: t("models.search"),
        searchPlaceholder: t("models.searchPlaceholder"),
        noResults: t("models.noResults"),
        list: t("models.list"),
      }}
      renderValue={(o) => (o ? pickerValue(o) : value)}
    />
  );
}

/**
 * Key choices by their provider's mark: the workspace default first (with its masked hint), then the other
 * stored keys.
 */
/** `provider`: whose key the default would be when the workspace has none set (the chosen model's maker). */
export function keyOptions(
  t: TFunction,
  credentials: Credential[],
  defaultId: string | null,
  provider?: string,
): SelectOption[] {
  const live = credentials.filter((c) => !c.revokedAt);
  const def = live.find((c) => c.id === defaultId);
  return [
    {
      value: DEFAULT_KEY,
      label: t("newAgent.defaultKey"),
      description: def
        ? t("newAgent.defaultKeyDesc", { provider: providerLabel(def.provider), hint: def.keyHint })
        : undefined,
      leading:
        def || provider ? (
          <ProviderLogo id={def?.provider ?? provider ?? ""} size="sm" />
        ) : (
          <span className="newag__ib">
            <Icon name="key" size={16} />
          </span>
        ),
    },
    ...live
      .filter((c) => c.id !== defaultId)
      .map((c) => ({
        value: c.id,
        label: c.label,
        description: t("newAgent.otherKeyDesc", { provider: providerLabel(c.provider), hint: c.keyHint }),
        leading: <ProviderLogo id={c.provider} size="sm" />,
      })),
  ];
}

type LookPatch = Partial<Required<AgentAppearance>>;

type LookPickProps = { look: Required<AgentAppearance>; onPick: (patch: LookPatch) => void };

/** The choices of a look row: wrapping ("Criar agente") or one sliding row (the agent's settings). */
function ChoiceRow({
  label,
  carousel,
  acc,
  children,
}: {
  label: string;
  carousel?: boolean;
  acc?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (carousel)
    return (
      <Carousel label={label} previousLabel={t("look.previous")} nextLabel={t("look.next")} className="newag__car">
        {children}
      </Carousel>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: pressable options, not a native fieldset
    <div className={acc ? "newag__opts newag__opts--acc" : "newag__opts"} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Color swatches, eyes and an accessory, each a live symbol. `onPick` gets what changed. */
export function LookPicker({ look, onPick }: LookPickProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="newag__look-row">
        <span className="newag__label">
          {t("look.color")} <span className="newag__opt-label">{t(`look.colors.${colorKey(look.color)}`)}</span>
        </span>
        <ColorChoices look={look} onPick={onPick} />
      </div>
      <div className="newag__look-row">
        <span className="newag__label">{t("look.eyes")}</span>
        <EyesChoices look={look} onPick={onPick} />
      </div>
      <div className="newag__look-row">
        <span className="newag__label">
          {t("look.accessory")} <span className="newag__opt-label">{t("newAgent.optional")}</span>
        </span>
        <AccessoryChoices look={look} onPick={onPick} />
      </div>
    </>
  );
}

function ColorChoices({ look, onPick }: LookPickProps) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: pressable swatches, not a native fieldset
    <div className="newag__swatches" role="group" aria-label={t("look.color")}>
      {AGENT_COLORS.map((c) => {
        const [top, bottom] = agentGradient(c);
        return (
          <button
            key={c}
            type="button"
            className="newag__swatch"
            aria-label={t(`look.colors.${c}`)}
            title={t(`look.colors.${c}`)}
            aria-pressed={look.color === c}
            style={{ "--a": top, "--b": bottom } as CSSProperties}
            onClick={() => onPick({ color: c })}
          />
        );
      })}
      <CustomColor look={look} onPick={onPick} />
    </div>
  );
}

/** The ninth swatch, "Personalizar": a rainbow until a custom color is picked, then that color, selected. */
function CustomColor({ look, onPick }: LookPickProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const custom = isHexColor(look.color);
  const [top, bottom] = custom ? agentGradient(look.color) : [];
  return (
    <Popover
      label={t("look.customColor")}
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className={custom ? "newag__swatch" : "newag__swatch newag__swatch--custom"}
          aria-label={t("look.customColor")}
          title={t("look.customColor")}
          aria-pressed={custom}
          style={custom ? ({ "--a": top, "--b": bottom } as CSSProperties) : undefined}
        />
      }
    >
      <ColorPicker
        value={look.color}
        onChange={(color) => onPick({ color })}
        onDone={() => setOpen(false)}
        labels={{ area: t("look.colorArea"), hue: t("look.hue"), hex: t("look.hex") }}
      />
    </Popover>
  );
}

function EyesChoices({ look, onPick, carousel }: LookPickProps & { carousel?: boolean }) {
  const { t } = useTranslation();
  return (
    <ChoiceRow label={t("look.eyes")} carousel={carousel}>
      {AGENT_EYES.map((e) => (
        <button
          key={e}
          type="button"
          className="newag__opt"
          aria-pressed={look.eyes === e}
          onClick={() => onPick({ eyes: e })}
        >
          <span className="newag__stage">
            <AgentAvatar
              framed={false}
              name={t(`look.eyesNames.${e}`)}
              appearance={{ ...look, eyes: e, accessory: "none" }}
            />
          </span>
          {t(`look.eyesNames.${e}`)}
        </button>
      ))}
    </ChoiceRow>
  );
}

function AccessoryChoices({ look, onPick, carousel }: LookPickProps & { carousel?: boolean }) {
  const { t } = useTranslation();
  return (
    <ChoiceRow label={t("look.accessory")} carousel={carousel} acc>
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
              <AgentAvatar
                size="sm"
                framed={false}
                name={t(`look.accessories.${a}`)}
                appearance={{ ...look, accessory: a }}
              />
            )}
          </span>
          {t(`look.accessories.${a}`)}
        </button>
      ))}
    </ChoiceRow>
  );
}

/**
 * The look right on the agent's settings: the colors, then the eyes and what it
 * wears as one sliding row each, so the section stays short. Each pick shows at once.
 */
export function LookRows({
  look,
  onChange,
}: {
  look: Required<AgentAppearance>;
  onChange: (look: Required<AgentAppearance>) => void;
}) {
  const { t } = useTranslation();
  const pick = (patch: LookPatch) => onChange({ ...look, ...patch });
  return (
    <div className="agp-look">
      <div className="agp-look__row">
        <span className="newag__label">{t("look.color")}</span>
        <ColorChoices look={look} onPick={pick} />
      </div>
      <div className="agp-look__row">
        <span className="newag__label">{t("look.eyes")}</span>
        <EyesChoices look={look} onPick={pick} carousel />
      </div>
      <div className="agp-look__row">
        <span className="newag__label">{t("look.onHead")}</span>
        <AccessoryChoices look={look} onPick={pick} carousel />
      </div>
    </div>
  );
}

/** A picker shaped like the cards around it: the option's leading, name and description. */
export const pickerValue = (o: SelectOption) => (
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

/** "Responsável" where it can't be changed: the person and their role, or "Sem responsável". */
export function OwnerValue({ member, meId }: { member: Member | undefined; meId: string }) {
  const { t } = useTranslation();
  return (
    <div className="agp-person">
      {member ? (
        <Avatar kind="person" size="md" name={member.name} imageUrl={member.image} />
      ) : (
        <span className="newag__ib">
          <Icon name="members" size={16} />
        </span>
      )}
      <span className="agp-person__t">
        <b>
          {member
            ? member.userId === meId
              ? t("newAgent.you", { name: member.name })
              : member.name
            : t("newAgent.noOwnerOption")}
        </b>
        {member && <span>{t(`roles.${member.role}`)}</span>}
      </span>
    </div>
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
      options={options}
      renderValue={pickerValue}
    />
  );
}

/** A plan brain (Claude Code, Codex, Cursor, OpenCode) on a computer, chosen while creating an agent. */
export interface PlanChoice {
  kind: "claude_code" | "codex" | "cursor" | "opencode";
  machineId: string;
  /** One account there (an agent's proposal suggests a free one, ADR 0081); none: the computer's own sign-in. */
  accountId?: string;
  label?: string;
  /** Its model there (`auto` or one of `brainModelChoices`); none: Automático. */
  model?: string;
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
  // A quick amount lights its button and leaves "Outro valor" empty; the field only holds an amount of its own
  // (while typing it keeps what was typed, even "10").
  const [typing, setTyping] = useState(false);
  const quick = amount !== null && (QUICK_BUDGETS as readonly number[]).includes(amount);
  const custom = value.trim() !== "" && (typing || !quick);
  const pick = (next: string) => {
    setTyping(false);
    onChange(next);
  };
  return (
    <div className="newag__money">
      {defaultBudget !== undefined && (
        <button type="button" className="newag__tog" aria-pressed={!value.trim()} onClick={() => pick("")}>
          {t("agent.budgetDefaultChoice", { amount: usd(t, locale, defaultBudget) })}
        </button>
      )}
      {QUICK_BUDGETS.map((v) => (
        <button
          key={v}
          type="button"
          className="newag__tog"
          aria-pressed={amount === v && !custom}
          onClick={() => pick(String(v))}
        >
          {usd(t, locale, v)}
        </button>
      ))}
      <Field
        label={<span className="ac-visually-hidden">{t("newAgent.budget")}</span>}
        id={id}
        error={error}
        className={custom ? "newag__money-field newag__money-field--on" : "newag__money-field"}
      >
        <AffixInput
          prefix="US$"
          inputMode="decimal"
          value={custom ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={t("agent.budgetOther")}
        />
      </Field>
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
