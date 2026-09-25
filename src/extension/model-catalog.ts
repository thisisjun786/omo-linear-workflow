import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { planCatalog } from "../proxy/model-catalog";
import { ROUTING_PROVIDER } from "../proxy/routing-plan";

export default function modelCatalogExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const models = ctx.modelRegistry
      .getAll()
      .filter((model) => model.provider === ROUTING_PROVIDER);
    const plan = planCatalog(models);
    if (plan.changes.length > 0) pi.registerProvider(ROUTING_PROVIDER, { models: plan.models });
  });
}
