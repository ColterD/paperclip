import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "../server/node_modules/drizzle-orm/index.js";
import { companies, createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { issueService } from "../server/src/services/issues.js";
import { issueReadSqlCondition } from "../server/src/services/authorization.js";

const baselineRef = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref=<commit>");
const baselineRevision = execFileSync("git", ["rev-parse", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const diagnostic = process.argv.includes("--diagnostic");
const treatmentIsBaseline = process.argv.includes("--treatment-is-baseline");
const enforceBudget = process.argv.includes("--assert-performance");
const maxDenseArgument = process.argv.find(arg => arg.startsWith("--max-dense-ms="))?.slice(15);
const maxDenseMs = maxDenseArgument === undefined ? Infinity : Number(maxDenseArgument);
const validateBaseline = process.argv.includes("--validate-baseline");
const validateReport = process.argv.find(arg => arg.startsWith("--validate-report="))?.slice(18);
const sampleGateDir = process.argv.find(arg => arg.startsWith("--sample-gate-dir="))?.slice(18);
const evidenceDir = process.argv.find(arg => arg.startsWith("--evidence-dir="))?.slice(15);
const started = performance.now();
const modulePaths = ["server/src/services/issues.ts", "server/src/services/issue-participation.ts"];
const changedDependencies = execFileSync("git", ["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
assert.deepEqual(changedDependencies.filter(file => !modulePaths.includes(file)), [], "Baseline must use unchanged service dependencies");
type PerformanceCase = {
  jit: string; readMode: string; baseline: { medianMs: number }; treatment: { medianMs: number }; speedup: number;
  plans: Array<{ arm: string; queries: Array<{ plan: Array<{ JIT?: { Options?: { Inlining?: boolean; Optimization?: boolean } } }> }> }>;
};
type PerformanceResult = { fixture: { name: string }; cases: PerformanceCase[] };
function assertPerformance(results: PerformanceResult[], arm: "baseline" | "treatment" = "treatment") {
  const denseCases = results.find(result => result.fixture.name === "dense")!.cases.filter(result => result.jit === "on");
  for (const result of denseCases) {
    if (Number.isFinite(maxDenseMs)) assert.ok(result[arm].medianMs <= maxDenseMs, `Dense default-JIT fixture exceeds ${maxDenseMs}ms local budget: ${result[arm].medianMs.toFixed(2)}ms`);
    const options = result.plans.find(plan => plan.arm === arm)!.queries[0]!.plan[0]!.JIT?.Options;
    assert.ok(!options?.Inlining && !options?.Optimization, `Dense ${arm} must avoid full JIT compilation passes`);
    if (arm === "treatment") assert.ok(result.speedup >= 1.5, `Dense default-JIT fixture requires at least1.5x improvement, observed ${result.speedup.toFixed(2)}x`);
  }
  if (arm === "baseline") return;
  const controls = results.filter(result => result.fixture.name !== "dense").flatMap(result => result.cases);
  for (const control of controls) assert.ok(control.treatment.medianMs <= Math.max(control.baseline.medianMs * 1.25, control.baseline.medianMs + 2), "Small/sparse control regressed beyond25%and2ms allowance");
}
if (validateReport) {
  const report = JSON.parse(await fs.readFile(validateReport, "utf8"));
  assert.equal(report.baselineRevision, baselineRevision);
  for (const [file, hash] of Object.entries(report.sourceHashes)) assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), hash, `Source changed since measured report: ${file}`);
  assertPerformance(report.results, validateBaseline ? "baseline" : "treatment");
  console.log(JSON.stringify({ status: "performance budget passed", report: validateReport, baselineRevision, sourceHashes: report.sourceHashes }));
  process.exit(0);
}
const baselineDir = await fs.mkdtemp(path.join(fileURLToPath(new URL("../server/scripts/", import.meta.url)), ".mine-unread-baseline-"));
const rewrite = (source: string, originalPath: string) => source.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => {
  const resolved = fileURLToPath(new URL(specifier, pathToFileURL(path.resolve(originalPath))));
  const target = resolved.endsWith("/services/issue-participation.js")
    ? path.join(baselineDir, "issue-participation.ts") : resolved;
  return `from ${JSON.stringify(target)}`;
});
for (const modulePath of modulePaths) {
  const source = execFileSync("git", ["show", `${baselineRevision}:${modulePath}`], { encoding: "utf8" });
  await fs.writeFile(path.join(baselineDir, path.basename(modulePath)), rewrite(source, modulePath));
}
const baseline = await import(pathToFileURL(path.join(baselineDir, "issues.ts")).href) as typeof import("../server/src/services/issues.js");
type Query = { sql: string; params: unknown[]; rows: unknown[]; elapsedMs: number };
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
try {
  database = await startEmbeddedPostgresTestDatabase("mine-unread-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 1 });
  await db.$client.unsafe("set client_min_messages = warning");
  const [settings] = await db.$client.unsafe("select version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('jit') jit, current_setting('jit_above_cost') jit_above_cost");
  await issueService(db).unreadInboxIssueIds(randomUUID(), "parse-smoke", sql<boolean>`true`);
  const setupMs = performance.now() - started;
  const captured = new Error("Ranking query captured before execution");
  function captureDb(queries: Query[], captureOnly = false): Db {
    function captureBuilder(builder: any) {
      const from = builder.from.bind(builder);
      builder.from = (...args: any[]) => {
        const query = from(...args), execute = query.execute.bind(query);
        query.execute = async () => {
          const statement = query.toSQL(), started = performance.now();
          if (captureOnly) { queries.push({ ...statement, rows: [], elapsedMs: 0 }); throw captured; }
          const rows = await execute();
          queries.push({ ...statement, rows, elapsedMs: performance.now() - started });
          return rows;
        };
        return query;
      };
      return builder;
    }
    return new Proxy(db!, { get(target, key) {
      if (key === "select") return (...fields: any[]) => captureBuilder((target.select as any)(...fields));
      if (key === "with") return (...ctes: any[]) => {
        const builder = (target.with as any)(...ctes), select = builder.select.bind(builder);
        builder.select = (...fields: any[]) => captureBuilder(select(...fields));
        return builder;
      };
      return Reflect.get(target, key);
    } });
  }
  async function seed(name: string, count: number, participatedCount: number, logsPerIssue: number, commentsPerIssue: number) {
    const fixtureStart = performance.now(), companyId = randomUUID(), userId = `synthetic-${name}`;
    await db!.insert(companies).values({ id: companyId, name: `Synthetic Mine ${name}`, issuePrefix: name.toUpperCase() });
    const ids = Array.from({ length: count }, () => randomUUID());
    await db!.$client.unsafe(`insert into issues(id,company_id,title,status,created_by_user_id,created_at,updated_at)
      select id,$2::uuid,'Synthetic '||n,'todo',case when n <= $4 then $3 else 'unrelated-human' end,
        '2026-01-01'::timestamptz,'2026-01-01'::timestamptz+n*interval '1 second'
      from unnest($1::uuid[]) with ordinality as f(id,n)`, [ids, companyId, userId, participatedCount]);
    const payload = randomBytes(3072).toString("base64");
    await db!.$client.unsafe(`insert into activity_log(company_id,entity_type,entity_id,actor_type,actor_id,action,details,created_at)
      select $1::uuid,'issue',i.id::text,'agent','synthetic-worker',case when n%5=0 then 'issue.read_marked' else 'issue.updated' end,
        jsonb_build_object('padding',$2::text),'2026-01-01'::timestamptz+n*interval '1 second'
      from issues i cross join generate_series(1,$3::int)n where company_id=$1::uuid order by n,i.id`, [companyId, payload, logsPerIssue]);
    await db!.$client.unsafe(`insert into issue_comments(company_id,issue_id,author_user_id,body,created_at)
      select $1::uuid,id,null,$2,'2026-01-02'::timestamptz+n*interval '1 second'
      from issues cross join generate_series(1,$3::int)n where company_id=$1::uuid order by n,id`, [companyId, payload, commentsPerIssue]);
    await db!.$client.unsafe("ANALYZE");
    return { name, companyId, userId, issues: count, participatedCount, activityRows: count * logsPerIssue,
      commentRows: count * commentsPerIssue, payloadBytes: Buffer.byteLength(payload), fixtureMs: performance.now() - fixtureStart };
  }
  async function run(factory: typeof issueService, fixture: Awaited<ReturnType<typeof seed>>, readCondition: Awaited<ReturnType<typeof issueReadSqlCondition>>) {
    const queries: Query[] = [], started = performance.now();
    const result = await factory(captureDb(queries)).unreadInboxIssueIds(fixture.companyId, fixture.userId, readCondition);
    const elapsedMs = performance.now() - started;
    return { result, queries, elapsedMs, serialSqlMs: queries.reduce((total, query) => total + query.elapsedMs, 0) };
  }
  const stats = (values: number[]) => ({ samplesMs: values, medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], minMs: Math.min(...values), maxMs: Math.max(...values) });
  const results = [];
  const shapes = diagnostic ? [["sparse", 1200, 12, 50, 20] as const] : [
    ["small", 12, 12, 4, 2],
    ["dense", 1200, 1200, 50, 20],
    ["sparse", 1200, 12, 50, 20],
  ] as const;
  for (const shape of shapes) {
    const fixture = await seed(...shape);
    if (sampleGateDir) {
      await fs.mkdir(sampleGateDir, { recursive: true });
      const release = path.join(sampleGateDir, `${fixture.name}.release`);
      const scoped = await issueReadSqlCondition(db, { type: "board", source: "session", userId: fixture.userId, authorizingUserId: fixture.userId });
      const estimatedPlans = [];
      await db.$client.unsafe("set jit = on");
      for (const [arm, factory] of [["baseline", baseline.issueService], ["treatment", issueService]] as const) {
        const queries: Query[] = [];
        try { await factory(captureDb(queries, true)).unreadInboxIssueIds(fixture.companyId, fixture.userId, scoped); }
        catch (error) { if (error !== captured) throw error; }
        assert.equal(queries.length, 1);
        const query = queries[0]!;
        const [plan] = await db.$client.unsafe(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params as never[]);
        estimatedPlans.push({ arm, plan: plan["QUERY PLAN"] });
      }
      await fs.writeFile(path.join(sampleGateDir, `${fixture.name}.ready.json`), JSON.stringify({ fixture, settings, estimatedPlans }));
      console.error(`Ready for paired samples: ${fixture.name}`);
      const deadline = Date.now() + 600_000;
      while (true) {
        try { await fs.access(release); break; } catch {}
        assert.ok(Date.now() < deadline, `Timed out waiting for ${release}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await fs.rm(release);
    }
    const cases = [];
    for (const readMode of diagnostic ? ["scoped"] : ["unrestricted", "scoped"]) {
    const readCondition = readMode === "unrestricted" ? sql<boolean>`true` : await issueReadSqlCondition(db, {
      type: "board", source: "session", userId: fixture.userId, authorizingUserId: fixture.userId,
    });
    for (const jit of ["on", "off"]) {
      await db.$client.unsafe(`set jit = ${jit}`);
      const estimatedPlans = [];
      if (diagnostic) {
        for (const [arm, factory] of [["baseline", baseline.issueService], ["treatment", issueService]] as const) {
          const queries: Query[] = [];
          try { await factory(captureDb(queries, true)).unreadInboxIssueIds(fixture.companyId, fixture.userId, readCondition); }
          catch (error) { if (error !== captured) throw error; }
          assert.equal(queries.length, 1);
          const query = queries[0]!;
          const [plan] = await db.$client.unsafe(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params as never[]);
          estimatedPlans.push({ arm, plan: plan["QUERY PLAN"] });
          console.error(JSON.stringify({ diagnostic: fixture.name, jit, arm, estimatedCost: plan["QUERY PLAN"][0].Plan["Total Cost"] }));
        }
      }
      const beforeTimes: number[] = [], afterTimes: number[] = [];
      let before: Awaited<ReturnType<typeof run>> | undefined, after: typeof before;
      for (let iteration = diagnostic ? 0 : -2; iteration < (diagnostic ? 1 : 5); iteration++) {
        const order = iteration % 2 === 0 ? ["before", "after"] : ["after", "before"];
        for (const arm of order) {
          const current = await run(arm === "before" || treatmentIsBaseline ? baseline.issueService : issueService, fixture, readCondition);
          if (arm === "before") { before = current; if (iteration >= 0) beforeTimes.push(current.elapsedMs); }
          else { after = current; if (iteration >= 0) afterTimes.push(current.elapsedMs); }
        }
        assert.deepEqual(after!.result, before!.result, `${fixture.name}/${jit}: complete returned ID order`);
      }
      assert.equal(before!.queries.length, 2);
      assert.equal(after!.queries.length, 2);
      for (let index = 0; index < 2; index++) {
        const oldQuery = before!.queries[index]!, newQuery = after!.queries[index]!;
        const oldRows = await db.$client.unsafe(oldQuery.sql, oldQuery.params as never[]).values();
        const newRows = await db.$client.unsafe(newQuery.sql, newQuery.params as never[]).values();
        assert.deepEqual(newRows, oldRows, `${fixture.name}/${jit}: full positional SQL results phase ${index + 1}`);
      }
      const plans = [];
      for (const [arm, current] of [["baseline", before!], ["treatment", after!]] as const) {
        const queries = [];
        for (const query of current.queries) {
          const [plan] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
          queries.push({ sql: query.sql, params: query.params, rows: query.rows.length, plan: plan["QUERY PLAN"] });
        }
        plans.push({ arm, queries });
      }
      const baselineStats = stats(beforeTimes), treatmentStats = stats(afterTimes);
      cases.push({ readMode, jit, baseline: baselineStats, treatment: treatmentStats, speedup: baselineStats.medianMs / treatmentStats.medianMs, equalIds: after!.result.length, estimatedPlans, plans });
    }
    }
    results.push({ fixture, cases });
    if (sampleGateDir) await fs.writeFile(path.join(sampleGateDir, `${fixture.name}.done.json`), JSON.stringify({ fixture, cases }));
    await db.$client.unsafe("TRUNCATE activity_log, issues, companies CASCADE");
  }
  const report = { baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    treatmentIsBaseline, diagnostic, sourceHashes: Object.fromEntries(await Promise.all(modulePaths.map(async file => [file, createHash("sha256").update(await fs.readFile(file)).digest("hex")]))),
    checkedInLockSha256: createHash("sha256").update(await fs.readFile("pnpm-lock.yaml")).digest("hex"), nodeVersion: process.version, dependencyVersions: Object.fromEntries(await Promise.all(["postgres", "drizzle-orm"].map(async name => [name, JSON.parse(await fs.readFile(`packages/db/node_modules/${name}/package.json`, "utf8")).version]))), settings, setupMs, totalMs: performance.now() - started, results };
  const json = JSON.stringify(report, null, 2);
  if (evidenceDir) { await fs.mkdir(evidenceDir, { recursive: true }); await fs.writeFile(path.join(evidenceDir, "benchmark.json"), json); }
  console.log(json);
  if (enforceBudget && !diagnostic) assertPerformance(results);
} finally {
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  await fs.rm(baselineDir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
