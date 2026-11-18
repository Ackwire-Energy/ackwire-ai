import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("the dock grows at the conversation's end (who is working, the reply bar): the conversation keeps ending above it", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain("followingEnd.current = atEnd && !readHold;");
  // One place does it: two frames on, only a list the grown dock left short (still scrolling down) goes on to the end.
  expect(chat).toMatch(
    /if \(followsEnd\(\) && state && state\.distanceFromEnd > END_SLACK\)\s*void listRef\.current\?\.scrollToEnd\(\{ animated: true \}\);/,
  );
  // Following the end is the list's own follow too: a message just sent is still scrolling down (the screen's `atEnd`
  // is false then) when the agent's working line grows the dock, and it must not stay under it.
  expect(chat).toContain("return !!state && (state.isFollowingEnd || state.isAtEnd);");
  expect(chat).toContain("if (grew && followsEnd())");
  // The second scroll that ran over the list's own shift is gone.
  expect(chat).not.toContain("boxHeightRef");
});

test("the dock's height redraws only what is drawn from it, never the whole conversation", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  // Held outside the screen's state: a field growing a line, the working line coming or going drew the whole screen.
  expect(chat).not.toContain("setComposerHeight");
  expect(chat).toContain("const [dock] = useState(createDockHeight);");
  expect(chat).toMatch(/endInset\.value = height;[\s\S]{0,200}dock\.set\(height\);\s*watchList\(\);/);
  // Read where it is drawn: the keyboard's gesture area, an empty conversation's greeting, the skeleton.
  expect(chat).toContain("<DockGestureArea dock={dock} lift={lift}>");
  expect(chat.match(/<DockRoom dock=\{dock\}>/g)).toHaveLength(2);
  expect(chat).toContain(
    "const useDockHeight = (dock: DockHeight) => useSyncExternalStore(dock.subscribe, dock.get, dock.get);",
  );
});

test("above the conversation's end, the dock's height and the keyboard move nothing", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  // The library's default moved the words being read each time an agent started or finished (the dock's height).
  expect(chat).toContain('keyboardLiftBehavior="whenAtEnd"');
});

test("a pushed screen's large title is the system's on iOS, over a scroll view that is the screen's first child", () => {
  const pushed = src("features/shared/PushedLargeTitle.tsx");
  expect(pushed).toContain('Platform.OS === "ios" ? <SystemLargeTitle {...props} /> : <DrawnLargeTitle {...props} />');
  expect(pushed).toContain('contentInsetAdjustmentBehavior="automatic"');
  const header = src("features/shared/parts.tsx");
  expect(header).toContain("...(IOS ? { headerLargeTitleEnabled: largeTitle } : null),");
  expect(header).toContain("headerLargeTitleShadowVisible: false,");
});

test("the dock settles on the system's word once the keyboard is shown or gone", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain('Keyboard.addListener("keyboardDidHide", () => settle(0))');
  expect(chat).toContain('Keyboard.addListener("keyboardDidShow", (e) => settle(e.endCoordinates.height))');
  // On iOS only: Android's height leaves out the navigation bar the keyboard library counts edge to edge, so a late
  // event sank the box behind the keys (and the library ends every move there itself).
  expect(chat).toMatch(
    /useEffect\(\(\) => \{\s*if \(Platform\.OS !== "ios"\) return;\s*const settle = \(height: number\) => \{/,
  );
});

test("a cover freezes the list only once a keyboard that was up has gone: no keyboard-tall gap over the dock after", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toMatch(
    /const cover = useCallback\(\(\) => \{\s*covered\.current = true;\s*if \(KeyboardController\.isVisible\(\)\) freezeOnHide\.current = true;\s*else freeze\.value = true;/,
  );
  expect(chat).toMatch(
    /KeyboardEvents\.addListener\("keyboardDidHide", \(\) => \{\s*if \(!freezeOnHide\.current\) return;\s*freezeOnHide\.current = false;\s*if \(covered\.current\) freeze\.value = true;/,
  );
  // The cover gone first: nothing left to freeze.
  expect(chat).toMatch(
    /const uncover = useCallback\(\s*\(now = false\) => \{\s*covered\.current = false;\s*freezeOnHide\.current = false;/,
  );
});

test("a long reply lands at its start only once it is measured, against the room the keyboard leaves", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  // The list says a new size from its estimate before it measures the row: an unknown size never counts as tall.
  expect(chat).toContain("if (size === undefined || size <= room.height - BAND_GAP) return;");
  expect(chat).toContain(
    "const keyboard = KeyboardController.isVisible() ? Math.max(0, KeyboardController.state().height - lift) : 0;",
  );
  expect(chat).toContain("return { state, top, height: state.scrollLength - top - dock.get() - keyboard };");
});

test('going to a message takes its place in the list\'s own rows, where the "Novas" line is one', () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).not.toContain("rowsRef.current.findIndex(");
  expect(chat).toContain("const index = key === undefined ? undefined : listRef.current?.getState().indexByKey(key);");
  // Pins, "Ver resultado" and "Ver" land in the room under the bar.
  expect(chat).toContain('...aimAt(index, 0.4, "start")');
  expect(chat).toContain('...aimAt(index, 0.5, "end")');
});

test('held where the list landed at its end (the "Novas" line, "Ver"), it follows again: no round button over nothing', () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain('...aimAt(index, 0.5, "end") })?.then(releaseAtEnd);');
  expect(chat).toMatch(/goingToLine\.current = false;\s*\/\/[^\n]*\n\s*releaseAtEnd\(\);\s*revealOpened\(\);/);
});

test("no suggestion pills over the conversation", () => {
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).not.toContain("composerSuggestions");
  expect(chat).not.toMatch(/\bsuggestions=/);
});

test('an agent\'s "pensando…" comes with my message, in the same frame: the dock grows once, with it', () => {
  const chat = src("features/chat/ChatScreen.tsx");
  const optimistic = chat.slice(
    chat.indexOf("onOptimistic: (local) => {"),
    chat.indexOf("onSent: (message, local) => {"),
  );
  // On the copy on its way, not from the server's answer (the dock grew while the list was still going down to it).
  expect(optimistic).toContain(
    "if (dmAgentId && !atWork) live.expect(local.threadId ?? local.id, [dmAgentId], local.id);",
  );
  // An agent at work already takes the message into that work: no second "pensando…".
  expect(optimistic).toContain("AT_WORK.has(r.status)");
  // Moved to its server id with it; dropped when it went into work going on, or was never sent.
  expect(chat).toContain("live.retarget(local.id, message.id);");
  expect(chat).toContain("live.forget(message.id, false);");
  expect(chat).toMatch(/live\.forget\(`local-\$\{clientId\}`, true\);/);
  // The socket's copy can come before the answer: the move happens in that same update, so nothing drops out between.
  const live = src("features/chat/live.ts");
  expect(live).toContain("const base = sent?.clientId ? retargeted(state, localIdOf(sent.clientId), sent.id) : state;");
  expect(live).toContain('case "retarget":');
});

test("a read that tells the receipts nothing new doesn't draw the conversation again", () => {
  const live = src("features/chat/live.ts");
  expect(live).toContain(
    "if (seedReceipts(stateRef.current.receipts, messages) === stateRef.current.receipts) return;",
  );
});

test('a picker\'s "preparing" thumbnail comes only once the picker covers the screen', () => {
  const chat = src("features/chat/ChatScreen.tsx");
  // Set as the picker opened, it showed in the dock (growing it, moving the conversation) before the picker came up.
  expect(chat).toContain("const covered = setTimeout(() => setPreparing(true), PICKER_COVERS_MS);");
  expect(chat.match(/await whilePicking\(/g)).toHaveLength(2);
  expect(chat).not.toMatch(/setPreparing\(true\);\s*const res = await/);
});
