# Implementation and verification status

This document reports implementation, test evidence and missing execution inputs separately. It does not mark the original 64 acceptance scenarios or G1–G5 complete. Original private planning documents are intentionally absent from this public repository.

## Implemented and testable now

| Plan area | Delivered | Evidence boundary |
|---|---|---|
| P00 project/runtime fixtures | New TypeScript repository, exact lock, build/check/diagnostics, CI, synthetic fixtures | Observed Linux Node 24; Windows CI records its own environment |
| P01 native restrictions | C++ AppContainer + Job candidate, private handles, exact runtime-file grants, role-resource and bundled Pi probes; locked Git Bash dependency manifest | Real Win32 CTest on hosted Windows; Node/Pi startup compatibility is a separate required probe; full Windows 11 profile still unverified |
| P02 supervision/recovery | Persisted generations/intents, stop/observe, concurrency, authenticated cleanup receipts, unknown ownership, timeout/output and sampled disk bounds | Actual Linux fixture process-tree stop; Linux backend never used as a production sandbox; native crash/recovery probes run separately |
| P03 demand rules | Trusted controls, receipts/outbox, version checks, handoffs, immutable results | Real SQLite transactions/restart; external evidence fixtures explicitly synthetic |
| P04 workspace/materials | Real Git worktrees/commits, exact bytes, takeover, crash reconciliation, immutable local objects | Real temporary Git repositories, malformed/corrupt objects, private-path/config negatives |
| P05 SDK assembly | Installed Pi SDK, explicit resources/tools/settings/native sessions, lifecycle and queues | Actual SDK with deterministic transport; no real model or original Skill run |
| P06 usage/outbound control | Explicit scope, reservations, unknown/delayed usage, durable limits, broker | Deterministic provider observations; no model spend or real data egress |
| P07 quality flow | Actual Host-to-Worker planning, implementation, independent boundary Review/formal Review, repair, stopped content handoff and result acceptance; mediated write/delete and native checks | Deterministic installed-SDK and composition fixtures; true design-feature and real-model quality remain blocked |
| P08 knowledge | Immutable candidates, independent evidence/eligibility, allowlisted context, pre-request invalidation checks and all lifecycle decision forms | Real local objects and pre-body filtering; full later-demand model reuse remains unverified |
| P09 remote/baseline | Pinned public GitHub read adapter, final tree correspondence, explicit baseline integration and fresh native check-only reruns with no model call | Controlled responses cannot grant live implementation eligibility; real merge/reuse scenario still required |
| P10 desktop | React workbench + isolated Electron bridge + separate Host, tray/quit, diagnostics, version-bound decisions, paginated immutable artifact reader and knowledge forms | Renderer/model and protocol tests, browser CI; native desktop lifecycle needs observed target testing |
| P11 acceptance handoff | Check commands, CI evidence, module docs, remaining-gate register | Partial verified implementation; not full product acceptance |

## User-visible limitations

1. The production desktop records projects, demands, messages and version-bound decisions. Generic configuration, independent native helper/Worker, model broker, frozen methods, source evidence and independent boundary-review orchestration are implemented. Real autonomous execution remains gated on the complete exact Windows profile and explicit user inputs; it has not been validated end to end with a real model.
2. The package lacks the actual `design-feature` Skill and downstream dependencies. No substitute is presented as the user's original method. Implementation/Review method choices and actual models also need a verified configuration.
3. Model credentials, permitted material/destination, finite spend and live metering are not authorized/configured. The built-in real transport supports the pinned Pi-ai OpenAI Responses catalog at its exact official endpoint. Configuration import, Host-prepared exact input hashes and separate finite consent are implemented; no real model calls were made while building the project.
4. Native CTest covers synthetic Win32 resources and processes. The separate bundled Node/Pi and Git Bash probes must also pass; smoke alone does not establish their compatibility. Hosted Windows Server CI is not the promised Windows 11 target validation. The full production profile additionally requires independently authenticated evidence and a separately provisioned Host trust anchor; imported JSON flags cannot release it.
5. Actual remote merge, final-content equivalence and later-demand experience reuse were not performed. The built-in adapter reads public GitHub repositories; private repository authentication is not implemented. The application has no remote-write operation. The implementation PR itself is not evidence of the application's complete remote/reuse workflow.
6. Native tray, notification and interrupted desktop flows need target-machine verification. Browser preview tests use a separate clearly labeled synthetic fixture.
7. Locked Node and Git Bash checks can read the permitted source and write private scratch. Source edits use the mediated write/delete tools. A command that modifies source, executable modes, Git status or HEAD fails closed before further model traffic or handoff; arbitrary source-modifying shell commands are not supported.
8. Configured hooks/signing, active executable Git filters or merge drivers, source symlinks/submodules and unverified runtime combinations are blocked explicitly. Disk accounting periodically observes source/scratch usage and free space, then stops work at a violation; it is not a hard filesystem quota and permits bounded detection delay. Existing user files are preserved.

## Connected user journey

These are source integration points, not substitutes for real-model acceptance:

1. Import a digest-locked configuration, select a project and explicit baseline, create a demand, and inspect exact method/runtime/provider prerequisites (`host/configuration.ts`, `host/application.ts`).
2. The Host prepares immutable method and permitted input references. A separate finite user grant authorizes the exact model/material scope. The coordinator prepares the unique worktree and dispatches only after all native and domain prerequisites hold (`host/coordinator.ts`, `host/production.ts`).
3. A fresh Pi Worker produces a plan; an independent role reviews boundaries. The user can read exact plan/ticket objects, revise the plan and confirm it. Implementation authorization is separate, with local commit disabled unless expressly selected (`agent/worker-runtime.ts`, renderer decision and artifact components).
4. Implementation writes/deletes through verified mutation receipts and requests locked native checks. Terminal handoff waits for actual process quiescence and resource revocation. Optional commits reject unrelated user changes. Formal Review receives a fresh session and exact content; disagreement, repair, Return and acceptance remain version-bound (`host/production.ts`, `domain/workflow.ts`).
5. Reviewed notes become immutable candidates. Explicit classification, evidence checks and pre-body permission filtering determine reuse. Remote observation, baseline proposals, conflict handling and fresh native verification connect back to the same Host and runtime; they do not manufacture a successful result or reuse an invalid old check (`host/knowledge-lifecycle.ts`).
6. Pause, Cancel and explicit Quit first stop new dispatch and retain ownership until native cleanup is proved. Restart treats ambiguous ownership as occupied. The desktop exposes persistent blockers and safe next decisions rather than reporting a request as completion (`runtime/supervisor.ts`, `host/application.ts`, `desktop/main.ts`).

P00–P11 map to the original task package. The package's execution-input gaps remain distinct from the source restrictions above. In particular, missing real methods or paid-model approval does not imply that the orchestration ends at configuration CRUD.

## Gate register

| Gate | Current release decision | Remaining evidence |
|---|---|---|
| G1 isolation and channels | Not released | Verified target OS/runtime/shell profile; full native Worker/model/private-channel restrictions |
| G2 reliable facts and side effects | Partial tests, not released | Full target-platform failure/restart variants and real runtime integration |
| G3 real demand closure | Blocked | Actual methods, finite authorized model, independent real Review/repair and user acceptance |
| G4 real experience reuse | Blocked | Live dedicated GitHub merge/content verification and real later-demand application |
| G5 combined acceptance | Blocked | Complete original scenario variants, E2E-A–D and target desktop lifecycle evidence |

## Evidence interpretation

Tests include AC/PV/FI identifiers in their names when they exercise part of that requirement. A matching identifier is a traceability aid, not a claim that all its variants pass. Domain booleans in a fixture are synthetic observations. Linux process groups are supervision probes, not isolation. The production profile cannot be enabled simply by changing a JSON `verified` flag.

Run `npm run check` for the final checkout and inspect CI for the exact PR head commit. New changes require the affected tests to run again. CI artifacts preserve environment observations, native probe logs and browser screenshots where available. No failed native probe should be removed or relabeled as skipped to create a green gate.

## External technical references

- [Pi SDK](https://pi.dev/docs/latest/sdk): explicit resource/session/model boundaries and settled lifecycle
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer/IPC/origin restrictions
- [Node SQLite](https://nodejs.org/api/sqlite.html): native Host storage API
- [Windows AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): native candidate primitives, not proof of this combination
