import {
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useContext,
  useId,
} from "react";
import { cx } from "../cx";
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
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}

/** A form field: always-visible label, optional help or error, wired to its control. */
export function Field({ label, id, help, error, labelAside, className, style, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `f${generated.replace(/:/g, "")}`;
  const helpId = `${controlId}-help`;
  const showError = error !== undefined && error !== null && error !== false;
  const showHelp = !showError && help !== undefined && help !== null && help !== false;
  const labelEl = (
    <label className="ac-field__label" htmlFor={controlId}>
      {label}
    </label>
  );
  return (
    <FieldContext.Provider
      value={{ id: controlId, describedBy: showError || showHelp ? helpId : undefined, invalid: showError }}
    >
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

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 4, ...rest },
  ref,
) {
  const wiring = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
  return <textarea ref={ref} rows={rows} className={cx("ac-input", className)} {...rest} {...wiring} />;
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
