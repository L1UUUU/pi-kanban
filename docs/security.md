# Security model and limits

This is a fail-closed Node-native-tools prototype, not a security certification. The approved product profile has no shell. Legacy shell metadata may be retained for inspection, but it cannot enable execution.

## Protected boundaries

- A renderer may ask for an allowlisted user control. It cannot submit a Worker report or provide its own trusted principal.
- Ordinary chat is retained as information, not interpreted as permission to implement, spend, publish or accept.
- A Worker receives one run/role/generation and explicitly allowed materials. Different IDs in a payload do not establish an independent review.
- Review uses fresh native history and excludes implementation sessions and equivalent summaries.
- Local materials are immutable, digest-checked, path-confined and non-executable. Special files, links, path escape and oversize reads are rejected.
- Knowledge candidates are not shared by changing a label. Permissions and applicability are checked before retrieving bodies; invalidation revokes future reads without rewriting history.
- Runtime ownership is retained after ambiguous launch/stop/recovery. Only matching generation and verified descendant quiescence release it.
- Every broker request needs bounded authorization; retries and auxiliary operations consume the same budget. Unknown or cancelled-provider usage is retained rather than assumed free.

## Explicitly unsupported / blocked

- No unverified production Worker launch, OS-independent sandbox claim, arbitrary HTTP proxy, inherited model credentials or implicit global Pi resource discovery
- No automatic public sharing, push, PR, merge, deployment, destructive cleanup or credential creation by the application
- No Bash/POSIX commands, implicit system shell, npm-script shell fallback or arbitrary native CLI execution in the Node-only product scope
- No full support claim for Git hooks, signing, shell extensions, reparse variants, broad Windows capabilities, hard power loss or sleep/resume
- Hosted-Windows Node/Pi observations cover named probes only; complete target Windows 11 acceptance remains required
- No semantic guarantee that arbitrary text contains no secrets: only explicitly permitted material may enter a real model context
- No exact instantaneous spending cap promise; provider-reported overspend is recorded and blocks further requests

## Tests are scoped evidence

Domain tests use real SQLite and synthetic external observations. Git tests use real temporary repositories. Pi tests instantiate the installed SDK with a deterministic in-process transport. Linux process tests run real fixture parent/child processes but are not an isolation backend. Windows CTest probes exercise actual Win32 primitives when run on Windows; a passing smoke alone cannot release the full product G1 gate.

The independent source review and regression tests found and fixed boundary-review spoofing, replay drift, changed-review ID collisions, unsafe special-file reads, cross-project remote proof, stop/output races, stale UI snapshots and unbounded terminal retries. This is evidence of specific checks, not a claim that all vulnerabilities have been found.
