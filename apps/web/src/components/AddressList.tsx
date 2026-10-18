import { splitAddresses } from "@agenteschat/client/lib/mail";
import { Button, Field, Input, Token, TokenList } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A list of email addresses or `@domains` (email rules, routine filters):
 * type one or several (commas or spaces), Enter or "Adicionar"; each shows
 * as a chip with a remove button.
 */
export function AddressList({
  id,
  label,
  help,
  values,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help?: string;
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const add = () => {
    const { valid, invalid: wrong } = splitAddresses(text);
    if (wrong.length > 0 || valid.length === 0) {
      setInvalid(text.trim().length > 0);
      return;
    }
    onChange([...new Set([...values, ...valid])]);
    setText("");
  };
  return (
    <div className="mail-list">
      <Field label={label} id={id} help={help} error={invalid ? t("mail.list.invalid") : undefined}>
        <div className="mail-list__add">
          <Input
            value={text}
            disabled={disabled}
            inputMode="email"
            autoComplete="off"
            placeholder={t("mail.list.placeholder")}
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button
            type="button"
            disabled={disabled || !text.trim()}
            aria-label={t("mail.list.addTo", { name: label })}
            onClick={add}
          >
            {t("mail.list.add")}
          </Button>
        </div>
      </Field>
      {values.length > 0 && (
        <TokenList label={label}>
          {values.map((v) => (
            <li key={v}>
              <Token
                removeLabel={t("common.removeName", { name: v })}
                onRemove={() => !disabled && onChange(values.filter((x) => x !== v))}
              >
                {v}
              </Token>
            </li>
          ))}
        </TokenList>
      )}
    </div>
  );
}
