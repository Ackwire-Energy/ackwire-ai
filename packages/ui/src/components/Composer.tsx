import { type KeyboardEvent, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { cx } from "../cx";
import { Button } from "./Button";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text on Enter (Shift+Enter adds a line) or the send button. */
  onSend: (text: string) => void;
  /** Accessible name of the text box, e.g. "Mensagem para #eng". */
  label: string;
  placeholder?: string;
  sendLabel: string;
  attachLabel?: string;
  onAttach?: () => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Lets the parent focus the box or insert text (e.g. "Chamar um agente"). */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}

/** The chat message box: attach on the left, send (primary, icon only) on the right, focus on the whole box. */
export function Composer({
  value,
  onChange,
  onSend,
  label,
  placeholder,
  sendLabel,
  attachLabel,
  onAttach,
  disabled,
  id,
  className,
  textareaRef,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(textareaRef, () => ref.current as HTMLTextAreaElement, []);

  // Grow with the text, up to the CSS max-height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    // Keep typing: focus stays in the box (also after clicking the send button).
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={cx("ac-composer", className)}>
      {attachLabel && (
        <Button
          variant="ghost"
          iconOnly
          icon="attach"
          aria-label={attachLabel}
          onClick={onAttach}
          disabled={!onAttach}
        />
      )}
      <textarea
        ref={ref}
        id={id}
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button
        variant="primary"
        iconOnly
        icon="send"
        aria-label={sendLabel}
        onClick={send}
        disabled={disabled || !value.trim()}
      />
    </div>
  );
}
