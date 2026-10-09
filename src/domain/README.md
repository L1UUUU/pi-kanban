# Workflow domain and transactional store

This module is the trusted Host's single source of workflow decisions. It uses
Node 24 `node:sqlite`, ESM, and erasable TypeScript. No model, shell, network, or
filesystem execution is performed by the domain. All fixture observations are
synthetic; the SQLite transactions and restart tests are real.

## Public API

Import `WorkbenchStore`, `WorkflowService`, `DomainError`, and contract types from
`src/domain/index.ts`.

- `new WorkbenchStore(path = ':memory:')`: SQLite WAL, FULL synchronous writes,
  foreign keys, busy timeout, migration-by-create for the initial schema.
- `store.db`: trusted `DatabaseSync` handle for adapter tables. Workers must never
  receive the handle, database path, or Host service object.
- `store.transaction(work)`: synchronous `BEGIN IMMEDIATE` / commit / rollback.
  Nested domain transactions are rejected. Do not perform external side effects
  within this transaction and claim they were atomically committed.
- `new WorkflowService(store, { fault? })`: optional fault injector for
  `before-commit` / `after-commit` receipt tests.
- `createProject({ id?, name, rootPath, methods?, baseChecks? })`
- `updateProjectMethods(projectId, methods, trustedUser)`
- `createDemand({ id?, projectId, title, description? })`
- `getDemand(id)`, `listDemands(projectId?)`, `listProjects()`, `getRun(id)`,
  `listRuns(demandId?)`
- `trustedUser(userId)`: Host-only creation of an opaque, in-process identity.
- `execute(command, trustedUser)`: records controls and returns a durable receipt.
  Pause/cancel/resume/exit/method changes/blocker clearance require a current
  `expectedRevision`. Plan and acceptance actions always name exact object IDs.
- `workerContext(runId)`: Host-only scoped report capability. A serialized object
  with the same fields is not a valid capability.
- `report(report, workerContext, verification?)`: receives role-scoped, versioned
  reports. The verification argument is supplied by trusted adapters, never by
  forwarding untrusted report fields.
- `claimNextRun({ profileVerified, budgetAvailable, workspaceVerified,
  demandId?, highResource? })`: rechecks current conditions, transactionally claims
  a persistent intent, returns a `RunAttempt`, and does **not** start a process.
- `markRunning(runId, processIdentity)`: binds actual observed process identity.
  A startup observation after pause preserves `stopping` while recording the
  process that must be terminated.
- `confirmStopped(runId, { processAbsent, descendantsAbsent, workspaceVerified,
  evidence })`: releases ownership only after actual adapter verification.
- `markInterrupted(runId, reason)`: preserves unresolved ownership.
- `recoverRun(runId, proof)`: requires stop proof, profile verification, and finite
  remaining budget. Later pause/cancel/exit remains effective.
- `reconnectRun(runId, processIdentity, generation)`: reconnects only to the exact
  observed process and generation, without creating another writer.
- `blockDemand(demandId, code, reason)`: persists a deduplicated trusted Host
  observation, audit, notification, and stop intent. Process crashes and finite
  retry exhaustion use this without forging Worker reports or user commands.
  Ordinary resume never clears the blocker.
- `invalidateCurrentContent(demandId, reason)`: preserves prior results but blocks
  their acceptance after external modifications. Clearing a generic blocker
  cannot revalidate invalidated content.
- `notifications(demandId?)`, `acknowledgeOutbox(id)`: notification acknowledgement
  does not accept, authorize, or resume anything. Start intents may only be claimed
  by the dispatcher.

All complete contracts and discriminated command/report unions are in `types.ts`.

## Handoff sequence

1. Save an idea. No worktree or run is requested.
2. Execute `start-planning`. Freeze all configured stage method snapshots.
3. After actual runtime, budget, and workspace gates are verified, claim/start a
   planning run. Missing methods never fall back to a guessed implementation.
4. Receive `plan-draft`: immutable scope, exact spec/ticket references, demand
   checks, and unresolved questions. Confirm/authorize this plan in either order.
5. Receive `plan-ready` only with verified artifacts and a trusted independent
   boundary-review attestation. Its reviewer run/context, planning run, plan,
   evidence digest, actual execution, and isolated input checks must match.
6. Actual planner stop is required before implementation dispatch. Authority must
   still target the active, confirmed, ready plan.
7. Receive `content-ready` with Host-verified stable K and N. A `contentStable`
   flag must represent real verified frozen bytes; it is not an Agent assertion.
8. After actual writer stop, dispatch a distinct read-only review context, with
   exact spec, tickets, K/N and check evidence; no implementation transcript.
9. Project and demand checks, independent review, required maintenance, and
   blocking finding closure all gate the delivery result. A failed check or
   blocking finding returns work to the implementation method. Only a reviewer
   can close disputed technical findings using verified evidence.
10. Actual run stop plus satisfied quality gates freezes C = P/K/N/E/review/
    finding closures/notes. Only the user can accept that exact C.
11. Explicit return reuses the same demand and starts another result round. C1
    cannot accept C2. Remote delivery and knowledge reuse eligibility are owned
    by separate adapters and are never inferred from acceptance.

## Reliability and adapter obligations

Commands/reports persist facts, history, outbox, and receipt in one SQLite
transaction. Exact request retries return the original receipt; the same
principal/request ID with changed content stores conflict evidence and fails.
Different IDs for the same business action do not duplicate dispatch or acceptance.
Outbox claims run under a write transaction and recheck control and generation.
Old run reports become historical when a newer run has been issued.

There are at most two active demands, one high-resource activity, and one active
run per demand. Unknown and stopping runs retain their reservations. Ordinary
waiting or a paused, actually stopped demand releases them.

Host verification values are **trust-boundary attestations, not security proofs**.
Before setting them, adapters must verify exact artifact bytes and ownership,
actual isolated reviewer input, process-tree absence/identity, actual workspace
contents, validated execution profile and finite budget reservations. The domain
cannot validate Windows process confinement, Pi behavior, or model expenditure
from booleans. The production Host keeps execution disabled until those adapters
and their applicable gates are independently verified.

## Executed domain evidence

Run: `node --test tests/domain*.test.ts`.

The test names map cases to AC-001, AC-005/006, AC-008–018, AC-020–025,
AC-027–031, AC-035, AC-047/048, AC-050–052, AC-054/055, AC-056, AC-064 and
FI-01/02/03/07/08/09/10/16. These are **partial, synthetic rule-level coverage**,
not completed end-to-end acceptance scenarios. In particular:

- FI-01/07 execute rollback and committed-lost-receipt injection against SQLite.
- FI-02/08 verify pause against persistent pending intent and late reports.
- FI-03/16 persist an unresolved run and verify restart/process identity rules.
- FI-09 exercises invalidation and late-writer rejection, not OS filesystem denial.
- FI-10 proves an end event cannot complete business work or release ownership.
- AC-024/029/030 cover changed N with unchanged K, new evidence, rework, and C1/C2.

The full real-agent P07 task and platform-level P10 acceptance remain dependent
on actual methods, Windows confinement/termination, model permissions/budgets,
and integrated adapter validation. No synthetic reviewer or user operation is
reported as a real user's acceptance.
