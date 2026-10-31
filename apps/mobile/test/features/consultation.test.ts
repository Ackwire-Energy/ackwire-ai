import { expect, test } from "bun:test";
import {
  composerRequestFor,
  currentComposerRequest,
  requestComposerText,
  takeComposerRequest,
} from "../../src/features/chat/composer-request";
import { consultationHref } from "../../src/features/links/logic";

test("two agents' conversation opens on its screen, with the conversation that asked", () => {
  expect(consultationHref("q1", "c1")).toBe("/consultation/q1?channel=c1");
});

test("'Falar com o Theo' hands '@theo ' to that conversation's composer, once", () => {
  requestComposerText("c1", "@theo ");
  const asked = currentComposerRequest();
  expect(asked).toMatchObject({ channelId: "c1", text: "@theo " });
  // Only that conversation's screen takes it.
  expect(composerRequestFor(asked, "c1")).toBe(asked);
  expect(composerRequestFor(asked, "c2")).toBeNull();
  // A request that isn't the one waiting leaves it; the one waiting, taken, is gone.
  takeComposerRequest((asked?.at ?? 0) - 1);
  expect(currentComposerRequest()).toBe(asked);
  takeComposerRequest(asked?.at ?? 0);
  expect(currentComposerRequest()).toBeNull();
});
