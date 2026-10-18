import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, StyleSheet, type TextInputInstance, View } from "react-native";
import { LargeTitleScreen, SearchField, Text } from "@/ui";
import { ConversationRowView } from "../chats/ConversationRowView";
import { kindOf } from "../chats/logic";
import { useConversations } from "../shared/queries";
import { SearchResults } from "./SearchResults";

/** Conversations the empty search lists ("Recentes"). */
const RECENT = 8;
/** After the tab's switch, so the keyboard rises once the screen shows. */
const FOCUS_DELAY_MS = 350;

/**
 * Buscar, its own tab (MobileRefinos.html `sTab`, `sOpen`; on iOS 26 the round button apart in the tab bar,
 * like Music's): the large title, the search field on top (focused when the tab opens, "Cancelar" while
 * searching), the recent conversations while empty, and the results in place (grouped, with chips) once
 * there are words.
 */
export function SearchScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const list = useConversations();
  const [q, setQ] = useState("");
  const field = useRef<TextInputInstance>(null);
  const words = q.trim().length > 0;

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

  const recent = list.rows.filter((r) => kindOf(r) !== "threads").slice(0, RECENT);
  return (
    <LargeTitleScreen title={t("mobile.find.title")}>
      <View style={styles.search}>
        <SearchField
          ref={field}
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.find.placeholder")}
          onCancel={cancel}
          autoCapitalize="none"
        />
      </View>
      {words ? (
        <SearchResults q={q} />
      ) : recent.length > 0 ? (
        <View>
          <Text variant="label" accessibilityRole="header" style={styles.head}>
            {t("mobile.find.recent")}
          </Text>
          {recent.map((r, i) => (
            <ConversationRowView key={r.key} row={r} divider={i > 0} />
          ))}
        </View>
      ) : null}
    </LargeTitleScreen>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 10 },
  head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
});
