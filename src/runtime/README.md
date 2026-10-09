# Runtime implementation and evidence boundary

The Host owns the shared `DatabaseSync`. `RuntimeSupervisor`, `ModelBudgetLedger`, and
`ModelBroker` never derive permission from Worker messages. Callbacks must use the same
trusted Host rule service as desktop controls. No module in this directory sends a paid
request, installs software, changes a Windows ACL, or launches a production Worker by default.

## Current execution paths

- `WindowsCandidateDriver`: unconditional fail-closed production path. It reports missing
  profile/evidence and bridge integration. Even a caller-supplied `verified: true` cannot
  enable execution. No Linux, shell, CLI, or unrestricted fallback exists.
- `SyntheticProcessDriver`: explicitly named Linux trusted-fixture harness. Tests execute
  real Node parent/child processes, check `/proc` birth identity/process group membership,
  signal only owned groups, and observe stopped writing. This is **not containment**:
  `setsid` escape, hostile code, and kill-on-Host-crash are not supported or claimed.
- `native/windows`: real Win32 candidate source and a Windows CTest probe, independently
  gated from production. See its README for commands and unverified limits.

## Supervision API

`new RuntimeSupervisor(db, driver, authorize)` initializes namespaced runtime tables.
`launch(request)` requires demand/role/grant/workspace/profile plus finite timeout and
output limits. It durably reserves a generation before launch. All states other than
`stopped` hold capacity: at most two demands, one writer per demand, one high-resource
check. Source-write privilege is only allowed for implementation.

`stop(runId, reason)` persists intent before signaling. Concurrent stop and launch honor
the durable intention. A matching-generation observation with zero controlled descendants
and explicit proof is required to release the lease. An exception after spawn leaves
`unknown`; PID absence, timeout, wrong generation, or a missing connection cannot release it.
`observe(runId)` is normal lifecycle observation. `recover()` is deliberately stricter:
it never launches or resumes, never clears usage, and quarantines unconfirmed live work.
`isDispatchAllowed` becomes false as soon as stop intention is recorded, including an
output-limit callback from the fixture driver. Call it for every tool/model dispatch.

## Budget and model boundary

Model grants bind exact canonical HTTPS destination, provider, model, roles, immutable
material identities/digests, credential reference (Host only), currency, expiration,
metering policy, and finite request/token/micro-currency amounts. Monetary units are
integer millionths of the named currency, not a claim of exact instantaneous billing.

Each invocation, including SDK retries, compaction, and auxiliary work, must reserve under
a distinct request ID before transmission. Reusing a reservation never permits another
provider call. Reservations are held for missing usage, disconnects, local abort, and
restart. Cumulative partial reports are monotonic and report-ID deduplicated; late final
reports settle unused reserves. If observed usage exceeds the estimate, actual usage is
retained and the grant is blocked. This cannot promise an instantaneous provider-side cap.

`ModelBroker` resolves approved immutable material in the Host, verifies actual content,
rechecks running authorization after async reads, and invokes a fixed transport binding.
It accepts no arbitrary URL, headers, credential, or endpoint redirect from a
Worker. The Pi endpoint persists exact transcript snapshots only after a trusted Host
context authorizer links them to explicit data permission; this is not semantic filtering. A real-provider transport is not supplied in this prototype. Its finite-channel
configuration flag is an additional gate, not a replacement for Windows evidence or a
trusted authorization callback. Ordinary continue and session changes do not add budget.

Persistent retry counters permit an original safe attempt plus two retries. Unknown side
effects forbid retry. Three complete no-progress cycles retain a block; resource waiting
is excluded, and resets require trusted substantive-progress evidence.

## Executed local checks

`node --test tests/runtime*.test.ts tests/agent*.test.ts` on Node 24.19.0/Linux has executed
SQLite persistence, conservative recovery, real trusted process-tree stopping, output-limit
stop, runtime timeout, explicit model/data scope, concurrent reservation, cumulative late
usage, abort accounting, retry/progress and actual Pi SDK deterministic assembly tests.
These cover subsets of PV-02/03/04/09 and FI-03/08/10/11/16. They do not establish Windows
PV-01, the complete Gates G1–G5, real model quality, or product acceptance.
