import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { LegalPage } from "@/pages/LegalPage";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(cleanup);

describe("links read as ours, never the browser's blue", () => {
  test("the addresses inside the Terms and the Privacy Policy are house links", async () => {
    for (const kind of ["terms", "privacy"] as const) {
      await renderPage(<LegalPage kind={kind} />, { api: createFakeApi(seedState({ me: null })) });
      await settle();
      const links = [...document.querySelectorAll(".legal__doc a")];
      expect(links.length).toBeGreaterThan(0);
      for (const a of links) expect(a.className).toBe("ac-link");
      cleanup();
    }
  });
});
