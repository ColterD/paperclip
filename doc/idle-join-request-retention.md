# Join request retention while idle

Pending join requests already have durable activity timestamps. Retention now
uses their next 90-day archive deadline instead of including them in the main
maintenance tick's attention-feed scan. The regular attention UI still includes
join requests. This changes automatic retention discovery, not access approval.

## Owner and eligibility

`join-request-retention.ts` owns the candidate query, bounded scan, and deadline.
A candidate is a pending_approval request belonging to an active company, with
an invite whose company matches the request. Kept and already archived items do
not schedule work. Invite expiration or revocation does not remove the existing
attention item and therefore does not disable its retention. No provider policy
is interpreted by the worker or shared scheduler.

The next deadline is the earliest eligible updatedAt plus 90 days. The partial
pending index orders updated_at and id. Resolved request history is excluded by
the index predicate. Each pass attempts at most 100 due rows. The private cursor
preserves database timestamp precision so a failed page cannot starve later work.
Errors keep the shared 30-second retry; successful full pages continue until
work is exhausted. No eligible rows means no scheduled SQL or network scan.

Each candidate is re-read under its request row lock before retention changes.
A writer that wins that lock first is rechecked before archival. If archival
commits first, a later activity write leaves the item archived until explicit
revival; updating activity does not clear existing retention choices. The tests
cover the writer-first race and the archive-first committed outcome. Supported
invite replay expires before the 90-day cutoff and Slack access replay deduplicates;
a future producer that needs to reappear after archival must request revival.
The shared retention owner still controls keep, archive/revive, version checks,
activity logging, and notification creation. Archiving does not approve or reject a join.
Join requests have no origin agent, so their archival creates no agent delivery.
Company and invite joins preserve existing visibility policy; this does not add
cross-table serializability beyond the existing retention contract.

## Producer audit

| Producer | Notification boundary |
| --- | --- |
| Invite acceptance creates a pending request | Existing acceptance transaction, before the request insert |
| Supported gateway invite replay changes activity | Small writeJoinRequestChange transaction around the existing SQL update |
| Automatic human approval after acceptance | Same helper around the status update |
| Explicit approval and rejection | Same helper around the status update |
| Slack self-service access request | Existing platform transaction, before the request insert |
| Company pause, resume, archive, or deletion | Company-level retention notification inside the existing transaction |
| Budget-driven company pause or resume | Same company notification in the accounting transaction |
| Keep/unkeep, manual archive/revive, accepted archive proposal | Existing typed retention notification now routes join_request to its worker |

Provider calls, membership grants, and unrelated route behavior stay outside the
small SQL mutation helper. Nested callers retain the existing outer transaction
settlement and uncertain-outcome protocol. The access router itself requires a
root database connection; it is not wrapped in a caller transaction.

API-key consumption only permits an already-approved request. It cannot create
pending retention work and does not acquire a new wrapper or signal. Invite
acceptance that reuses a human request does not update that request. Revocation,
expiry, and acceptedAt changes do not change the feed predicate. Invite/company
identity is immutable in supported routes; company deletion is the invite delete
owner. A future producer that changes these facts must join the same contract.
Process-local signals do not cover independent SQL writers or another instance.

## Lifecycle and limits

Startup reconstructs pending deadlines. The worker is registered only when the
existing heartbeat maintenance switch is enabled. Writes during drain retain a
wake without passive SQL. Failed work retains its retry across drain. Shutdown
joins an admitted archive and stops before subsequent candidates; restart picks
up the durable remainder. There is no new queue table or permanent DB listener.
The in-process deadline is not a Cloud alarm. Existing unsupported-future-work
sleep blockers remain in place.

## Verification

Seventeen new real-PostgreSQL cases pass. They cover actual invite acceptance,
rejection, human approval, gateway replay, and Slack access requests; empty and
resolved-history quiet; saved deadlines; startup reconstruction; keep and manual
archival controls; company pause/resume; unchanged expired/revoked invite policy;
normal versus maintenance feeds; nested commit/rollback; first writes and failed
work during drain; concurrent source updates; 101-row microsecond paging with a
full failed page; and shutdown/restart.

Another 139 consumer cases pass: 71 invitation/startup cases, 21 approval worker
cases, and 47 shared retention/attention/budget cases. This is 156 selected tests,
not a full local suite claim. The first consumer command used a nonexistent
retention test filename and ran only the approval suite; the corrected selection
ran the actual retention suite against its dedicated external database.

Initial test failures exposed fixture assumptions: the access router cannot run
on a transaction handle; unresolved recovery cannot be expected to become idle;
Slack links require actual endpoint/principal ownership rows; and shutdown tests
must establish admission and deterministic candidate order. Those fixtures were
corrected without weakening assertions or production checks. The first replay
fixture lacked required gateway credentials. The final fixture supplies test-only
credentials. A reused transaction spy retained admission calls during the quiet
assertion; restoring it before the quiet measurement fixed the measurement.

Migration 0387 applies, the full migration set replays, and the concurrent index
statement replays idempotently. Migration safety and numbering checks pass; the
five newest schema snapshots are retained. The actual next-deadline query with
40,000 resolved requests and one pending request uses the pending index and
executes in 0.017 ms locally. The probe rolls back its data. This is query-plan
evidence, not production latency or measured savings. Workspace typechecking and the production build pass. Fresh PR CI/review remain
required before readiness.
