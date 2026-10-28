import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  ApprovalCard,
  Avatar,
  AvatarStack,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Chip,
  Composer,
  Icon,
  iconNames,
  initialsOf,
  ListRow,
  Logo,
  Menu,
  MenuItem,
  Message,
  MessageText,
  Meter,
  RunMark,
  Steps,
  Textarea,
} from "../src";

const body = () => within(document.body);

describe("Button", () => {
  test("variants map to the design classes; default type is button", () => {
    render(
      <>
        <Button variant="primary">Aprovar merge</Button>
        <Button variant="agent">Pedir à Ada</Button>
        <Button variant="ghost" size="sm" iconOnly icon="close" aria-label="Fechar" />
      </>,
    );
    const primary = body().getByRole("button", { name: "Aprovar merge" });
    expect(primary.className).toBe("ac-btn ac-btn--primary");
    expect(primary.getAttribute("type")).toBe("button");
    const agent = body().getByRole("button", { name: "Pedir à Ada" });
    expect(agent.className).toContain("ac-btn--agent");
    // The agent button carries the agent icon.
    expect(agent.querySelector("svg.ac-icon")).not.toBeNull();
    const close = body().getByRole("button", { name: "Fechar" });
    expect(close.className).toBe("ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon");
    expect(close.textContent).toBe("");
  });

  test("asChild renders a link with button styles", () => {
    render(
      <Button asChild variant="primary">
        <a href="/x">Entrar</a>
      </Button>,
    );
    const link = body().getByRole("link", { name: "Entrar" });
    expect(link.className).toContain("ac-btn--primary");
  });
});

describe("Avatar", () => {
  test("people and agents share the framed tile; running ring only for agents", () => {
    const { container } = render(
      <>
        <Avatar name="Marina" />
        <Avatar kind="agent" name="Atlas" initials="At" running />
        <Avatar name="João" running />
      </>,
    );
    const [person, agent, notAgent] = Array.from(container.querySelectorAll(".ac-avatar"));
    expect(person?.className).toBe("ac-avatar ac-avatar--framed");
    expect(agent?.className).toContain("ac-avatar--framed");
    expect(person?.textContent).toBe("M");
    expect(agent?.className).toContain("ac-avatar--agent");
    expect(agent?.className).toContain("ac-avatar--running");
    // The agent symbol is drawn by the engine (no initials); running = thinking.
    expect(agent?.textContent).toBe("");
    expect(agent?.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(agent?.getAttribute("data-state")).toBe("thinking");
    expect(notAgent?.className).not.toContain("ac-avatar--running");
    expect(person?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the 18px receipt and the 112px hero stand unframed unless asked", () => {
    const { container } = render(
      <>
        <Avatar kind="agent" name="Ada" size="xs" />
        <Avatar kind="agent" name="Ada" size="xl" />
        <Avatar kind="agent" name="Ada" size="xl" framed />
        <Avatar name="Marina" size="sm" framed={false} />
      </>,
    );
    const [xs, xl, xlFramed, person] = Array.from(container.querySelectorAll(".ac-avatar"));
    expect(xs?.className).not.toContain("ac-avatar--framed");
    expect(xl?.className).not.toContain("ac-avatar--framed");
    expect(xlFramed?.className).toContain("ac-avatar--framed");
    expect(person?.className).not.toContain("ac-avatar--framed");
  });

  test("labelled avatars expose the name", () => {
    render(<Avatar kind="agent" name="Ada" labelled />);
    expect(body().getByRole("img", { name: "Ada" })).toBeTruthy();
  });

  test("initials", () => {
    expect(initialsOf("Ada")).toBe("A");
    expect(initialsOf("Marina Souza Lima")).toBe("ML");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("Chip", () => {
  test("a state renders its icon with the word", () => {
    const { container } = render(
      <Chip icon="waiting" tone="waiting">
        Aguardando você
      </Chip>,
    );
    const chip = container.querySelector(".ac-chip");
    expect(chip?.className).toBe("ac-chip ac-chip--waiting");
    expect(chip?.querySelector("svg.ac-icon")).not.toBeNull();
    expect(chip?.textContent).toBe("Aguardando você");
  });

  test("a value goes without an icon, same shape", () => {
    const { container } = render(<Chip>Issue: ACME-177</Chip>);
    const chip = container.querySelector(".ac-chip");
    expect(chip?.querySelector("svg")).toBeNull();
    expect(chip?.textContent).toBe("Issue: ACME-177");
  });
});

describe("ApprovalCard", () => {
  test("waiting card: neutral card, attention chip, title, detail and actions", () => {
    const { container } = render(
      <ApprovalCard
        status="waiting"
        aria-label="Pedido de aprovação"
        who={
          <>
            <b>Ada</b> pede aprovação
          </>
        }
        statusLabel="Aguardando você"
        title="Fazer merge do PR #42 em main"
        detail="github.merge · agentes-chat/app · PR 42"
        actions={<Button variant="primary">Aprovar merge</Button>}
      />,
    );
    const card = body().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.className).toBe("ac-approval");
    expect(container.querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando você");
    expect(card.textContent).toContain("Fazer merge do PR #42 em main");
    expect(within(card).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
  });

  test("the detail sits in a well in both themes, never in the page's tone (the light card's own white)", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-approval")).toContain("background: var(--surface-raised);");
    expect(rule(".ac-approval__detail")).toContain("background: var(--surface-sunken);");
  });

  test("decided card shrinks and uses a done/neutral chip", () => {
    const { container } = render(
      <>
        <ApprovalCard
          compact
          status="approved"
          who="Ada · merge do PR #42 em main"
          statusLabel="Aprovado por você · agora"
        />
        <ApprovalCard
          compact
          status="refused"
          who="Ada · merge do PR #42 em main"
          statusLabel="Recusado por você · agora"
        />
      </>,
    );
    const cards = container.querySelectorAll(".ac-approval--done");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector(".ac-chip")?.className).toBe("ac-chip ac-chip--done");
    expect(cards[1]?.querySelector(".ac-chip")?.className).toBe("ac-chip");
    expect(container.querySelector(".ac-approval__actions")).toBeNull();
  });
});

describe("Card", () => {
  test("head: icon key, h2 with id, quiet line and action; foot: help text in the well", () => {
    const { container } = render(
      <Card aria-labelledby="c-title">
        <CardHeader
          id="c-title"
          icon="document"
          title="O que o Theo faz"
          subtitle="Instruções"
          action={<Button>Editar</Button>}
        />
        <CardFooter>O contexto entra antes</CardFooter>
      </Card>,
    );
    const card = container.querySelector("section.ac-card");
    expect(card?.getAttribute("aria-labelledby")).toBe("c-title");
    expect(card?.querySelector("h2#c-title")?.textContent).toBe("O que o Theo faz");
    expect(card?.querySelector(".ac-card__key svg")).not.toBeNull();
    expect(card?.querySelector(".ac-card__sub")?.textContent).toBe("Instruções");
    expect(card?.querySelector(".ac-card__action button")?.textContent).toBe("Editar");
    expect(card?.querySelector(".ac-card__foot")?.textContent).toBe("O contexto entra antes");
  });

  test("no icon, subtitle or action: only the title", () => {
    const { container } = render(<CardHeader title="Só título" />);
    expect(container.querySelector(".ac-card__key")).toBeNull();
    expect(container.querySelector(".ac-card__sub")).toBeNull();
    expect(container.querySelector(".ac-card__action")).toBeNull();
  });

  test("the key and the foot's icon lead their first line; without an icon nothing is moved", async () => {
    const { container } = render(
      <>
        <CardHeader
          icon="wallet"
          title="Limite de gastos por agente"
          subtitle="Por mês"
          action={<Button>US$</Button>}
        />
        <CardHeader title="Só título" />
        <CardFooter>Ninguém gasta além disso</CardFooter>
        <CardFooter icon={null}>Sem ícone</CardFooter>
      </>,
    );
    const [withKey, plain] = [...container.querySelectorAll(".ac-card__head")];
    expect(withKey?.className).toBe("ac-card__head ac-iconline");
    expect(withKey?.firstElementChild?.className).toBe("ac-card__key");
    expect(plain?.className).toBe("ac-card__head");
    const [foot, bare] = [...container.querySelectorAll(".ac-card__foot")];
    expect(foot?.className).toBe("ac-card__foot ac-iconline");
    expect(foot?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(bare?.className).toBe("ac-card__foot");
    // The key follows the title's 20px line, not the title and its quiet line; the action stays in the middle.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-card__head")).toContain("line-height: 20px");
    expect(rule(".ac-card__head")).toContain("align-items: flex-start");
    expect(rule(".ac-card__head:not(:has(.ac-card__sub))")).toContain("align-items: center");
    expect(rule(".ac-card__action")).toContain("align-self: center");
    for (const row of [".ac-card__foot", ".ac-setnote", ".ac-alert"]) {
      expect(rule(row)).not.toContain("display:");
      expect(rule(row)).not.toContain("align-items:");
    }
    // A note is small text on its own 13/18 line, as a panel's other small lines: never the 22px line of the dialog
    // or the page it sits in, which spreads a note's lines apart.
    expect(rule(".ac-setnote")).toContain("font-size: 13px");
    expect(rule(".ac-setnote")).toContain("line-height: 18px");
  });
});

test("an avatar's initials sit in the middle of its tile at any size: it brings its own line height", async () => {
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".ac-avatar")).toContain("place-items: center;");
  expect(rule(".ac-avatar")).toContain("line-height: 1;");
});

describe("single-line controls", () => {
  test("buttons, inputs and selects centre their text in the box: the line is the text's own", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    for (const selector of [
      ".ac-btn",
      ".ac-input",
      ".ac-input-affix",
      ".ac-select__trigger",
      ".ac-palette__q input",
      ".ac-seg__item",
      ".ac-filtertoggle",
      ".ac-composer__pill,\n.ac-composer__agent",
      ".ac-recur__day",
      ".ac-react",
    ]) {
      const body = rule(selector);
      expect(body).toContain("line-height: normal");
      // After `font: inherit`, which would reset it.
      if (body.includes("font: inherit")) expect(body.indexOf("line-height")).toBeGreaterThan(body.indexOf("font:"));
    }
    // Text that wraps keeps its line.
    expect(rule("textarea.ac-input")).toContain("line-height: 22px");
  });
});

describe("links", () => {
  test("any link reads as ours, never the browser's blue; .ac-link is underlined in the house hairline", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    // Zero specificity: a class that styles its link still wins.
    expect(rule(":where(a)")).toContain("color: inherit");
    expect(rule(":where(a)")).toContain("text-decoration-color: var(--line2)");
    expect(rule(":where(a)")).toContain("text-underline-offset: 3px");
    expect(rule(":where(a:hover)")).toContain("text-decoration-color: currentColor");
    expect(rule(".ac-link")).toContain("text-decoration: underline");
    expect(rule(".ac-link")).toContain("text-decoration-color: var(--line2)");
    expect(rule(".ac-link")).toContain("text-underline-offset: 3px");
    expect(rule(".ac-link:hover")).toContain("text-decoration-color: currentColor");
    expect(rule(".ac-link--muted:hover")).toContain("color: var(--ink)");
    // A link that is a button has no box of its own and the sentence's whole type (the browser's button font would
    // drop the page's size adjustment and figures). It comes first, so `.ac-link`'s weight and size classes win.
    const button = rule(":where(button).ac-link");
    expect(button).toContain("border: 0");
    expect(button).toContain("background: none");
    expect(button).toContain("font: inherit");
    expect(css.indexOf("\n:where(button).ac-link {")).toBeGreaterThan(-1);
    expect(css.indexOf("\n:where(button).ac-link {")).toBeLessThan(css.indexOf("\n.ac-link {"));
    expect(css.indexOf("\n:where(button).ac-link {")).toBeLessThan(css.indexOf("\n.ac-link--muted {"));
  });
});

describe("Composer", () => {
  function Harness({ onSend }: { onSend: (t: string) => void }) {
    const [v, setV] = useState("");
    return (
      <Composer
        value={v}
        onChange={setV}
        onSend={(t) => {
          onSend(t);
          setV("");
        }}
        label="Mensagem para #eng"
        sendLabel="Enviar"
        attachLabel="Anexar arquivo"
      />
    );
  }

  test("Enter sends the trimmed text, Shift+Enter does not, empty text never sends", async () => {
    const sent: string[] = [];
    render(<Harness onSend={(t) => sent.push(t)} />);
    const box = body().getByRole("textbox", { name: "Mensagem para #eng" });
    const send = body().getByRole("button", { name: "Enviar" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent).toEqual([]);
    await act(async () => fireEvent.change(box, { target: { value: "  @Ada olha o login  " } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter", shiftKey: true }));
    expect(sent).toEqual([]);
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent).toEqual(["@Ada olha o login"]);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("the send button sends", async () => {
    const sent: string[] = [];
    render(<Harness onSend={(t) => sent.push(t)} />);
    await act(async () => fireEvent.change(body().getByRole("textbox"), { target: { value: "oi" } }));
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Enviar" })));
    expect(sent).toEqual(["oi"]);
  });
});

describe("boxes as tall as their text", () => {
  /** happy-dom lays nothing out: a box's text is 22 px a line under 20 px of padding, inside a 2 px border. */
  const measured = async (run: () => Promise<void>) => {
    const proto = HTMLTextAreaElement.prototype;
    const lines = (el: HTMLTextAreaElement) => el.value.split("\n").length;
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return 20 + 22 * lines(this);
      },
    });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 102 });
    try {
      await run();
    } finally {
      for (const key of ["scrollHeight", "clientHeight", "offsetHeight"]) Reflect.deleteProperty(proto, key);
    }
  };
  const type = (box: HTMLElement, value: string) => act(async () => fireEvent.change(box, { target: { value } }));

  test("Textarea autoGrow grows with its text, border included, and shrinks back; without it, its height is left alone", () =>
    measured(async () => {
      function Box({ grow }: { grow: boolean }) {
        const [value, setValue] = useState("uma linha");
        return (
          <Textarea
            autoGrow={grow}
            aria-label={grow ? "Cresce" : "Fixa"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        );
      }
      render(
        <>
          <Box grow />
          <Box grow={false} />
        </>,
      );
      const box = body().getByRole("textbox", { name: "Cresce" }) as HTMLTextAreaElement;
      expect(box.style.height).toBe("44px");
      await type(box, "um\ndois\ntrês");
      expect(box.style.height).toBe("88px");
      await type(box, "um");
      expect(box.style.height).toBe("44px");
      expect((body().getByRole("textbox", { name: "Fixa" }) as HTMLTextAreaElement).style.height).toBe("");
    }));

  test("the composer grows the same way", () =>
    measured(async () => {
      function Chat() {
        const [value, setValue] = useState("");
        return (
          <Composer
            value={value}
            onChange={setValue}
            onSend={() => {}}
            label="Mensagem"
            sendLabel="Enviar"
            attachLabel="Anexar"
          />
        );
      }
      render(<Chat />);
      const box = body().getByRole("textbox", { name: "Mensagem" });
      expect(box.style.height).toBe("44px");
      await type(box, "um\ndois");
      expect(box.style.height).toBe("66px");
    }));
});

describe("Message", () => {
  test("streaming adds the cursor class and aria-busy; grouped hides the header visually", () => {
    const { container } = render(
      <>
        <Message
          avatar={<Avatar kind="agent" name="Atlas" />}
          author="Atlas"
          time="agora"
          meta="escrevendo…"
          agent
          streaming
        >
          <MessageText>Os 401 no Sentry caíram de 312 para</MessageText>
        </Message>
        <Message author="Atlas" time="agora" grouped>
          <MessageText>continua</MessageText>
        </Message>
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("article"));
    expect(first?.className).toBe("ac-msg ac-msg--agent ac-msg--streaming");
    expect(first?.getAttribute("aria-busy")).toBe("true");
    expect(first?.querySelector(".ac-msg__meta")?.textContent).toBe("escrevendo…");
    expect(second?.querySelector(".ac-avatar")).toBeNull();
    expect(second?.querySelector(".ac-visually-hidden")?.textContent).toContain("Atlas");
  });

  test("machine details live in a tooltip on the time; person-facing states show with an icon", () => {
    const { container } = render(
      <Message
        author="Ada"
        time="21:10"
        meta="sonnet 5.5 · 1.240 tokens · US$ 0,004"
        status={{ icon: "waiting", label: "enviando…" }}
        entering
        agent
      >
        <MessageText>Achei a causa.</MessageText>
      </Message>,
    );
    const article = container.querySelector("article");
    expect(article?.className).toContain("ac-msg--enter");
    const time = article?.querySelector(".ac-msg__time--details") as HTMLElement;
    expect(time.tabIndex).toBe(0);
    const tip = within(container).getByRole("tooltip");
    expect(time.getAttribute("aria-describedby")).toBe(tip.id);
    expect(time.contains(tip)).toBe(true);
    expect(tip.textContent).toBe("sonnet 5.5 · 1.240 tokens · US$ 0,004");
    const status = article?.querySelector(".ac-msg__status");
    expect(status?.textContent).toBe("enviando…");
    expect(status?.querySelector("svg")).not.toBeNull();
  });

  test("first and grouped messages share one text edge: a fixed avatar column or an equal gutter", async () => {
    const { container } = render(
      <>
        <Message avatar={<Avatar kind="agent" name="Jorge" />} author="Jorge" time="10:02" agent>
          <MessageText>Primeiro parágrafo.</MessageText>
          <MessageText>Segundo parágrafo.</MessageText>
          <div className="card">cartão</div>
        </Message>
        <Message author="Jorge" time="10:03" grouped>
          <MessageText>continua</MessageText>
        </Message>
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("article"));
    // DOM order: avatar column (or gutter) first, then the text column with header, text and cards.
    expect(Array.from(first?.children ?? []).map((c) => c.className)).toEqual(["ac-msg__avatar", "ac-msg__body"]);
    expect(first?.querySelector(".ac-msg__avatar .ac-avatar")).not.toBeNull();
    const body1 = first?.querySelector(".ac-msg__body");
    expect(Array.from(body1?.children ?? []).map((c) => c.className)).toEqual([
      "ac-msg__head",
      "ac-msg__text",
      "ac-msg__text",
      "card",
    ]);
    expect(Array.from(second?.children ?? []).map((c) => c.className)).toEqual(["ac-msg__gutter", "ac-msg__body"]);
    // The gutter shows the time on hover; screen readers get it from the hidden header.
    const gutter = second?.querySelector(".ac-msg__gutter");
    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
    expect(gutter?.textContent).toBe("10:03");
    // CSS: top-aligned row, and the avatar column and the gutter have the same fixed width.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-msg")).toContain("align-items: flex-start");
    expect(rule(".ac-msg__avatar,\n.ac-msg__gutter")).toContain("flex: 0 0 32px");
    expect(rule(".ac-msg__avatar")).toContain("align-self: flex-start");
  });
});

describe("Menu", () => {
  test("opens from its trigger with the keyboard and runs the item", async () => {
    let picked = "";
    render(
      <Menu trigger={<Button>Walter</Button>} label="Conta">
        <MenuItem onSelect={() => (picked = "theme")}>Tema escuro</MenuItem>
        <MenuItem onSelect={() => (picked = "out")}>Sair</MenuItem>
      </Menu>,
    );
    const trigger = body().getByRole("button", { name: "Walter" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const menu = body().getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Tema escuro", "Sair"]);
    await act(async () => fireEvent.click(items[1] as HTMLElement));
    expect(picked).toBe("out");
    expect(body().queryByRole("menu")).toBeNull();
  });
});

describe("Logo, Icon, Meter", () => {
  test("logo has an accessible name; the mark uses the agent token classes", () => {
    const { container } = render(
      <>
        <Logo />
        <Logo variant="expanded" />
      </>,
    );
    expect(body().getByRole("img", { name: "agentes" })).toBeTruthy();
    expect(body().getByRole("img", { name: "agentes.chat" }).textContent).toBe("agentes.chat");
    expect(container.querySelector(".ac-logo__body")).not.toBeNull();
  });

  test("every icon renders a stroke-only 20px glyph, decorative unless labelled", () => {
    for (const name of iconNames.filter((n) => n !== "spinner")) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 20 20");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.childElementCount).toBeGreaterThan(0);
      unmount();
    }
    render(<Icon name="search" label="Buscar" />);
    expect(body().getByRole("img", { name: "Buscar" })).toBeTruthy();
  });

  test("the spinner icon is the pixel orbit everywhere (no ring), decorative, 14 or 16 px", () => {
    const { container, unmount } = render(<Icon name="spinner" size={14} className="x" />);
    const orbit = container.querySelector("canvas");
    expect(orbit?.getAttribute("class")).toBe("ac-pixspin ac-icon--orbit x");
    expect(orbit?.getAttribute("aria-hidden")).toBe("true");
    expect((orbit as HTMLElement).style.width).toBe("14px");
    expect(container.querySelector("svg")).toBeNull();
    unmount();
    const big = render(<Icon name="spinner" />);
    expect((big.container.querySelector("canvas") as HTMLElement).style.width).toBe("16px");
    big.unmount();
    const other = render(<Icon name="search" />);
    expect(other.container.querySelector("svg")?.getAttribute("class")).toBe("ac-icon");
    other.unmount();
  });

  test("meter exposes value and max", () => {
    render(<Meter value={12.3} max={40} label="Orçamento usado" />);
    const meter = body().getByRole("meter", { name: "Orçamento usado" });
    expect(meter.getAttribute("aria-valuenow")).toBe("12.3");
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("31%");
  });

  test("steps: the ones before the current are done; the current is under way, not done (on the last one too)", () => {
    const bars = (current: number) => {
      const { container, unmount } = render(<Steps current={current} total={4} label={`Passo ${current} de 4`} />);
      const state = [...container.querySelectorAll(".ac-steps__bar")].map((b) =>
        b.hasAttribute("data-current") ? "now" : b.getAttribute("data-done") === "true" ? "done" : "",
      );
      unmount();
      return state;
    };
    expect(bars(1)).toEqual(["now", "", "", ""]);
    expect(bars(2)).toEqual(["done", "now", "", ""]);
    expect(bars(4)).toEqual(["done", "done", "done", "now"]);
  });
});

describe("Diff", () => {
  test("keeps equal lines, marks removed and added ones", async () => {
    const { diffLines } = await import("../src");
    const lines = diffLines(
      ["Programa em branches.", "Abre PRs pequenos.", "Pede ajuda ao João."],
      ["Programa em branches.", "Abre PRs de até 300 linhas.", "Abre PRs pequenos.", "Pede revisão do João."],
    );
    expect(lines).toEqual([
      { kind: "same", text: "Programa em branches." },
      { kind: "add", text: "Abre PRs de até 300 linhas." },
      { kind: "same", text: "Abre PRs pequenos." },
      { kind: "del", text: "Pede ajuda ao João." },
      { kind: "add", text: "Pede revisão do João." },
    ]);
  });

  test("renders neutral lines with screen-reader labels", async () => {
    const { Diff } = await import("../src");
    const { container } = render(
      <Diff
        aria-label="Mudança"
        addedLabel="Adicionado: "
        removedLabel="Removido: "
        lines={[
          { kind: "del", text: "velho" },
          { kind: "add", text: "novo" },
        ]}
      />,
    );
    const [del, add] = Array.from(container.querySelectorAll(".ac-diff__line"));
    expect(del?.className).toContain("ac-diff__line--del");
    expect(del?.textContent).toBe("−Removido: velho");
    expect(add?.textContent).toBe("+Adicionado: novo");
  });
});

describe("Message aside", () => {
  test("sits on the header line, or after the text for grouped messages", () => {
    const { container } = render(
      <>
        <Message author="João" time="10:42" aside={<span>✓</span>}>
          <MessageText>oi</MessageText>
        </Message>
        <Message author="João" time="10:43" grouped aside={<span>✓✓</span>}>
          <MessageText>de novo</MessageText>
        </Message>
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("article"));
    expect(first?.querySelector(".ac-msg__head .ac-msg__aside")?.textContent).toBe("✓");
    expect(second?.querySelector(".ac-msg__aside--floating")?.textContent).toBe("✓✓");
    // A receipt with words takes a line of its own under the text, which keeps its lines.
    expect(second?.querySelector(".ac-msg__body > :last-child")?.className).toContain("ac-msg__aside--floating");
  });
});

describe("ListRow and RunMark", () => {
  test("a list row is a neutral button: lead, the whole title on hover, meta", () => {
    let clicked = 0;
    const { container } = render(
      <ListRow
        lead={<Icon name="calendar" />}
        title="Revisão do roadmap"
        meta="Hoje · 21:00"
        onClick={() => clicked++}
      />,
    );
    const row = within(container).getByRole("button", { name: /Revisão do roadmap/ });
    expect(row.getAttribute("type")).toBe("button");
    expect(row.className).toBe("ac-row");
    expect(row.querySelector(".ac-row__title")?.getAttribute("title")).toBe("Revisão do roadmap");
    expect(row.querySelector(".ac-row__meta")?.textContent).toBe("Hoje · 21:00");
    fireEvent.click(row);
    expect(clicked).toBe(1);
  });

  test("a run mark is a decorative 8px canvas carrying its status", () => {
    const { container } = render(<RunMark color="sky" status="failed" />);
    const mark = container.querySelector("canvas.ac-run-mark") as HTMLCanvasElement;
    expect(mark.getAttribute("role")).toBeNull();
    expect(mark.dataset.status).toBe("failed");
    expect(mark.style.width).toBe("8px");
  });
});

describe("text and faces that are never cut", () => {
  test("an empty state's text wraps in even lines; initials in a stack keep their whole tile", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-empty__text")).toContain("text-wrap: balance");
    expect(rule('.ac-avatar-stack > .ac-avatar[data-kind="person"]:not(:has(img)) + .ac-avatar')).toContain(
      "margin-left: 0",
    );
    // The tiles that rule tells apart: initials have no image, a photo does.
    render(
      <AvatarStack>
        <Avatar name="Marina Alves" size="sm" />
        <Avatar name="Theo" size="sm" kind="agent" />
      </AvatarStack>,
    );
    const [initials, agent] = Array.from(document.querySelectorAll(".ac-avatar-stack > .ac-avatar"));
    expect(initials?.getAttribute("data-kind")).toBe("person");
    expect(initials?.querySelector("img")).toBeNull();
    expect(initials?.textContent).toBe("MA");
    expect(agent?.getAttribute("data-kind")).toBe("agent");
  });
});
