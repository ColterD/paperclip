# Mine unread badge query

The badge must keep the same visible Mine top 100, then test unread. This change belongs to the issue service. It does not change the Mine list API, blocked task graphs, polling, archives, or read freshness.

## Hypothesis and smallest faithful loop

The ranking query repeats correlated participation and activity aggregates across the personal candidate set. PostgreSQL assigns this query a high estimated cost and enables JIT. A local initial profile on PostgreSQL 18.6 estimated 243,685 cost, with 96.7 ms execution including 75.5 ms JIT. The request's second unread phase took 0.8 ms in its plan. This distinguishes ranking cost from the entire sidebar request.

Use the real `issueService.unreadInboxIssueIds` with disposable PostgreSQL. Copy both the pinned issue service and its participation helper from commit 6b9e5f3a806b7b0a51cfb33d00748d5e1596a159. Its two owning source blobs match the original 96727b3 baseline. Hold the other service dependencies fixed. Capture both actual generated queries, all positional output columns, final returned IDs, and query plans. Both observed unrestricted and scoped visibility query variants are measured.

The treatment forms the same participation set through company-scoped identifiers. Native issue/comment/request identifiers stay UUIDs. Legacy activity identifiers pass an exact 36-character lowercase UUID guard inside CASE before conversion. Malformed, uppercase, padded and noncanonical values still match nothing. Indexed issue lookups from the distinct participant set apply the unchanged access, visibility and archive predicates. The original canonical activity expression, ordering and top 100 remain intact. The second unread query still reads current data.

## Verification design

- Real database tests cover top 100 before unread, canonical activity and ID ties, archive resurfacing, deleted comments, request audience/creator/dismissal, exact activity text IDs, company/user scope, supplied read restrictions, and fresh badge route reads.
- The existing source-aware participation route fixture also exercises the badge path. It includes provider metadata, historical inbound links, direct human comments, and derived agent comments.
- The benchmark uses a 12-task small control, 1,200 personal tasks with 60,000 activity rows and 24,000 comments, and 12 personal tasks among 1,200 company tasks with the same history. Each history payload has 4,096 incompressible bytes. Logs append across tasks in timestamp order so repeated heap-page visits are represented.
- Each fixture uses two warmups and five alternating samples per arm. JIT-on matches the reported hosted settings; JIT-off is a diagnostic control. PostgreSQL 17 matches the hosted major version.
- The explicit local budget is a dense default-JIT median ≤60 ms and at least 1.5x faster, with small/sparse overhead below 25% or 2 ms. No noisy wall-clock assertion is added to CI.

Run:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-mine-unread-badge.ts --baseline-ref=6b9e5f3a806b7b0a51cfb33d00748d5e1596a159 --assert-performance --max-dense-ms=60
```

Add `--treatment-is-baseline` to capture the pre-fix performance budget failure. Add `--evidence-dir=<directory>` to retain the complete report. The harness always creates its own disposable database and ignores `DATABASE_URL`.

## Loop timing and retained failures

| Question | Loop | Measured elapsed / main wait | Result |
| --- | --- | --- | --- |
| Can the real service import in an isolated checkout? | Pinned offline install and SDK build | Dependency install 21.2 s; first import failed because SDK dist was absent | Built only shared/SDK, then repeated the service loop |
| Does ranking exhibit expensive work? | Initial real PostgreSQL 18 fixture and full service | 35.4 s setup through first interpretable result, 29.3 s fixture load | JIT dominates the ranking query; preserve JIT-off diagnostic |
| Does behavior stay correct? | New badge tests and existing creation/participation routes | 26.49 s including 9.04 s transforms | 14 tests passed |

The first 512 MiB scratch PostgreSQL fixture failed with ENOSPC 53100. A 2 GiB scratch database completed one fixture. The first final harness eagerly retained dense and sparse fixtures together and also failed setup with ENOSPC. The harness now seeds and measures one fixture at a time, then truncates only its own disposable fixture before the next case. These were setup failures, not accepted performance or correctness results.

## End-to-end bound and remaining proof

The fresh hosted ranking variants averaged 78.8 ms SQL execution per call. Even removing all their execution cannot save more than that affected serial SQL time on average. The matched HTTP sample averaged 752 ms, with p95 1,521 ms; there is no correlated trace proving that the rest is SQL, connection wait, or this query. Local service improvement does not establish a deployed request improvement. A fresh deployed comparison remains required after rollout.

## Rejected treatment and shorter iteration

The first set-based draft kept participant IDs as text. It improved unrestricted reads, but the scoped sparse query still checked privacy across the company before joining participation. It regressed from about 15 ms to 392 ms with JIT disabled. Its full-JIT dense median was 882 ms. This treatment failed the 60 ms performance budget and was rejected.

The final candidate instead joins deduplicated native UUID participant IDs to the issue primary key. A scoped sparse diagnostic reduced estimated cost 761,590→12,233.55 and removed JIT. It preserved complete ordered phase results and final output. That diagnostic overlapped broader checks, so its single wall-time sample is not final performance evidence. JIT-off plan execution was 15.24→15.49 ms, which supports a planner/JIT mechanism rather than an intrinsic scan speed claim.

The initial native-ID draft also failed real PostgreSQL parsing because Drizzle left a selected id alias unqualified in the join. The join now names mine_participants.id explicitly. The harness runs an empty-database service parse smoke before expensive fixture loading. A scoped single-fixture mode uses plain EXPLAIN before one execution per arm. The final sample gate pauses after setup so quiet reservations contain paired SQL samples only.

A further scoped sparse diagnostic removed the grouped-log CTEs and retained the original canonical activity expression. Native participant keys alone kept estimated cost 12,286.84 with no JIT. JIT-off plans were 10.49→9.03 ms. This smaller query is the final measurement candidate; the earlier grouped history rewrite is not part of the final source.
