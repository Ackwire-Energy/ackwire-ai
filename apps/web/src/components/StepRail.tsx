import { Icon } from "@agenteschat/ui";

export interface RailStep {
  id: string;
  name: string;
  done: boolean;
  disabled: boolean;
  /** Shows the "opcional" tag. */
  optional?: boolean;
}

/**
 * The numbered steps of a stepped flow on the rail (onboarding, "Criar
 * agente"): the current one raised, done ones with a check, the ones not
 * reached yet disabled. On narrow screens the rail turns into a step bar.
 */
export function StepRail({
  label,
  steps,
  current,
  onGo,
  doneLabel,
  optionalLabel,
}: {
  label: string;
  steps: RailStep[];
  current: number;
  onGo: (index: number) => void;
  /** Screen readers hear it after a done step's name. */
  doneLabel: string;
  optionalLabel?: string;
}) {
  return (
    <nav aria-label={label}>
      <ol className="onb__steps">
        {steps.map((s, i) => {
          const done = s.done && i !== current;
          return (
            <li key={s.id} data-done={done || undefined}>
              <button
                type="button"
                className="onb__step"
                aria-current={i === current ? "step" : undefined}
                disabled={s.disabled}
                onClick={() => onGo(i)}
              >
                <span className="onb__n" aria-hidden="true">
                  {done ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <span className="onb__step-name">
                  {s.name}
                  {done && <span className="ac-visually-hidden"> {doneLabel}</span>}
                </span>
                {s.optional && optionalLabel && <span className="onb__opt">{optionalLabel}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
