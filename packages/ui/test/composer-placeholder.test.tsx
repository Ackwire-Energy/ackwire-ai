import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render, screen } from "@testing-library/react";
import { Composer } from "../src/components/Composer";

afterEach(cleanup);

const box = () => (
  <Composer
    value=""
    onChange={() => {}}
    onSend={() => {}}
    label="Mensagem para #geral"
    placeholder="Mensagem para #geral · use @ para chamar um agente"
    sendLabel="Enviar"
  />
);

describe("the composer's placeholder", () => {
  test("whole on a computer; on a phone, what goes there without the tip after its ·", () => {
    const narrow = (phone: boolean) =>
      spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: phone && query === "(max-width: 640px)",
            media: query,
            addEventListener() {},
            removeEventListener() {},
          }) as unknown as MediaQueryList,
      );
    const wide = narrow(false);
    render(box());
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe(
      "Mensagem para #geral · use @ para chamar um agente",
    );
    cleanup();
    wide.mockRestore();
    const phone = narrow(true);
    render(box());
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Mensagem para #geral");
    phone.mockRestore();
  });
});
