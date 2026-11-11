import { accountAbout, accountTitle, type ExistingAi } from "@agenteschat/client/lib/ai-accounts";
import { namesText } from "@agenteschat/client/lib/format";
import { type PlanChoice, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { keyLine } from "@agenteschat/client/lib/providers";
import { Icon, ProviderLogo, planState, Radio, RadioGroup } from "@agenteschat/ui";
import { type CSSProperties, Fragment, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { planWord } from "@/lib/plan-usage";

/** A row's id in the list: an account's or a key's. */
export const haveId = (r: ExistingAi) => (r.kind === "key" ? `key:${r.key.id}` : `account:${r.choice.login.id}`);

/** How much of its plan an account has used, and whether it is near or at its limit; null where nothing says. */
const room = (r: ExistingAi) => (r.kind === "account" && r.choice.login.usage ? planState(r.choice.login.usage) : null);

/** A row the person can't pick: someone else's they may not use, or a plan that can't run on that computer now. */
const offOf = (r: ExistingAi, dims: (choice: PlanChoice) => boolean) =>
  r.kind === "account" && (r.act === "locked" || dims(planOfAccount(r.choice.login)));

const limited = (r: ExistingAi) => room(r)?.state === "limited";

/**
 * A plan that is used in one click first, the one with most room on top (one that doesn't say counts as half used);
 * then one that asks for a sign-in, the workspace's keys, a plan at its limit, and last what can't be picked.
 */
function sorted(rows: readonly ExistingAi[], dims: (choice: PlanChoice) => boolean) {
  const rank = (r: ExistingAi) => {
    const s = room(r);
    const signIn = r.kind === "account" && r.act !== "use" && r.act !== "move";
    return (
      (offOf(r, dims) ? 8000 : 0) +
      (s?.state === "limited" ? 4000 : 0) +
      (r.kind === "key" ? 2000 : 0) +
      (signIn ? 1000 : 0) +
      (s?.used ?? 50)
    );
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/** The row a list opens on: the usable one with most room, never one at its limit while another has room. */
export function bestHave(rows: readonly ExistingAi[], dims: (choice: PlanChoice) => boolean): string | undefined {
  const first = sorted(rows, dims).find((r) => !offOf(r, dims));
  return first ? haveId(first) : undefined;
}

/** Up to this many rows the list shows them all, in groups; past it, this many with most room and a way to the rest. */
export const HAVE_SHOWN = 3;

const firstName = (name: string | null | undefined) => name?.split(" ")[0] ?? "";

/**
 * What the person already has for the agent, to pick one and confirm it at the dialog's foot (ADR 0160, addendum). A
 * row puts the radio, the mark, the name and how full the plan is on one line, then who else thinks with it and its
 * state in words. Few accounts are grouped (the person's, the workspace's keys, each other owner's); many show the
 * three with most room, each saying whose it is, and `all` lists every one under a search, by owner, those at their
 * limit last.
 */
export function ConnectHave({
  rows,
  agentName,
  value,
  onChange,
  dims,
  all = false,
  onAll,
  disabled = false,
}: {
  rows: readonly ExistingAi[];
  agentName: string;
  value: string | undefined;
  onChange: (id: string) => void;
  /** A plan that can't sign in on that computer now: its rows are off. */
  dims: (choice: PlanChoice) => boolean;
  /** Every account, with the search. */
  all?: boolean;
  /** Past `HAVE_SHOWN` rows: opens the list of all of them. */
  onAll?: () => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dom = useId();
  const [query, setQuery] = useState("");
  const list = sorted(rows, dims);
  const many = rows.length > HAVE_SHOWN;
  const ownerOf = (r: ExistingAi) =>
    r.kind === "key"
      ? t("connectAi.chat.keys")
      : r.choice.login.mine
        ? t("connectAi.chat.yours")
        : t("agentPage.work.brain.accountOf", { name: firstName(r.choice.login.ownerName) });
  const titleOf = (r: ExistingAi) => (r.kind === "key" ? r.key.label : accountTitle(r.choice.login));

  const row = (r: ExistingAi, whose: boolean) => {
    const id = haveId(r);
    const off = disabled || offOf(r, dims);
    const state = room(r);
    const a = r.kind === "account" ? r.choice.login : undefined;
    const others = a ? [...new Set(a.usedBy)].filter((n) => n !== agentName) : [];
    // In a list of mixed owners a row says whose it is; in its owner's group, who else thinks with it.
    const about = whose
      ? ownerOf(r)
      : r.kind === "key"
        ? keyLine(t, r.key)
        : !r.choice.login.mine
          ? undefined
          : others.length > 0 && r.choice.login.shared === true
            ? t("agentPage.work.brain.accountAlso", { agents: namesText(t, others, 2) })
            : accountAbout(t, r.choice, agentName);
    const word = a ? planWord(t, i18n.language, a.usage) : null;
    const used = state ? Math.min(100, Math.round(state.used)) : 0;
    return (
      <label
        key={id}
        htmlFor={`${dom}-${id}`}
        className="arrival-have__row"
        data-state={id === value ? "checked" : "unchecked"}
        data-disabled={off ? "" : undefined}
      >
        <Radio value={id} id={`${dom}-${id}`} disabled={off} />
        {r.kind === "key" ? (
          <Icon name="key" size={16} className="arrival-have__mark" />
        ) : (
          <ProviderLogo id={r.choice.login.provider ?? r.choice.login.kind} size="xs" />
        )}
        <span className="arrival-have__text">
          <span className="arrival-have__title">{titleOf(r)}</span>
          {about && <span className="arrival-have__line">{about}</span>}
          {word && (
            <span className="arrival-have__line" data-plan={state?.state}>
              {word}
            </span>
          )}
        </span>
        {state && (
          <span className="arrival-have__room" data-plan={state.state} aria-hidden="true">
            <span className="arrival-have__meter">
              <i style={{ "--used": `${used}%` } as CSSProperties} />
            </span>
            <span className="arrival-have__pct">
              {new Intl.NumberFormat(i18n.language, { style: "percent" }).format(used / 100)}
            </span>
          </span>
        )}
      </label>
    );
  };

  /** By owner: the person's, the workspace's keys, each other owner's; in `all`, those at their limit last. */
  const groups = () => {
    const out: { key: string; label: string; rows: ExistingAi[] }[] = [];
    const into = (key: string, label: string, r: ExistingAi) => {
      const group = out.find((g) => g.key === key);
      if (group) group.rows.push(r);
      else out.push({ key, label, rows: [r] });
    };
    const open = all ? list.filter((r) => !limited(r)) : list;
    for (const r of open) if (r.kind === "account" && r.choice.login.mine) into("mine", t("connectAi.chat.mine"), r);
    for (const r of open) if (r.kind === "key") into("keys", t("connectAi.chat.keys"), r);
    for (const r of open) {
      if (r.kind === "account" && !r.choice.login.mine) into(`owner:${r.choice.login.ownerId}`, ownerOf(r), r);
    }
    if (all) for (const r of list.filter(limited)) into("limit", t("connectAi.chat.atLimit"), r);
    return out;
  };
  const grouped = (
    <>
      {groups().map((g) => (
        <Fragment key={g.key}>
          <p className="arrival-opts__label">{g.label}</p>
          {g.rows.map((r) => row(r, g.key === "limit"))}
        </Fragment>
      ))}
    </>
  );

  const found = query.trim()
    ? list.filter((r) => `${titleOf(r)} ${ownerOf(r)}`.toLowerCase().includes(query.trim().toLowerCase()))
    : null;
  return (
    <RadioGroup
      className="arrival-have"
      aria-label={t("connectAi.have.title")}
      value={value ?? ""}
      onValueChange={onChange}
    >
      {all ? (
        <>
          <label className="arrival-have__search">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              placeholder={t("connectAi.chat.search")}
              aria-label={t("connectAi.chat.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="arrival-have__scroll">
            {found ? (
              found.length > 0 ? (
                found.map((r) => row(r, true))
              ) : (
                <p className="arrival-have__none">{t("connectAi.chat.none")}</p>
              )
            ) : (
              grouped
            )}
          </div>
        </>
      ) : many ? (
        <>
          <p className="arrival-opts__label">{t("connectAi.chat.best")}</p>
          {list.slice(0, HAVE_SHOWN).map((r) => row(r, true))}
          {/* The one picked in the full list stays in sight when it isn't among the three. */}
          {list
            .slice(HAVE_SHOWN)
            .filter((r) => haveId(r) === value)
            .map((r) => row(r, true))}
          <button type="button" className="arrival-have__link" onClick={onAll}>
            <Icon name="layers" size={16} />
            <span>{t("connectAi.chat.seeAll", { count: rows.length })}</span>
            <Icon name="chevronRight" size={16} />
          </button>
        </>
      ) : (
        grouped
      )}
    </RadioGroup>
  );
}
