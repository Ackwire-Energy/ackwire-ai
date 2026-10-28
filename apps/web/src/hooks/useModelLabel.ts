import { useModels } from "@agenteschat/client";

/** A catalog model's name ("Claude Haiku 5.5") once the list is in: its id for one the list doesn't have, null before. */
export function useModelLabel() {
  const models = useModels();
  return (id: string) => (models.data ? (models.data.models.find((m) => m.id === id)?.label ?? id) : null);
}
