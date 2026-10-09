# Implementation and verification status

The approved first product scope is **Node-native controlled tools with no shell**. Bash/POSIX support from the original plan is explicitly deferred, not accepted as implemented. This document reports implementation, test evidence and missing execution inputs separately. It does not mark the original 64 acceptance scenarios or G1–G5 complete. Original private planning documents are intentionally absent from this public repository.

## Implemented and testable now

| Plan area | Delivered | Evidence boundary |
|---|---|---|
| P00 project/runtime fixtures | New TypeScript repository, exact lock, build/check/diagnostics, CI, synthetic fixtures | Observed Linux Node 24; Windows CI records its own environment |
| P01 native restrictions | C++ AppContainer + Job candidate, private handles, exact runtime-file grants, role-resource and bundled Pi probes; Node-only product profile | Earlier hosted-Windows Node/Pi and protected-metadata probes passed for explicit revised LPAC; later child-process pipe failure and excluded Git Bash failures remain evidence; in-process checks require exact-commit native results; Windows 11 remains unverified |
| P02 supervision/recovery | Persisted generations/intents, stop/observe, concurrency, authenticated cleanup receipts, unknown ownership, timeout/output and sampled disk bounds | Actual Linux fixture process-tree stop; Linux backend never used as a production sandbox; native crash/recovery probes run separately |
| P03 demand rules | Trusted controls, receipts/outbox, version checks, handoffs, immutable results | Real SQLite transactions/restart; external evidence fixtures explicitly synthetic |
| P04 workspace/materials | Real Git worktrees/commits, exact bytes, takeover, crash reconciliation, immutable local objects | Real temporary Git repositories, malformed/corrupt objects, private-path/config negatives |
| P05 SDK assembly | Installed Pi SDK, explicit resources/tools/settings/native sessions, lifecycle and queues; pinned stage Skill metadata and audited progressive reference loading | Actual SDK with deterministic transport and exact public upstream bodies; private entry loading validated separately, no real-model planning run |
| P06 usage/outbound control | Explicit scope, reservations, unknown/delayed usage, durable limits, broker | Deterministic provider observations; no model spend or real data egress |
| P07 quality flow | Host-to-Worker staged planning: fresh facts, clarification, separate requirement confirmation, design, fresh independent review, resolution, separate final-design confirmation, local spec/tickets; implementation and formal Review remain separately authorized | Deterministic installed-SDK production-frame journey, frozen upstream resource and decision/input negatives; native and real-model quality remain separate gates |
| P08 knowledge | Immutable candidates, independent evidence/eligibility, allowlisted context, pre-request invalidation checks and all lifecycle decision forms | Real local objects and pre-body filtering; full later-demand model reuse remains unverified |
| P09 remote/baseline | Pinned public GitHub read adapter, final tree correspondence, explicit baseline integration and fresh native check-only reruns with no model call | Controlled responses cannot grant live implementation eligibility; real merge/reuse scenario still required |
| P10 desktop | React workbench + isolated Electron bridge + separate Host, tray/quit, diagnostics, version-bound decisions, paginated immutable artifact reader and knowledge forms | Renderer/model and protocol tests, browser CI; native desktop lifecycle needs observed target testing |
| P11 acceptance handoff | Check commands, CI evidence, module docs, remaining-gate register | Partial verified implementation; not full product acceptance |

## User-visible limitations

1. The production desktop records projects, demands, messages and version-bound decisions. Generic configuration, independent native helper/Worker, model broker, frozen methods, source evidence and independent boundary-review orchestration are implemented. Real autonomous execution remains gated on the complete exact Windows profile and explicit user inputs; it has not been validated end to end with a real model.
2. The private `design-feature` entry remains an external user configuration, never a repository copy. Its four public downstream skills, owned references, original invocation policy/metadata and MIT license are now vendored at exact commit `b0618bc436ad893b3c5e84e55fba86586d34a404`. The supplied external entry and seven stage projections passed local structural/digest loading; this is not a real-model method evaluation. Production requires `design-feature-staged-v1` and a complete frozen manifest; `explicit-text-v1` planning is blocked outside explicit synthetic fixtures. Implementation/Review methods and model permissions still require explicit selections.
3. Model credentials, permitted material/destination, finite spend and live metering are not authorized/configured. The built-in real transport supports the pinned Pi-ai OpenAI Responses catalog at its exact official endpoint. Configuration import, Host-prepared exact input hashes and separate finite consent are implemented; no real model calls were made while building the project.
4. Earlier hosted-Windows execution passed 16 bundled Node/Pi, role, resource, process, recovery and disk probes for the explicit revised LPAC candidate; those probes did not validate the later in-process test fixture or Node child-process pipe creation described below. The protected Git/.local read/delete defect is closed by real-token tests, including inheritance restoration and overlapping-workspace cases. **Stock Git Bash is excluded from the approved Node-only scope and remains incompatible:** its MSYS runtime receives access denied while creating its named-object directory, before the script runs. The ordinary AppContainer candidate also retains an inconclusive network denial result. Both failures remain visible as non-gating diagnostics for excluded combinations; selected Node-only native failures remain gating. No shared namespace grant or fallback bypasses them. See the [reproduction and exact evidence](../native/windows/README.md#observed-windows-result-2026-10-09). Hosted Windows Server CI is not Windows 11 validation. Production still requires independently authenticated target evidence and a separately provisioned Host trust anchor; imported JSON flags cannot release it.
5. Actual remote merge, final-content equivalence and later-demand experience reuse were not performed. The built-in adapter reads public GitHub repositories; private repository authentication is not implemented. The application has no remote-write operation. The implementation PR itself is not evidence of the application's complete remote/reuse workflow.
6. Native tray, notification and interrupted desktop flows need target-machine verification. Browser preview tests use a separate clearly labeled synthetic fixture.
7. Locked Node checks can read the permitted source and write private scratch. Production shell configuration and shell requests are blocked. Node tests must explicitly use in-process execution with `--test-isolation=none`; default process-isolated tests are outside the current scope. Tests, dependencies and applicable JavaScript CLI entry points must not create child-process pipes or IPC named pipes. The pinned Node 24.19.0 native fixture in [historical run 37903915830](https://github.com/L1UUUU/pi-kanban/actions/runs/37903915830) timed out without parent-readiness output during `child_process.spawn` setup under LPAC. An access-denied retry loop in the global pipe namespace is a [source-supported explanation](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/pipe.c#L194-L219); no Win32 syscall trace was captured, and the failed fixture evidence is preserved. The real in-process test fixture is part of the required native recorder; its result must be read from the Windows run for the exact commit, not inferred from earlier Node/Pi probes or portable tests. Required check semantics are never silently changed to fit this scope. npm scripts requiring a system shell, Bash/POSIX pipelines and arbitrary native commands are excluded. Source edits use the mediated write/delete tools. A command that modifies source, executable modes, Git status or HEAD fails closed before further model traffic or handoff; arbitrary source-modifying shell commands are not supported.
8. Configured hooks/signing, active executable Git filters or merge drivers, source symlinks/submodules and unverified runtime combinations are blocked explicitly. Disk accounting periodically observes source/scratch usage and free space, then stops work at a violation; it is not a hard filesystem quota and permits bounded detection delay. Existing user files are preserved.

## Connected user journey

These are source integration points, not substitutes for real-model acceptance:

1. Import a digest-locked configuration, select a project and explicit baseline, create a demand, and inspect exact method/runtime/provider prerequisites (`host/configuration.ts`, `host/application.ts`).
2. The Host prepares immutable method and permitted input references. A separate finite user grant authorizes the exact model/material scope. The coordinator prepares the unique worktree and dispatches only after all native and domain prerequisites hold (`host/coordinator.ts`, `host/production.ts`).
3. A new read-only context gathers facts. Clarification persists bounded questions and exact owner answers; the owner confirms the resulting requirement understanding. Design then receives a separate fresh read-only review, followed by explicit finding dispositions. The owner separately confirms the final design and testing seams. Only then do fresh stage sessions generate a non-executable local spec and typed tickets with real artifact references, spec-clause links and acyclic blocking edges. There is no extra mandatory internal technical split approval. Every handoff waits for observed model use, the active skill read receipt, verified artifacts and actual process stop/revocation. Owner answers, confirmations and revisions change the data digest and need an exact current grant before the next model request. Completed planning still leaves implementation authority absent (`agent/worker-runtime.ts`, `domain/planning.ts`, renderer planning and artifact components).
4. Implementation writes/deletes through verified mutation receipts and requests locked native checks. Terminal handoff waits for actual process quiescence and resource revocation. Optional commits reject unrelated user changes. Formal Review receives a fresh session and exact content; disagreement, repair, Return and acceptance remain version-bound (`host/production.ts`, `domain/workflow.ts`).
5. Reviewed notes become immutable candidates. Explicit classification, evidence checks and pre-body permission filtering determine reuse. Remote observation, baseline proposals, conflict handling and fresh native verification connect back to the same Host and runtime; they do not manufacture a successful result or reuse an invalid old check (`host/knowledge-lifecycle.ts`).
6. Pause, Cancel and explicit Quit first stop new dispatch and retain ownership until native cleanup is proved. Restart treats ambiguous ownership as occupied. The desktop exposes persistent blockers and safe next decisions rather than reporting a request as completion (`runtime/supervisor.ts`, `host/application.ts`, `desktop/main.ts`).

See the [support matrix](support-matrix.md) for the approved Node-only combination and excluded command types. P00–P11 map to the original task package. The package's execution-input gaps remain distinct from the source restrictions above. In particular, missing real methods or paid-model approval does not imply that the orchestration ends at configuration CRUD.

## Gate register

| Gate | Current release decision | Remaining evidence |
|---|---|---|
| G1 isolation and channels | Not released; Node-only scope | Verify the exact target Windows 11 Node/Pi profile and complete native-channel matrix. Excluded Git Bash is not a Node-only release prerequisite; historical failures remain visible. |
| G2 reliable facts and side effects | Partial tests, not released | Full target-platform failure/restart variants and real runtime integration |
| G3 real demand closure | Blocked | Explicit external private entry and method selections, finite authorized real model, independent real Review/repair and user acceptance; pinned public dependency loading is implemented |
| G4 real experience reuse | Blocked | Live dedicated GitHub merge/content verification and real later-demand application |
| G5 combined acceptance | Blocked | Complete original scenario variants, E2E-A–D and target desktop lifecycle evidence |

## Evidence interpretation

Tests include AC/PV/FI identifiers in their names when they exercise part of that requirement. A matching identifier is a traceability aid, not a claim that all its variants pass. Domain booleans in a fixture are synthetic observations. Linux process groups are supervision probes, not isolation. The production profile cannot be enabled simply by changing a JSON `verified` flag.

Run `npm run check` for the final checkout and inspect CI for the exact PR head commit. New changes require the affected tests to run again. CI artifacts preserve environment observations, native probe logs and browser screenshots where available. No failed native probe should be removed or relabeled as skipped to create a green gate.

The new staged resource tests execute the installed Pi SDK, its controlled skill
tool loop and exact public reference bytes. Production journey tests exercise
the actual Host/Worker framing, grants, persisted flow, restart, pause and stale
decision handling with synthetic native observations and deterministic provider
output. They do not prove Windows confinement, provider quality or autonomous
planning correctness. Local checks and exact-final-commit CI are separate:
CI for the staged change's new final commit remains pending verification.

## External technical references

- [Pi SDK](https://pi.dev/docs/latest/sdk): explicit resource/session/model boundaries and settled lifecycle
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer/IPC/origin restrictions
- [Node SQLite](https://nodejs.org/api/sqlite.html): native Host storage API
- [Windows AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): native candidate primitives, not proof of this combination
