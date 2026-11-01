import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { showReturnNotices } from "@/lib/return-notices";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const CONNECTORS = `/org/${ORG_ID}/settings/connectors`;

/** The toasts the app shows on opening at `path`, and the address it is left at. */
function open(path: string, lng: "pt-BR" | "en" = "pt-BR") {
  window.history.replaceState(null, "", path);
  const shown: [string, string | undefined][] = [];
  showReturnNotices(createI18n(lng).t, (text, tone) => void shown.push([text, tone]));
  return { shown, left: window.location.pathname + window.location.search + window.location.hash };
}

describe("back from a provider's sign-in that didn't connect", () => {
  test("each reason in the person's words, in both languages; only its own parameter leaves the address", () => {
    const said = {
      "pt-BR": {
        cancelled: "A conexão foi cancelada. Nada mudou.",
        expired: "Esse link expirou. Comece de novo em Conectores.",
        used: "Esse link já foi usado. Se não conectou, comece de novo em Conectores.",
        other_account: "Termine com a conta que começou. Este navegador entrou com outra.",
        not_allowed: "Você não tem permissão para isso. Peça a um admin do workspace.",
        not_visible: "Sua conta do GitHub não vê essa instalação. Instale com uma conta que tenha acesso a ela.",
        failed: "Não deu para conectar. Tente de novo em instantes.",
        "Some words from the server": "Não deu para conectar. Tente de novo em instantes.",
      },
      en: {
        cancelled: "The connection was cancelled. Nothing changed.",
        expired: "That link expired. Start again from Connectors.",
        used: "That link was already used. If it didn't connect, start again from Connectors.",
        other_account: "Finish with the account that started it. This browser is signed in with another one.",
        not_allowed: "You don't have permission for this. Ask a workspace admin.",
        not_visible:
          "Your GitHub account can't see that installation. Install it with an account that has access to it.",
        failed: "Couldn't connect. Try again in a moment.",
        "Some words from the server": "Couldn't connect. Try again in a moment.",
      },
    } as const;
    for (const lng of ["pt-BR", "en"] as const) {
      for (const [code, text] of Object.entries(said[lng])) {
        for (const param of ["connector_error", "github_app_error"]) {
          const query = new URLSearchParams({ tab: "apps", [param]: code });
          expect(open(`${CONNECTORS}?${query}#mail`, lng)).toEqual({
            shown: [[text, "error"]],
            left: `${CONNECTORS}?tab=apps#mail`,
          });
        }
      }
    }
  });

  test("a connector account's own refusal comes back as its full code, apart from the browser's other account", () => {
    expect(open(`${CONNECTORS}?connector_error=connector.other_account`, "en").shown).toEqual([
      ["You signed in to another account. To connect it, use Add another account.", "error"],
    ]);
    expect(open(`${CONNECTORS}?connector_error=connector.unfinished`, "en").shown).toEqual([
      ["The sign-in at Composio didn't finish. Try again.", "error"],
    ]);
    // A code from elsewhere stays the generic text.
    expect(open(`${CONNECTORS}?connector_error=connector.nothing_like_it`, "en").shown).toEqual([
      ["Couldn't connect. Try again in a moment.", "error"],
    ]);
  });

  test("the GitHub account's owner was asked to install: news, not an error", () => {
    expect(open(`${CONNECTORS}?github_app_error=requested`)).toEqual({
      shown: [
        ["Pedimos ao dono da conta do GitHub para instalar o app. Ele aparece aqui quando a pessoa instalar.", "info"],
      ],
      left: CONNECTORS,
    });
    expect(open("/?github_app_error=requested", "en").shown).toEqual([
      ["We asked the GitHub account's owner to install the app. It shows up here once they do.", "info"],
    ]);
  });

  test("Gmail's or Outlook's that found no workspace says so on the start; Conectores reads its own", () => {
    expect(open("/?mail=failed&account=a1&x=1")).toEqual({
      shown: [["Não deu para conectar o email. Tente de novo.", "error"]],
      left: "/?x=1",
    });
    expect(open(`${CONNECTORS}?mail=failed&account=a1`)).toEqual({
      shown: [],
      left: `${CONNECTORS}?mail=failed&account=a1`,
    });
    expect(open(`${CONNECTORS}?connected=github`)).toEqual({ shown: [], left: `${CONNECTORS}?connected=github` });
  });

  test("in the desktop app's window: the provider's refusal, or finishing here refused, said the same way", async () => {
    await renderApp(`/desktop/connector?org=${ORG_ID}&error=access_denied`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(document.querySelector(".ac-toast")?.textContent).toContain("A conexão foi cancelada. Nada mudou.");
    cleanup();
    const api = createFakeApi(seedState());
    api.connectors.completeOAuth = async () => {
      throw new ApiError(409, "oauth.link_expired", "This authorization link is invalid or expired");
    };
    const { router } = await renderApp(`/desktop/connector?org=${ORG_ID}&state=s1&code=c1`, { api });
    await settle(8);
    expect(document.querySelector(".ac-toast")?.textContent).toContain(
      "Esse link expirou. Comece de novo em Conectores.",
    );
    expect(document.body.textContent).not.toContain("invalid or expired");
    expect(router.state.location.pathname).toBe(CONNECTORS);
  });
});
