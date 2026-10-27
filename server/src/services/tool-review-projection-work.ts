import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { toolReviewProjectionService } from "./tool-review-projection.js";

export function registerToolReviewProjectionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof toolReviewProjectionService>,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.toolReviewProjection,
    batchSize: 1,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async (companyId?: string) => (await service.companies(companyId))
      .map(row => ({ ...row, id: row.companyId, dueAt: Date.now() })),
    check: async (entry, signal) => {
      const result = await service.sweep(entry.companyId, { maxRows: 500, signal, shouldContinue: canRun });
      return result.retry ? { ...entry, dueAt: Date.now() + (result.truncated ? 1000 : 30_000) } : null;
    },
  }, canRun);
}
