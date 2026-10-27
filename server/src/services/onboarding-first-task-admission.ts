import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, documents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND, requestCheckboxConfirmationPayloadSchema, requestCheckboxConfirmationResultSchema,
  requestConfirmationPayloadSchema, requestConfirmationResultSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const runOriginFields = {
  nativeIssueId: heartbeatRuns.nativeIssueId,
  issueId: heartbeatRuns.issueId,
  contextIssueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
  contextTaskId: sql<unknown>`${heartbeatRuns.contextSnapshot}->>'taskId'`,
  agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId,
};

function runIssueId(run: {
  nativeIssueId: string | null; issueId: string | null; contextIssueId: unknown; contextTaskId: unknown;
}): string | null {
  const id = run.nativeIssueId ?? run.issueId ?? run.contextIssueId ?? run.contextTaskId;
  return typeof id === "string" ? id : null;
}

const acceptanceRequired = () => forbidden(
  "First-task proposal requires human acceptance before creating execution tasks.",
  { code: "onboarding_first_task_acceptance_required" },
);

/**
 * Creation admission for a run serving the server-owned onboarding task. This is
 * deliberately independent of the requested parent and client origin metadata.
 * Call inside the creation transaction, after a side-effect-free replay check.
 */
export async function assertOnboardingFirstTaskCreationAllowed(tx: Db, input: {
  companyId: string;
  actorAgentId?: string | null;
  actorRunId?: string | null;
}): Promise<void> {
  if (!input.actorAgentId || !input.actorRunId) return;
  const [observedRun] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.actorRunId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.actorAgentId),
  ));
  if (!observedRun) throw forbidden("Authenticated agent run not found");
  const sourceIssueId = runIssueId(observedRun);
  if (!sourceIssueId) return;
  // Match the native authority/interaction lifecycle: issue, then run, then
  // interaction/document. Ordinary tasks acquire no additional row locks.
  const [source] = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, sourceIssueId), eq(issues.companyId, input.companyId),
    eq(issues.originKind, ONBOARDING_FIRST_TASK_ORIGIN_KIND),
  )).for("update");
  if (!source) return;
  const [run] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.actorRunId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.actorAgentId),
  )).for("share");
  if (!run || runIssueId(run) !== source.id) throw acceptanceRequired();

  // Select the newest proposal before checking its outcome: a later pending or
  // rejected proposal must never fall back to an older accepted scope. Governed
  // tool/credential actions and custom completion reviews are not proposals.
  const [proposal] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, source.id),
    inArray(issueThreadInteractions.kind, ["request_confirmation", "request_checkbox_confirmation"]),
    sql`NOT (${issueThreadInteractions.payload} ?| ARRAY['toolAction', 'secretProposal', 'connectionAuthorization'])`,
    sql`COALESCE(${issueThreadInteractions.payload}->'target'->>'type', '') <> 'custom'`,
  )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(1).for("share");
  if (!proposal || proposal.status !== "accepted" || !proposal.resolvedAt) throw acceptanceRequired();
  const checkbox = proposal.kind === "request_checkbox_confirmation";
  const payload = checkbox ? requestCheckboxConfirmationPayloadSchema.safeParse(proposal.payload)
    : requestConfirmationPayloadSchema.safeParse(proposal.payload);
  const result = checkbox ? requestCheckboxConfirmationResultSchema.safeParse(proposal.result)
    : requestConfirmationResultSchema.safeParse(proposal.result);
  if (!payload.success || !result.success || result.data.outcome !== "accepted") throw acceptanceRequired();
  if (checkbox) {
    const selected = object(result.data).selectedOptionIds;
    if (!("options" in payload.data) || !Array.isArray(selected) || selected.length === 0) throw acceptanceRequired();
    const allowed = new Set(payload.data.options.map(option => option.id));
    if (selected.some(id => typeof id !== "string" || !allowed.has(id))
      || selected.length < payload.data.minSelected
      || (payload.data.maxSelected != null && selected.length > payload.data.maxSelected)) throw acceptanceRequired();
  }

  if (proposal.sourceRunId) {
    const [origin] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, proposal.sourceRunId), eq(heartbeatRuns.companyId, input.companyId),
    )).for("share");
    if (!origin || runIssueId(origin) !== source.id || origin.agentId !== proposal.createdByAgentId) throw acceptanceRequired();
  } else if (proposal.createdByAgentId) {
    const [creator] = await tx.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, proposal.createdByAgentId));
    if (creator?.companyId !== input.companyId) throw acceptanceRequired();
  } else if (!proposal.createdByUserId) throw acceptanceRequired();

  const directHumanDecision = Boolean(proposal.resolvedByUserId && !proposal.resolvedByAgentId && !proposal.resolvedByRunId);
  if (!directHumanDecision) {
    const commentId = result.data.commentId;
    if (!commentId || !proposal.resolvedByAgentId || !proposal.resolvedByRunId) throw acceptanceRequired();
    const [comment] = await tx.select().from(issueComments).where(and(
      eq(issueComments.id, commentId), eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, source.id),
    )).for("share");
    if (!comment || comment.deletedAt || comment.authorType !== "user" || !comment.authorUserId
      || comment.authorAgentId || comment.createdByRunId || comment.derivedAuthorAgentId || comment.derivedCreatedByRunId
      || comment.sourceTrust?.disposition === "quarantined" || comment.createdAt < proposal.createdAt
      || comment.body.trim() === "/new") throw acceptanceRequired();
    const [resolver] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, proposal.resolvedByRunId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, proposal.resolvedByAgentId),
    )).for("share");
    if (!resolver || runIssueId(resolver) !== source.id
      || (resolver.responsibleUserId && resolver.responsibleUserId !== comment.authorUserId)) throw acceptanceRequired();
  }

  const target = payload.data.target;
  const [plan] = await tx.select({ documentId: documents.id, revisionId: documents.latestRevisionId })
    .from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(
      eq(issueDocuments.companyId, input.companyId), eq(documents.companyId, input.companyId),
      eq(issueDocuments.issueId, source.id), eq(issueDocuments.key, "plan"),
    )).for("share", { of: documents });
  // Document writers do not all lock the issue, so hold the document row too.
  // A saved plan must be accepted by revision; an untargeted card cannot stand
  // in for approval of a different or subsequently edited document.
  if (plan || target) {
    if (!target || target.type !== "issue_document" || target.key !== "plan"
      || (target.issueId && target.issueId !== source.id) || !plan || plan.revisionId !== target.revisionId
      || (target.documentId && plan.documentId !== target.documentId)) throw acceptanceRequired();
  }
}
