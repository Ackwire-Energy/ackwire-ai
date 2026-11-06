import { type BrainPickOption, brainPickText, pickGroups } from "@agenteschat/client/lib/brain-picker";
import { matchesWords } from "@agenteschat/ui/search";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedHeader, GroupedList, GroupedRow, ProviderLogo, SearchField, Text } from "@/ui";

export type PickRow = Pick<BrainPickOption, "value" | "label" | "keywords"> &
  Partial<Pick<BrainPickOption, "group" | "mark" | "description" | "hint" | "disabled">> & {
    /** Its logo dims: it can't be used here now, though it still opens. */
    off?: boolean;
  };

/** One choice from a list, the phone's picker: a search over the rows by their logos, in their groups, the chosen one checked. */
export function PickList<O extends PickRow>({
  options,
  value,
  onPick,
  placeholder,
  searchLabel,
  noResults,
}: {
  options: readonly O[];
  value: string | undefined;
  onPick: (option: O) => void;
  placeholder: string;
  searchLabel: string;
  noResults: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const groups = useMemo(
    () => pickGroups(q.trim() ? options.filter((o) => matchesWords(brainPickText(o), q)) : options),
    [options, q],
  );
  return (
    <>
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder={placeholder}
        accessibilityLabel={searchLabel}
        autoCorrect={false}
      />
      {groups.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {noResults}
        </Text>
      ) : (
        groups.map((g, i) => (
          <Fragment key={g.group ?? `~${i}`}>
            {g.group ? <GroupedHeader>{g.group}</GroupedHeader> : <View style={styles.gap} />}
            <GroupedList>
              {g.options.map((o) => (
                <GroupedRow
                  key={o.value}
                  label={o.label}
                  {...(o.description ? { sub: o.description, subLines: 2 } : {})}
                  {...(o.hint ? { hint: { name: t("common.about", { label: o.label }), text: o.hint } } : {})}
                  {...(o.mark
                    ? { leading: <ProviderLogo id={o.mark} size="sm" off={o.off ?? false} /> }
                    : { icon: "sparkle" as const })}
                  checked={o.value === value}
                  disabled={o.disabled ?? false}
                  onPress={() => onPick(o)}
                />
              ))}
            </GroupedList>
          </Fragment>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 8 },
  gap: { height: 10 },
});
