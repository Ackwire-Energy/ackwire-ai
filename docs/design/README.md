# Design do agentes

Fonte de verdade visual para o frontend.

## Conteúdo
- `refresh-2026-10.md`: o design system atual (tokens, componentes, movimento).
- `design-system/README.md`: regras de uso (cor, forma, tipo, voz). Leia primeiro.
- `design-system/tokens.json` e `tokens.css`: tokens (claro/escuro via `data-theme`).
- `design-system/bundle.css`: estilos de referência dos componentes (classes `ac-*`).
- `design-system/<Componente>.md`: diretrizes por componente.
- `icons/`: ícones próprios (grid 20px, traço 1.6) e o símbolo do logo.

## Regras que não podem quebrar
- Azul (`agent`) só na identidade dos agentes: avatar, símbolo do logo, anel de "trabalhando", cursor de streaming.
- Cards neutros; estado só em chip com ícone (nunca bolinha, nunca card tingido).
- Mono só para código.
- Controles sempre próprios (select, checkbox, radio, menu, diálogo); nada com visual nativo.
- Listas longas e edição detalhada vão para diálogos com lista e busca.
