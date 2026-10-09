# Implementation and verification status

This document reports implementation, test evidence and missing execution inputs separately. It does not mark the original 64 acceptance scenarios or G1–G5 complete. Original private planning documents are intentionally absent from this public repository.

## Implemented and testable now

| Plan area | Delivered | Evidence boundary |
|---|---|---|
| P00 project/runtime fixtures | New TypeScript repository, exact lock, build/check/diagnostics, CI, synthetic fixtures | Observed Linux Node 24; Windows CI records its own environment |
| P01 native restrictions | C++ AppContainer + Job candidate, private handles, role-resource smoke probes | Real Win32 CTest when run on Windows; full Windows 11 + Node/Git Bash/Pi profile still unverified |
| P02 supervision/recovery | Persisted generations/intents, stop/observe, concurrency, unknown ownership, timeout/output bounds | Actual Linux fixture process-tree stop; Linux backend never used as a production sandbox |
| P03 demand rules | Trusted controls, receipts/outbox, version checks, handoffs, immutable results | Real SQLite transactions/restart; external evidence fixtures explicitly synthetic |
| P04 workspace/materials | Real Git worktrees/commits, exact bytes, takeover, crash reconciliation, immutable local objects | Real temporary Git repositories, malformed/corrupt objects, private-path/config negatives |
| P05 SDK assembly | Installed Pi SDK, explicit resources/tools/settings/native sessions, lifecycle and queues | Actual SDK with deterministic transport; no real model or original Skill run |
| P06 usage/outbound control | Explicit scope, reservations, unknown/delayed usage, durable limits, broker | Deterministic provider observations; no model spend or real data egress |
| P07 quality flow | Plan/implementation/independent Review/repair/acceptance rules and Host coordination | Rule/integration fixtures; true design-feature and real-model quality remain blocked |
| P08 knowledge | Immutable candidates, independent evidence/eligibility, allowlisted context, invalidation | Real local objects and pre-body filtering; full later-demand model reuse remains unverified |
| P09 remote/baseline | Pinned read-only GitHub adapter, merge/content facts, controlled baseline integration | Controlled responses cannot grant live implementation eligibility; real merge/reuse scenario still required |
| P10 desktop | React workbench + isolated Electron bridge + separate Host, tray/quit, persistent diagnostics | Renderer/model and protocol tests, browser CI; native desktop lifecycle needs observed target testing |
| P11 acceptance handoff | Check commands, CI evidence, module docs, remaining-gate register | Partial verified implementation; not full product acceptance |

## User-visible limitations

1. The production desktop records projects, demands, messages and version-bound decisions and displays results/diagnostics. It does not yet autonomously complete a real request: the production Windows Worker launch/channel/evidence integration is not released.
2. The package lacks the actual `design-feature` Skill and downstream dependencies. No substitute is presented as the user's original method. Implementation/Review method choices and actual models also need a verified configuration.
3. Model credentials, permitted material/destination, finite spend and live metering are not authorized/configured. No real model calls were made while building the project.
4. Native CTest covers synthetic Win32 resources and processes. It does not establish Node, Git Bash, Pi, hooks/signing, all reparse/network variants or complete Windows 11 behavior. Hosted Windows Server CI is not the promised target OS validation.
5. Actual remote merge, final-content equivalence and later-demand experience reuse were not performed. The application has no remote-write operation. The implementation PR itself is not evidence of the application's complete remote/reuse workflow.
6. Native tray, notification and interrupted desktop flows need target-machine verification. Browser preview tests use a separate clearly labeled synthetic fixture.

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
