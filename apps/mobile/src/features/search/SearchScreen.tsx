import {
  dedupe,
  formatSearch,
  parseSearch,
  rememberSearch,
  type SearchChip,
  type SearchSort,
  searchChipKey,
  searchSortFor,
  searchWords,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, StyleSheet, type TextInputInstance, View } from "react-native";
import { STORED } from "@/lib/storage";
import { LargeTitleScreen, SearchField, Text } from "@/ui";
import { ConversationRowView } from "../chats/ConversationRowView";
import { kindOf } from "../chats/logic";
import { useOrgId } from "../shared/hooks";
import { useConversations } from "../shared/queries";
import { useRecentSearches, useSearchDirectory } from "./hooks";
import { typeSearch } from "./logic";
import { FilterChips, FilteredResults, OperatorPicker, SearchOptions } from "./SearchFilters";
import { SearchResults } from "./SearchResults";

/** Conversations the empty search lists ("Recentes"). */
const RECENT = 8;
/** After the tab's switch, so the keyboard rises once the screen shows. */
const FOCUS_DELAY_MS = 350;

/**
 * Buscar, its own tab (on iOS 26 the round button apart in the tab bar,
 * like Music's): the large title, the search field on top (focused when the tab opens, "Cancelar" while
 * searching), the recent conversations while empty, and the results in place (grouped, with chips) once
 * there are words. Typed operators (`from:`, `in:`, `has:`…, ADR 0123) become chips under the field, with a picker
 * while one is typed; with chips it finds messages only, by channel, with a sort. Recent searches are kept per
 * workspace on this phone.
 */
export function SearchScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const list = useConversations();
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<SearchChip[]>([]);
  // Null until picked: by relevance with words, newest first without (as on the web).
  const [sort, setSort] = useState<SearchSort | null>(null);
  const field = useRef<TextInputInstance>(null);
  const orgId = useOrgId();
  const directory = useSearchDirectory();
  const searchingWords = useMemo(() => searchWords(t), [t]);
  const text = parseSearch(q, directory, searchingWords).text;
  const words = q.trim().length > 0 || chips.length > 0;

  // Recent searches: this phone's, per workspace.
  const [recent, saveRecent] = useRecentSearches(STORED.searchRecent, orgId);
  const remember = () => {
    const s = formatSearch(chips, text);
    if (s) saveRecent(rememberSearch(recent, s));
  };
  const pickRecent = (s: string) => {
    const parsed = parseSearch(s, directory, searchingWords);
    setChips(parsed.chips);
    setQ(parsed.text);
    saveRecent(rememberSearch(recent, s));
  };
  const change = (value: string) => {
    const next = typeSearch(value, chips, directory, searchingWords);
    setChips(next.chips);
    setQ(next.q);
  };

  // Selecting the tab puts the cursor in the (empty) field, like the system's search tab; Cancelar doesn't.
  const typed = useRef(q);
  typed.current = q;
  useEffect(() => {
    if (!focused || typed.current) return;
    const timer = setTimeout(() => field.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [focused]);

  const cancel = () => {
    setQ("");
    setChips([]);
    field.current?.blur();
    Keyboard.dismiss();
  };

  // Android's back clears the words first (like Cancelar), not the app.
  useEffect(() => {
    if (!words || !focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel();
      return true;
    });
    return () => sub.remove();
  });

  return (
    <LargeTitleScreen title={t("mobile.find.title")}>
      <View style={styles.search}>
        <SearchField
          ref={field}
          value={q}
          onChangeText={change}
          onSubmitEditing={remember}
          placeholder={t("mobile.find.placeholder")}
          onCancel={cancel}
          autoCapitalize="none"
        />
      </View>
      {chips.length > 0 ? (
        <FilterChips
          chips={chips}
          onRemove={(c) => setChips(chips.filter((x) => searchChipKey(x) !== searchChipKey(c)))}
        />
      ) : null}
      {typingOperator(q, searchingWords) ? (
        <OperatorPicker
          text={q}
          directory={directory}
          words={searchingWords}
          onPick={(chip, rest) => {
            setChips(dedupe([...chips, chip]));
            setQ(rest);
          }}
        />
      ) : chips.length > 0 ? (
        <FilteredResults
          chips={chips}
          text={text}
          directory={directory}
          sort={searchSortFor(sort, text)}
          onSort={setSort}
          onClear={() => setChips([])}
          onOpen={remember}
        />
      ) : words ? (
        <SearchResults q={text} />
      ) : (
        <View>
          <SearchOptions
            words={searchingWords}
            onInsert={(word) => {
              setQ(word);
              field.current?.focus();
            }}
            recent={recent}
            onPickRecent={pickRecent}
            onClearRecent={() => saveRecent([])}
          />
          {list.rows.length > 0 ? (
            <View>
              <Text variant="label" accessibilityRole="header" style={styles.head}>
                {t("mobile.find.recent")}
              </Text>
              {list.rows
                .filter((r) => kindOf(r) !== "threads")
                .slice(0, RECENT)
                .map((r, i) => (
                  <ConversationRowView key={r.key} row={r} divider={i > 0} />
                ))}
            </View>
          ) : null}
        </View>
      )}
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 10 },
  head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
});
