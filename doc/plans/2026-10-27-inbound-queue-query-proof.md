# Inbound queue query proof

## Contract and cause

Paperclip's inbound queue discovers its next deadline, selects each conversation
head, and selects ordinary ready deliveries. A retained processed delivery can
still own the head while an issued or processing `inbound_wakeup` action remains.
This work keeps that obligation, company and endpoint scope, lease expiry,
retry timestamps, ordering keys, lifecycle dependencies, and provider exclusions.
It adds no cache, migration, producer, worker, or timer.

The two open-work selectors used a correlated `EXISTS` inside an `OR`. PostgreSQL
17.11 already used a hashed subplan in the measured fixture. The original
hypothesis of repeated physical action scans was wrong. The estimate still
included a large correlated alternative. It enabled JIT at the normal 100000
cost threshold. The deadline query also evaluated JSON conditions on retained
processed history before rejecting rows with no pending action.

The treatment uses a set of `(company_id, endpoint_id, delivery_id)` for pending
ownership. Null delivery IDs cannot match and are excluded, so the predicate
still returns a boolean. Duplicate actions do not multiply delivery rows.
Ready-only probes retain their original scoped `EXISTS`: a selected head must
not parse an unrelated action's malformed retry timestamp.

## Reproduction

Run from the source checkout with its dependencies built:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-inbound-queue-discovery.ts --baseline-ref=09ad9adce2cf4742944353a3707a2f908e9bb35e --require-work-budget
```

The harness starts disposable PostgreSQL through the repository test helper.
It does not read a live database URL. It loads the pinned pre-fix queue,
entry-point, and ledger sources. Other runtime helpers and dependencies must
match. It captures the complete SQL and parameters through the real service,
including projections, ordering, limits, and the head probe's lease path.
It stops before provider effects. Every selected column is compared as a
positional row in one SQL snapshot. The small control has 20 completed deliveries
and actions. The retained-history case has 1500 of each, two open deliveries,
and 32 KiB of synthetic incompressible message text per historical delivery.

Two warmups precede five alternating samples per arm. Plans use
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` outside the timed samples. The explicit
fixture work budget rejects JIT for the two changed selectors and more than
1000 shared buffers for the deadline selection. It has no CI timing threshold.
Use `--jit-off` for a diagnostic control.

Local evidence uses Node 26.4.0 and Linux ARM64 PostgreSQL 17.11 in a disposable
Docker container, matching the hosted major and minor version. The normal
settings are shared_buffers 128 MiB, work_mem 4 MiB, JIT on, jit_above_cost 100000,
and random_page_cost 4. Native macOS PostgreSQL could not start because the host
had exhausted its SysV semaphore allocation. The scratch provider replaces only
the test PostgreSQL constructor. Schema migrations, clients and query execution
remain real. No persistent database is used.

## Results

Final matched measurements and verification are recorded below before handoff.
The ordinary-ready selector is an unchanged control. The head query still reads
its existing JSON ordering/filter fields; do not claim it reduces physical
history scans. Local SQL timings do not prove a hosted request speedup.

## Feedback loop

| Question | Loop | Measured elapsed | Decision |
| --- | --- | --- | --- |
| Can the real source run locally? | Cached offline install, isolated build | 27.7 s install; 141 s build log span | Reuse the built checkout for each narrow attempt |
| Does the initial scan hypothesis hold? | Captured queries and real PG plans | 4.0 s inside the instrumented baseline harness, plus module loading | Reject repeated physical scans as the cause |
| Does the set improve the actual selectors? | Red work budget, alternating pair, JIT-off control | 28.36 s for all three processes, including module and DB setup | JIT explains ready/head gain; deadline also saves JSON reads |
| Does a selective ready probe remain scoped? | Original and treatment SQL with unrelated malformed retry data | Recorded with the regression result | Keep readiness on the original predicate |

Coordination waits for a quiet benchmark interval are separate from these command
measurements. They are not a reason to run noisy parallel timing samples. The
small real-database regression loop takes about 11 seconds including transforms
and startup. Full repository checks and exact-head CI remain required.

## Scope of benefit

The discovery sample attributed 9.412 summed SQL seconds to 187 deadline and
head selections over about five minutes. The ordinary-ready control accounted
for a further 1.389 seconds over 90 calls. These are background selectors, not a
correlated request critical path. The maximum improvement to a single affected
selection cannot exceed its observed SQL duration (about 49–53 ms on average).
No end-to-end latency or rollout claim follows from adding those overlapping
aggregate times. The change is small and avoids a recurring cost under the
hosted planner defaults, so it is worth shipping with the other proven fixes.
