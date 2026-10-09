# Local knowledge and bounded remote observations

## Trusted Host APIs

`new KnowledgeService({db,resolveStore,onBodyRead?,fault?})` uses the Host's `DatabaseSync` and per-project `ImmutableObjectStore`. SQL stores metadata, evidence, eligibility, run manifests and reads; body bytes have one immutable local source.

- `saveCandidate(CandidateInput)`: immutable revision identity, parent, origin demand/author, source kind, material kind, statement kind, target and role scope. Sibling revisions coexist. Saving or labeling content never makes it reusable.
- `recordEvidence(SourceEvidence)`: Q's independent reviewer records concrete references, source/content/reuse/applicability results and mixed-private-content checks. The original author cannot independently qualify their own material. This is a Host attestation API, not a model-provided completion flag.
- `registerEligibility(EligibilityInput)`: separate qualification for an exact target, baseline and environment, supported by actual capability evidence. Existing formal facts and independent environment experience need their own evidence; neither waits for the discovering demand to merge. Implementation knowledge additionally requires a live, correctly bound merged observation and separate final-code/revision correspondence. Mock observations cannot grant production implementation eligibility.
- `createContext(ContextInput)`: freezes a run capability after project, demand, role, explicit revision allowlist, target, exact-baseline and environment checks. Cross-demand bodies/titles never enter search before qualification. Same-demand candidates still require the explicit role/version allowlist.
- `read(contextId,revisionId,purpose?)`, `search(contextId,query,limit?)`: only immutable versions in that capability. Denials do not look up foreign body/title metadata. Reviewer contexts exclude implementation sessions and equivalent summaries even if requested in an allowlist. Searches run only over the permitted set; each actual body read is recorded.
- `invalidate({revisionId,reason,evidenceRef})`: preserves versions/history and revokes future or existing-context reads. It does not change project rules or rewrite frozen results.
- `verifyReferences(projectId)`: integrity findings with no fallback to a newer or similarly named file.

Callers must restrict context-creation, evidence and eligibility APIs to the Host. Workers receive only their specific context's read/search capability. Semantically correct source and capability attestations depend on independent Q verification; the storage layer cannot prove arbitrary prose true. Query matches and read counts are not evidence of real Agent reuse.

## GitHub read-only adapter

`GitHubReadOnlyAdapter({db,binding:{projectId,demandId,owner,repository,pullRequest,target},transport?,timeoutMs?})` exposes only `observe`, `observations` and `recordContentVerification`.

The built-in transport makes bounded, redirect-rejecting GET requests to fixed GitHub API paths. There is no arbitrary URL, token forwarding, comments-to-control, push, PR creation or merge operation. A supplied test transport forces `controlled-response` provenance. The built-in public read path has `github-live` provenance only for requests it actually makes; tests make no real network requests.

PR identity and target are checked. Merge commit existence and its containment in the observed target are verified independently of PR status. Unknown, open, closed-unmerged, wrong-target and merged observations remain distinct; failures do not erase historical facts. Merge observations do not grant acceptance or knowledge eligibility.

`recordContentVerification` stores Q's separate scoped code/capability evidence across accepted, submitted and final content. Different SHAs from squash/rebase are not automatically a mismatch. Acceptance coverage (`covered`, `gap`, `unknown`) is distinct from correspondence and knowledge suitability. Full live GitHub/Agent reuse remains blocked until an authorized test repository and execution combination exist.
