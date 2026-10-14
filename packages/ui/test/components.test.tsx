import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  ApprovalCard,
  Avatar,
  Button,
  Chip,
  Composer,
  Icon,
  iconNames,
  initialsOf,
  Logo,
  Menu,
  MenuItem,
  Message,
  MessageText,
  Meter,
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
  test("person is a circle, agent is the cut-corner square; running ring only for agents", () => {
    const { container } = render(
      <>
        <Avatar name="Marina" />
        <Avatar kind="agent" name="Atlas" initials="At" running />
        <Avatar name="João" running />
      </>,
    );
    const [person, agent, notAgent] = Array.from(container.querySelectorAll(".ac-avatar"));
    expect(person?.className).toBe("ac-avatar");
    expect(person?.textContent).toBe("M");
    expect(agent?.className).toContain("ac-avatar--agent");
    expect(agent?.className).toContain("ac-avatar--running");
    expect(agent?.textContent).toBe("At");
    expect(notAgent?.className).not.toContain("ac-avatar--running");
    expect(person?.getAttribute("aria-hidden")).toBe("true");
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
  test("always renders its icon with the word", () => {
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
    expect(body().getByRole("img", { name: "agentes.chat" }).textContent).toBe("agenteschat");
    expect(container.querySelector(".ac-logo__body")).not.toBeNull();
  });

  test("every icon renders a stroke-only 20px glyph, decorative unless labelled", () => {
    for (const name of iconNames) {
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

  test("meter exposes value and max", () => {
    render(<Meter value={12.3} max={40} label="Orçamento usado" />);
    const meter = body().getByRole("meter", { name: "Orçamento usado" });
    expect(meter.getAttribute("aria-valuenow")).toBe("12.3");
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("31%");
  });
});
