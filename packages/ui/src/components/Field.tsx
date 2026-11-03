import {
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "../cx";
import { InfoHint } from "./InfoHint";
import { SearchField } from "./Toolbar";

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Wiring for a control inside a `Field`: id, `aria-describedby`, `aria-invalid`. */
export function useFieldControl(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: unknown }) {
  const field = useContext(FieldContext);
  const describedBy = [props["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true" || field?.invalid === true;
  return { id: props.id ?? field?.id, "aria-describedby": describedBy, "aria-invalid": invalid || undefined };
}

export interface FieldProps {
  label: ReactNode;
  /** Defaults to a generated id. The control picks it up automatically. */
  id?: string;
  help?: ReactNode;
  /** Shown instead of `help`; marks the control `aria-invalid`. */
  error?: ReactNode;
  /** Something next to the label (e.g. "Esqueci minha senha"). */
  labelAside?: ReactNode;
  /** An ⓘ right after the label with what the field is for (plain sentences); it also describes the control. */
  hint?: { name: string; text: ReactNode };
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}

/** A form field: always-visible label, optional ⓘ hint, help or error, wired to its control. */
export function Field({ label, id, help, error, labelAside, hint, className, style, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `f${generated.replace(/:/g, "")}`;
  const helpId = `${controlId}-help`;
  const hintId = `${controlId}-hint`;
  const showError = error !== undefined && error !== null && error !== false;
  const showHelp = !showError && help !== undefined && help !== null && help !== false;
  const describedBy = [showError || showHelp ? helpId : "", hint ? hintId : ""].filter(Boolean).join(" ");
  const labelOnly = (
    <label className="ac-field__label" htmlFor={controlId}>
      {label}
    </label>
  );
  // The ⓘ sits outside the <label>: the label stays the control's name, and pressing the ⓘ never reaches the control.
  const labelEl = hint ? (
    <span className="ac-hintline">
      {labelOnly}
      <InfoHint name={hint.name} id={hintId}>
        {hint.text}
      </InfoHint>
    </span>
  ) : (
    labelOnly
  );
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy: describedBy || undefined, invalid: showError }}>
      <div className={cx("ac-field", className)} style={style}>
        {labelAside ? (
          <div className="ac-field__label-row">
            {labelEl}
            {labelAside}
          </div>
        ) : (
          labelEl
        )}
        {children}
        {showHelp && (
          <span id={helpId} className="ac-field__help">
            {help}
          </span>
        )}
        {showError && (
          <span id={helpId} className="ac-field__error">
            {error}
          </span>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, ...rest }, ref) {
  const wiring = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
  return <input ref={ref} className={cx("ac-input", className)} {...rest} {...wiring} />;
});

/** A border-box height that fits the text: `scrollHeight` leaves the border out. */
function fitText(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * A section's heading inside a picker's list ("Papéis"), with the line under it that says what picking one means: a
 * real gap between the two, as a field's label and its help have.
 */
export function PickerHeading({ label, description }: { label: ReactNode; description?: ReactNode }) {
  return (
    <div className="ac-picker-head">
      <span className="ac-field__label">{label}</span>
      {description && <span className="ac-picker-head__desc">{description}</span>}
    </div>
  );
}

/**
 * A textarea as tall as its text (up to its CSS max-height), measured again when the text changes and when a new
 * width rewraps it (a window resize, a sidebar opening). `on` false leaves its height alone.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, on = true) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the text changes
  useLayoutEffect(() => {
    if (on && ref.current) fitText(ref.current);
  }, [ref, value, on]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitText(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, on]);
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** As tall as its text (a controlled `value`), growing and shrinking with it. */
  autoGrow?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 4, autoGrow = false, ...rest },
  ref,
) {
  const wiring = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
  const box = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => box.current as HTMLTextAreaElement, []);
  useAutoGrow(box, String(rest.value ?? ""), autoGrow);
  return <textarea ref={box} rows={rows} className={cx("ac-input", className)} {...rest} {...wiring} />;
});

/** Input with a fixed prefix, e.g. "agentes.chat/" + address. */
export const AffixInput = forwardRef<HTMLInputElement, InputProps & { prefix: ReactNode }>(function AffixInput(
  { prefix, className, invalid, ...rest },
  ref,
) {
  const wiring = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
  return (
    <div className={cx("ac-input-affix", className)}>
      <span className="ac-input-affix__prefix">{prefix}</span>
      <input ref={ref} {...rest} {...wiring} />
    </div>
  );
});

/**
 * Search box above a list: the shared SearchField (a field of the ruler; `size="sm"` in
 * dialogs and panels). Kept under this name for existing screens.
 */
export const SearchInput = SearchField;
