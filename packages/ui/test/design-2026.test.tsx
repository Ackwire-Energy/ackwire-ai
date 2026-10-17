import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  Avatar,
  Button,
  CommandPalette,
  Composer,
  CountChip,
  FilterToggle,
  filterPalette,
  Kbd,
  type PaletteItem,
  Reaction,
  SearchField,
  Segmented,
  Toolbar,
  WorkSummary,
} from "../src";

afterEach(() => cleanup());
const body = () => within(document.body);

describe("buttons and kbd", () => {
  test("kbd hints after the label; the accessible name stays the label", () => {
    render(
      <Button variant="primary" kbd={["⌘", "↵"]}>
        Enviar para o Theo
      </Button>,
    );
    const b = body().getByRole("button", { name: /Enviar para o Theo/ });
    expect(b.querySelectorAll("kbd.ac-kbd")).toHaveLength(2);
    expect(b.querySelector(".ac-btn__kbd")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("Kbd is a <kbd>", () => {
    const { container } = render(<Kbd>esc</Kbd>);
    expect(container.querySelector("kbd.ac-kbd")?.textContent).toBe("esc");
  });

  test("disabled stays disabled; an enabled button takes focus (the ring is CSS :focus-visible)", () => {
    render(
      <>
        <Button disabled>Salvar</Button>
        <Button>Cancelar</Button>
      </>,
    );
    expect(body().getByRole("button", { name: "Salvar" }).hasAttribute("disabled")).toBe(true);
    const b = body().getByRole("button", { name: "Cancelar" });
    b.focus();
    expect(document.activeElement).toBe(b);
  });
});

describe("segmented control", () => {
  function Harness() {
    const [v, setV] = useState<"idle" | "thinking" | "writing">("idle");
    return (
      <Segmented
        label="Estado do agente"
        value={v}
        onValueChange={setV}
        options={[
          { value: "idle", label: "Disponível" },
          { value: "thinking", label: "Pensando" },
          { value: "writing", label: "Escrevendo" },
        ]}
      />
    );
  }
  test("radio semantics; click and arrows move the choice", async () => {
    render(<Harness />);
    const group = body().getByRole("radiogroup", { name: "Estado do agente" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await act(async () => fireEvent.click(radios[1] as HTMLElement));
    expect(within(group).getByRole("radio", { name: "Pensando" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.keyDown(group, { key: "ArrowRight" }));
    expect(within(group).getByRole("radio", { name: "Escrevendo" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.keyDown(group, { key: "ArrowRight" }));
    expect(within(group).getByRole("radio", { name: "Disponível" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("the count chip", () => {
  test("Segmented counts use the shared CountChip (sm in a small control); the CSS centers it on its box", async () => {
    render(
      <>
        <Segmented
          label="Abas"
          value="a"
          onValueChange={() => {}}
          options={[
            { value: "a", label: "Todas" },
            { value: "m", label: "Missões", count: 1 },
          ]}
        />
        <Segmented
          size="sm"
          label="Pequeno"
          value="a"
          onValueChange={() => {}}
          options={[{ value: "a", label: "Um", count: 12 }]}
        />
        <CountChip strong>6</CountChip>
      </>,
    );
    const tab = body().getByRole("radio", { name: /^Missões/ });
    expect(tab.querySelector(".ac-countchip")?.textContent).toBe("1");
    const small = body().getByRole("radio", { name: /^Um/ });
    expect(small.querySelector(".ac-countchip")?.className).toBe("ac-countchip ac-countchip--sm");
    expect(body().getByText("6").className).toBe("ac-countchip ac-countchip--strong");
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = /\.ac-countchip \{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const decl of [
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "line-height: 1",
      "align-self: center",
      "height: var(--count-h)",
      "min-width: var(--count-h)",
    ]) {
      expect(rule).toContain(decl);
    }
    // Digits come from the shared count rule: Doto, tabular.
    const counts = /\.ac-num,[^{]*\.ac-countchip,[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(counts).toContain("font-family: var(--font-dot");
    expect(counts).toContain("font-variant-numeric: tabular-nums");
  });
});

describe("list toolbars", () => {
  function Harness() {
    const [q, setQ] = useState("");
    const [mine, setMine] = useState(false);
    return (
      <Toolbar
        label="Filtros"
        search={
          <SearchField
            aria-label="Buscar issues"
            placeholder="Buscar"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")}
            clearLabel="Limpar busca"
            shortcut={<Kbd>/</Kbd>}
          />
        }
        actions={<Button size="sm">Novo</Button>}
      >
        <FilterToggle pressed={mine} onPressedChange={setMine} icon="person" count={2}>
          Minhas
        </FilterToggle>
      </Toolbar>
    );
  }

  test("search (a pill searchbox with × and a key hint), filters as a named group, actions at the end", async () => {
    const { container } = render(<Harness />);
    const box = body().getByRole("searchbox", { name: "Buscar issues" }) as HTMLInputElement;
    expect(box.closest(".ac-searchfield")).toBeTruthy();
    expect(container.querySelector(".ac-toolbar__search .ac-searchfield")).toBeTruthy();
    expect(container.querySelector(".ac-searchfield__hint")?.textContent).toBe("/");
    expect(body().queryByRole("button", { name: "Limpar busca" })).toBeNull();
    await act(async () => fireEvent.change(box, { target: { value: "login" } }));
    expect(container.querySelector(".ac-searchfield__hint")).toBeNull();
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Limpar busca" })));
    expect(box.value).toBe("");
    const group = body().getByRole("group", { name: "Filtros" });
    const mine = within(group).getByRole("button", { name: "Minhas" });
    expect(mine.getAttribute("aria-pressed")).toBe("false");
    expect(mine.querySelector(".ac-countchip")?.textContent).toBe("2");
    await act(async () => fireEvent.click(mine));
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".ac-toolbar__actions")?.textContent).toBe("Novo");
  });

  test("one shape: pills on the field surface; pressed and set chips are filled neutral; phones scroll the filters", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) =>
      new RegExp(`(^|\\n)${selector.replace(/[.[\]()"=]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";
    expect(rule(".ac-searchfield")).toContain("border-radius: var(--radius-full)");
    expect(rule(".ac-searchfield")).toContain("background: var(--field-bg)");
    expect(rule(".ac-filtertoggle")).toContain("background: var(--field-bg)");
    expect(rule('.ac-filtertoggle[aria-pressed="true"]')).toContain("background: var(--ink)");
    expect(rule(".ac-filter--active")).toContain("background: var(--ink)");
    expect(css).toMatch(/\.ac-toolbar__search \{\s*flex: 1 1 100%;/);
  });
});

describe("the living agent symbol", () => {
  test("states: idle (blinks), thinking and writing (halo); people keep initials", () => {
    const { container } = render(
      <>
        <Avatar kind="agent" name="Theo" />
        <Avatar kind="agent" name="Theo" state="thinking" />
        <Avatar kind="agent" name="Theo" state="writing" />
        <Avatar name="Walter" presence />
      </>,
    );
    const [idle, thinking, writing, person] = Array.from(container.querySelectorAll(".ac-avatar"));
    expect(idle?.getAttribute("data-state")).toBe("idle");
    expect(idle?.className).not.toContain("ac-avatar--running");
    expect(thinking?.className).toContain("ac-avatar--thinking");
    expect(thinking?.className).toContain("ac-avatar--running");
    expect(writing?.className).toContain("ac-avatar--writing");
    expect(writing?.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(person?.textContent).toBe("W");
    expect(person?.querySelector(".ac-avatar__presence")).not.toBeNull();
    expect(person?.hasAttribute("data-state")).toBe(false);
  });
});

describe("command palette", () => {
  const picked: string[] = [];
  const items: PaletteItem[] = [
    { key: "c", group: "Ir para", label: "#general", sub: "canal", onSelect: () => picked.push("general") },
    { key: "a", group: "Ir para", label: "Theo", sub: "agente · PM", onSelect: () => picked.push("theo") },
    { key: "s1", group: "Ir para", label: "Conectores", sub: "configurações", onSelect: () => picked.push("conn") },
    { key: "s2", group: "Ir para", label: "Skills", sub: "configurações", onSelect: () => picked.push("skills") },
  ];
  test("filter: every word, accents and case ignored", () => {
    expect(filterPalette(items, "config").map((i) => i.key)).toEqual(["s1", "s2"]);
    expect(filterPalette(items, "CONFIGURACOES skills").map((i) => i.key)).toEqual(["s2"]);
    expect(filterPalette(items, "").length).toBe(4);
  });
  test("type, arrows, Enter goes; the query-built item comes last; nothing → empty text", async () => {
    picked.length = 0;
    let open = true;
    const { rerender } = render(
      <CommandPalette
        open={open}
        onOpenChange={(o) => {
          open = o;
        }}
        items={items}
        extra={(q) =>
          q.trim()
            ? [
                {
                  key: "ask",
                  group: "Pedir a um agente",
                  label: `Theo, ${q}`,
                  sub: "nova conversa",
                  onSelect: () => picked.push(`ask:${q}`),
                },
              ]
            : []
        }
        label="Ir para, ou pedir a um agente"
        placeholder="Ir para, ou pedir a um agente…"
        listLabel="Resultados"
        emptyText={(q) => `Nada com “${q}”.`}
      />,
    );
    const input = body().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
    await act(async () => fireEvent.change(input, { target: { value: "config" } }));
    const list = body().getByRole("listbox", { name: "Resultados" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining("Conectores"),
      expect.stringContaining("Skills"),
      expect.stringContaining("Theo, config"),
    ]);
    await act(async () => fireEvent.keyDown(input, { key: "ArrowDown" }));
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(picked).toEqual(["skills"]);
    expect(open).toBe(false);
    rerender(
      <CommandPalette
        open
        onOpenChange={() => {}}
        items={items}
        label="Ir para, ou pedir a um agente"
        placeholder="…"
        listLabel="Resultados"
        emptyText={(q) => `Nada com “${q}”.`}
      />,
    );
    await act(async () =>
      fireEvent.change(body().getByRole("combobox", { name: "Ir para, ou pedir a um agente" }), {
        target: { value: "zzz" },
      }),
    );
    expect(document.body.textContent).toContain("Nada com “zzz”.");
  });
});

describe("composer", () => {
  function Harness({ onSend, onCommand }: { onSend: (t: string) => void; onCommand: (k: string) => void }) {
    const [v, setV] = useState("");
    return (
      <Composer
        value={v}
        onChange={setV}
        onSend={(t) => {
          onSend(t);
          setV("");
        }}
        label="Mensagem para Theo"
        sendLabel="Enviar"
        sendText="Enviar"
        pills={<span className="ac-composer__agent">Theo</span>}
        commands={{
          listLabel: "Comandos",
          list: [
            {
              key: "report",
              label: "/relatório",
              description: "Theo monta um documento",
              onPick: () => onCommand("report"),
            },
            { key: "pc", label: "/pc", description: "rodar no PC do Theo", onPick: () => onCommand("pc") },
          ],
        }}
      />
    );
  }
  test("'/' opens the command menu; filter; Enter picks; Esc closes", async () => {
    const commands: string[] = [];
    render(<Harness onSend={() => {}} onCommand={(k) => commands.push(k)} />);
    const box = body().getByRole("combobox", { name: "Mensagem para Theo" });
    await act(async () => fireEvent.change(box, { target: { value: "/", selectionStart: 1 } }));
    const menu = body().getByRole("listbox", { name: "Comandos" });
    expect(within(menu).getAllByRole("option")).toHaveLength(2);
    await act(async () => fireEvent.change(box, { target: { value: "/p", selectionStart: 2 } }));
    expect(within(body().getByRole("listbox", { name: "Comandos" })).getAllByRole("option")).toHaveLength(1);
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(commands).toEqual(["pc"]);
    expect((box as HTMLTextAreaElement).value).toBe("/pc ");
    expect(body().queryByRole("listbox", { name: "Comandos" })).toBeNull();
  });

  test("send morphs: a dim square without text, 'Enviar ↵' with text; same accessible name", async () => {
    render(<Harness onSend={() => {}} onCommand={() => {}} />);
    const send = body().getByRole("button", { name: "Enviar" });
    expect(send.hasAttribute("data-ready")).toBe(false);
    expect(send.textContent).toBe("");
    await act(async () =>
      fireEvent.change(body().getByRole("combobox", { name: "Mensagem para Theo" }), { target: { value: "oi" } }),
    );
    const ready = body().getByRole("button", { name: "Enviar" });
    expect(ready.hasAttribute("data-ready")).toBe(true);
    expect(ready.textContent).toBe("Enviar↵");
    expect(ready.hasAttribute("disabled")).toBe(false);
  });
});

describe("work summary and reactions", () => {
  test("collapsed by default; expanding shows the steps with checks; failures say so", async () => {
    const toggles: boolean[] = [];
    render(
      <WorkSummary
        summary={
          <>
            <strong>4 passos</strong> · himetrica, Drive · 12 s
          </>
        }
        onToggle={(o) => toggles.push(o)}
        steps={[
          { key: "1", label: "Consultou himetrica", time: "3 s" },
          { key: "2", label: "Criou o documento no Drive", time: "3 s", failed: true },
        ]}
      />,
    );
    const head = body().getByRole("button", { name: /4 passos/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(body().queryByRole("listitem")).toBeNull();
    await act(async () => fireEvent.click(head));
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const steps = body().getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Consultou himetrica3 s", "Criou o documento no Drive3 s"]);
    expect(steps[1]?.querySelector(".ac-tick--failed")).not.toBeNull();
    expect(toggles).toEqual([true]);
  });

  test("a reaction is a toggle button with its count", () => {
    render(<Reaction pressed count={2} label="Útil, 2" />);
    const r = body().getByRole("button", { name: "Útil, 2" });
    expect(r.getAttribute("aria-pressed")).toBe("true");
    expect(r.textContent).toBe("2");
  });
});

describe("reduced motion (2026-10 block)", () => {
  test("halo, mark and tab animations only run without reduced motion (the agent's own motion is the engine's)", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const block = css.slice(css.indexOf("Design system 2026-10 (docs/design"));
    const outside = block.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\banimation:\s*ac-/);
    expect(block).toContain("ac-halo");
    expect(block).toContain("backdrop-filter");
    // Glass has a solid fallback first.
    expect(block.indexOf("var(--glass-solid)")).toBeLessThan(block.indexOf("backdrop-filter: blur"));
  });
});
