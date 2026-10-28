# Mine unread badge query

The Mine badge uses the same visible personal top 100, then checks unread. Its correlated participation and privacy predicates can cause PostgreSQL to spend more time compiling the ranking query than executing it. The reported hosted server uses PostgreSQL 17.11 with JIT enabled, jit_above_cost 100000 and full optimization/inlining thresholds 500000.

The final query forms a company-scoped participant set, deduplicates native UUID keys, and joins those keys to the issue primary key. Native issue/comment/request keys stay UUIDs. Legacy activity text passes an exact 36-character lowercase UUID guard inside CASE before conversion. Malformed, uppercase, padded, newline, braced and dashless values still match nothing. The valid all-zero UUID remains supported.

The original canonical activity expression, tie ordering, archive rules, visibility predicate, top 100 limit and second fresh unread query remain intact. There is no cache, API change, schema change, background work or migration. The shared participation helper exposes its existing request/activity predicates so the badge and ordinary Mine paths use the same policy.

## Final local results

These are warm local service timings, not hosted request latency. Each cell has two warmups and five alternating baseline/treatment samples. Values are median milliseconds with min–max ranges. Both complete positional SQL phases and final returned IDs match in all 12 cells.

| Fixture / visibility / JIT | Baseline ms | Treatment ms | Before / after |
| --- | --- | --- | --- |
| small / unrestricted / JIT on | 5.27 (4.32–5.99) | 5.73 (5.00–6.70) | 0.92x |
| small / unrestricted / JIT off | 5.15 (4.14–5.52) | 4.86 (4.29–5.05) | 1.06x |
| small / scoped / JIT on | 4.88 (4.49–33.18) | 6.16 (4.94–8.22) | 0.79x |
| small / scoped / JIT off | 5.46 (4.54–7.04) | 5.62 (4.95–6.26) | 0.97x |
| dense / unrestricted / JIT on | 58.08 (55.88–59.70) | 34.28 (33.24–37.11) | 1.69x |
| dense / unrestricted / JIT off | 18.74 (18.19–19.57) | 35.38 (34.24–38.68) | 0.53x |
| dense / scoped / JIT on | 799.60 (773.96–823.98) | 109.19 (105.70–115.31) | 7.32x |
| dense / scoped / JIT off | 20.00 (19.59–20.35) | 37.16 (36.84–38.40) | 0.54x |
| sparse / unrestricted / JIT on | 57.23 (55.36–59.26) | 13.78 (13.37–14.71) | 4.15x |
| sparse / unrestricted / JIT off | 13.59 (12.04–14.63) | 13.82 (12.48–14.59) | 0.98x |
| sparse / scoped / JIT on | 921.75 (899.63–999.00) | 15.42 (14.26–19.88) | 59.78x |
| sparse / scoped / JIT off | 14.87 (13.44–15.58) | 15.22 (14.07–15.51) | 0.98x |

The target JIT-on paths improve 1.69–59.78x. Small paths overlap and add at most 1.3 ms at the median. Dense JIT-off paths genuinely regress by about 17 ms; sparse JIT-off controls are neutral. This is a planner/JIT optimization for the measured operator configuration. It is not a general execution-time improvement with JIT disabled.

The dense scoped ranking plan falls from 767818 estimated cost to 111520. Full JIT optimization and inlining disappear, but light JIT remains: 70.8 ms compilation versus 757.1 ms before. Sparse scoped planning falls to approximately 12k and has no JIT.

The initial absolute 60 ms goal was not met by the final dense scoped path: 109.19 ms. That failure remains part of the evidence. The final work budget requires at least 1.5x improvement in both dense JIT-on visibility variants and no full JIT optimization/inlining. Small and sparse controls allow at most 25% or 2 ms overhead. An optional absolute cap can still reproduce the 60 ms miss. Retaining the existing canonical query avoids an additional history rewrite; further JIT-off or light-JIT work is deferred.

## Reproduction and fidelity

Baseline: 6b9e5f3a806b7b0a51cfb33d00748d5e1596a159. Its two owning source blobs match the initial 96727b3 baseline. The benchmark copies both the issue service and its participation helper from the pinned revision. It rejects other changed production service/db/shared dependencies and holds installed dependencies fixed across arms.

Treatment service SHA-256: da628d4046f587402bd6ad44087cbe3cd7c692f213bd945f21b785355c709da0. Participation helper SHA-256: 9260d27bb3653aaaff6052cfc57a5877ed55069ee9cc7906458939899cd26173.

Environment: PostgreSQL 17.11 ARM64 Linux Docker, Node 26.4.0, postgres.js 3.4.9, Drizzle 0.45.2, shared_buffers 128 MiB and work_mem 4 MiB. The PostgreSQL major/version and JIT settings match the reported host; architecture, compute, network and storage differ.

Fixtures use fixed timestamps and synthetic data only:

- Small: 12 personal issues,48 activity rows,24 comments.
- Dense: 1200 personal issues,60000 activity rows,24000 comments.
- Sparse: 12 personal issues among 1200 company issues, with the same full company history.
- Each payload has 4096 incompressible bytes. History appends across tasks in timestamp order. This exposes heap-page visits that a task-clustered fixture hides.
- Both unrestricted and actual scoped privacy predicates are measured. The latter uses the real authorization SQL helper. Both database statements and final returned IDs are compared exactly outside timing.

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-mine-unread-badge.ts --baseline-ref=6b9e5f3a806b7b0a51cfb33d00748d5e1596a159 --assert-performance --evidence-dir=<directory>
```

The harness always starts disposable PostgreSQL and ignores DATABASE_URL. Build the SDK dependencies first in a fresh checkout. On this host, native PostgreSQL can fail from system semaphore exhaustion, so a scratch constructor provider substitutes a task-owned Linux PostgreSQL container. Schema allocation, migrations, clients and cleanup remain the normal repository path.

Use --diagnostic for one scoped sparse execution per arm and JIT setting, with plain EXPLAIN first. Optional--sample-gate-dir pauses after fixture setup and captured plans so quiet reservations contain samples only. Use --max-dense-ms=60 to retain the original failed cap. A saved report can be checked again with --validate-report=<report>; production source hashes must still match. Adding --validate-baseline checks the actual captured pre-fix arm against the compiler-work budget and fails because it performs full JIT passes. The unchanged final arm passes the same work budget and the relative speedup/control checks.

## Correctness and loop timing

Fourteen real PostgreSQL tests cover top 100 before unread, canonical activity and ID ties, archives and resurfacing, deleted comments, pending audience/not_creator/dismissal/completion, exact legacy identifiers, company/user scope, inherited grants, private-project membership, revocation and fresh assembled badge route reads. The existing source-aware participation fixture also checks the badge path against provider metadata, historical inbound links, direct human comments and derived agent comments.

| Question | Loop | Measured time and result |
| --- | --- | --- |
| Can the real service import in an isolated checkout? | Pinned offline install and SDK build | Dependency install 21.2 s. First import failed because SDK dist was missing. Building only shared/SDK resolved it. |
| Is ranking expensive? | Initial PostgreSQL18 fixture and real service | 35.4 s through first result, including 29.3 s fixture load. Ranking 96.7 ms included 75.5 ms JIT. |
| Did the first rewrite work? | Full scoped/unrestricted matrix | 89.97 s. Text participant keys still checked privacy across the company; scoped sparse regressed to 392 ms with JIT off. Rejected. |
| Does the smaller native-key query work? | Scoped sparse plain plan then one pair | 31.95 s. Exact output matched; estimated cost 12k and no JIT. |
| Does behavior remain correct? | New and existing PostgreSQL routes/services | 26.49 s including 9.04 s transforms; 14 tests passed before the final canonical-only simplification. The final source rerun passed14tests in18.06s. Full workspace typecheck and build also passed. |
| Final representative matrix | Ready-gated samples with all 12 cells | 442.90 s including coordinated queue waits. Database setup 3.04 s; dense/sparse fixture loads 17.08 s/17.45 s. The ordinary ungated reproduction does not include coordination waits. |

The first 512 MiB scratch fixture failed with ENOSPC 53100. A 2 GiB scratch database completed a fixture; eagerly keeping dense and sparse fixtures together also exceeded that bound. The harness now seeds/measures one fixture at a time and truncates only its own disposable data before the next. These were setup failures, not performance red results. A native-ID draft also exposed an ambiguous Drizzle id alias. The join now names mine_participants.id explicitly, and an empty-database service parse smoke runs before expensive loading.

## Deployment limit

The fresh hosted ranking variants averaged 78.8 ms SQL execution per call. That is the affected SQL-time budget, not a promised HTTP saving. The matching window's HTTP badge requests averaged 752 ms, with p95 1521 ms. No correlated trace proves how much request time belongs to this query, connection wait or other work. Local gains must not be applied directly to those HTTP figures. A deployed revision check and a fresh comparable query/request window remain necessary after rollout. Nothing is deployed by this PR.
