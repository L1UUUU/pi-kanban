# Architecture

## Processes and authority

The React renderer has no Node.js access. Electron uses a sandboxed renderer, context isolation, a restrictive CSP, a packaged `app://workbench` origin, sender-frame validation and a narrow preload bridge. It does not expose shell commands, arbitrary filesystem access, Worker reports, database handles, or generic IPC channels.

Electron starts a separately selected Node 24 executable with a private IPC channel and a minimal environment. The Host alone writes business facts to SQLite. No TCP control service is exposed. A snapshot sequence, persisted across restarts, prevents delayed responses from replacing newer whole-state views.

Untrusted project code and Pi Workers must run outside the Host in the verified native boundary. Production dispatch is currently disabled because that complete boundary is not yet verified or wired to a production Worker channel. Nothing falls back to unrestricted Host execution. The native candidate and deterministic SDK fixtures are explicit, separate artifacts.

## Modules

| Responsibility | Module | Important boundary |
|---|---|---|
| F: demand/control/handoff | `src/domain` | User controls are in-process capabilities; Worker reports cannot authorize, accept or grant budget |
| Q: checks/findings/results | `src/domain` | Required evidence and independent Review bind exact P/K/N; C is immutable |
| R: execution/stop/budget | `src/runtime` | Persist intent first; confirmed process-tree absence is different from a stop request |
| W: Git/worktrees/materials | `src/workspace` | One worktree, exact base/paths/bytes, no arbitrary Git command/remote-write API |
| K: knowledge qualification | `src/knowledge` | Metadata permission/applicability filtering occurs before body reads/search |
| Pi SDK adapter | `src/agent` | Explicit resources, settings, model access and native session history |
| Composition | `src/host` | One rule engine, durable F/R binding, normal/late report and recovery handling |
| Desktop | `src/desktop` | Presentation only; visible buttons are not an authorization decision engine |

## Versions and delivery

A demand maintains separate plan revisions, authority, execution attempts, code/material versions, check evidence, findings, stable results and acceptance. A result identifies P (plan), K (code), N (local knowledge), E (checks/review) and C (the immutable result record). Accepting C1 cannot accept C2. Changes to N require evidence applicability even when K is unchanged. Accepting a result never creates a merge observation or knowledge eligibility.

Planning captures the method configuration at first start. Later project defaults cannot silently change an existing demand. Missing methods remain explicit blockers. Spec/tickets default to private immutable local materials; necessary formal project documents remain normal versioned deliverables.

## Durable boundaries

Domain commands commit facts, input identity/hash, receipts, audit entries and outbox together. Duplicate identities with altered content conflict; semantic duplicates do not create another operation. File/Git/process effects are not claimed to be part of SQLite transactions: each has durable intention plus exact reconciliation.

`ExecutionCoordinator` maps domain attempts to runtime generations, persists launch association, rechecks control before dispatch, accepts authenticated late evidence without granting new work, observes actual termination, and retains unknown ownership. No handoff verifier means no automatic restart. Known-safe retry counts and no-progress observations persist across restarts. A stop timeout or missing PID alone never frees the writer.

## Knowledge and Git

The persistent project anchor owns only `.local/pi-kanban`; unrelated local notes are not imported. Immutable SHA-256 objects are published without overwriting existing objects and checked before use. Eligibility has independent evidence, source classification, exact target/environment/baseline and revocation history. The read-only GitHub adapter distinguishes mock responses from live observations and pins owner/repository/target/PR. Merge, final-content coverage, user acceptance and reusable knowledge remain separate facts.

The Git broker checks potentially executable configuration and hooks, exact branch/commit identities, user staging, private paths and file hashes before mutation. Baseline integration preserves conflicts and requires capability verification separately from ancestry or successful merge.
