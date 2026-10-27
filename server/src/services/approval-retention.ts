import { approvalExecutionIssueCondition } from "./approval-visibility.js";
import { and, asc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { approvals, companies, decisionRetention, type Db } from "@paperclipai/db";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const archiveDelay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;

export function approvalRetentionService(db: Db) {
  let cursor: { at: string; id: string } | undefined;
  function candidates(database: Db, condition?: SQL) {
    return database.select({ id: approvals.id, companyId: approvals.companyId, at: approvals.updatedAt, cursorAt: sql<string>`${approvals.updatedAt}::text` }).from(approvals)
      .innerJoin(companies, eq(companies.id, approvals.companyId))
      .leftJoin(decisionRetention, and(eq(decisionRetention.companyId, approvals.companyId),
        eq(decisionRetention.sourceKind, "approval"), sql`${decisionRetention.sourceId} = ${approvals.id}::text`))
      .where(and(sql`${approvals.status} = 'pending'`, eq(companies.status, "active"), approvalExecutionIssueCondition(),
        or(isNull(decisionRetention.id), eq(decisionRetention.keep, false)), isNull(decisionRetention.archivedAt), condition))
      .orderBy(asc(approvals.updatedAt), asc(approvals.id));
  }
  async function sweep(now = new Date(), signal?: AbortSignal) {
    const cutoff = new Date(now.getTime() - archiveDelay);
    const rows = await candidates(db, and(lte(approvals.updatedAt, cutoff), cursor
      ? sql`(${approvals.updatedAt}, ${approvals.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined)).limit(100);
    let archived = 0;
    const errors: unknown[] = [];
    for (const candidate of rows) {
      if (signal?.aborted) break;
      try {
        archived += await db.transaction(async tx => {
          const database = tx as unknown as Db;
          const [current] = await candidates(database, and(eq(approvals.id, candidate.id), lte(approvals.updatedAt, cutoff)))
            .for("update", { of: approvals });
          if (!current) return 0;
          const retention = decisionRetentionService(database);
          const source = { sourceKind: "approval" as const, subject: { id: current.id }, activityAt: current.at.toISOString() };
          const states = await retention.syncItems(current.companyId, [source]);
          const state = states.get(`approval:${current.id}`)!;
          return retention.autoArchive({ companyId: current.companyId, now, items: [{ ...source,
            keep: state.keep, archivedAt: state.archivedAt?.toISOString() ?? null, retentionVersion: state.version,
          }] });
        });
      } catch (error) { errors.push(error); }
      cursor = { at: candidate.cursorAt, id: candidate.id };
    }
    if (rows.length < 100) cursor = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Approval retention failed");
    return { archived };
  }
  async function next() {
    const [row] = await candidates(db).limit(1);
    return row ? row.at.getTime() + archiveDelay : null;
  }
  return { sweep, next };
}

export function registerApprovalRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof approvalRetentionService>,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.approvalRetention, {
    run: signal => service.sweep(new Date(), signal), next: service.next, canRun, retryMs: 30_000, notificationCoalesceMs: 30_000,
  });
}
