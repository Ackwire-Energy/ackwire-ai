import { type BrainPickOption, brainPickText, pickGroups } from "@agenteschat/client/lib/brain-picker";
import { matchesWords } from "@agenteschat/ui/search";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedHeader, GroupedList, GroupedRow, ProviderLogo, SearchField, Sheet, Text } from "@/ui";
import { SheetTitle } from "../shared/PromptForm";

/**
 * The web's "Quem pensa" on the new agent's step, as a sheet: every model and plan the agent's page offers
 * (`brainPickOptions`), searched by name, maker, plan or "free", in their groups, the chosen one checked.
 */
export function BrainPickSheet({
  open,
  onClose,
  options,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  options: BrainPickOption[];
  value: string | undefined;
  onPick: (option: BrainPickOption) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const groups = useMemo(
    () => pickGroups(q.trim() ? options.filter((o) => matchesWords(brainPickText(o), q)) : options),
    [options, q],
  );
  return (
    <Sheet open={open} onClose={onClose}>
      <SheetTitle title={t("brain.title")} />
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder={t("newAgent.brainPick.searchPlaceholder")}
        accessibilityLabel={t("models.search")}
        autoCorrect={false}
      />
      {groups.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {t("models.noResults")}
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
                  {...(o.mark ? { leading: <ProviderLogo id={o.mark} size="sm" /> } : { icon: "sparkle" as const })}
                  checked={o.value === value}
                  disabled={o.disabled}
                  onPress={() => {
                    onPick(o);
                    onClose();
                  }}
                />
              ))}
            </GroupedList>
          </Fragment>
        ))
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 8 },
  gap: { height: 10 },
});
