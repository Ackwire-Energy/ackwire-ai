import "i18next";
import type { ptBR } from "@agenteschat/i18n";

// Makes `t("shell.approvals")` type-checked against the pt-BR source.
declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof ptBR };
  }
}
