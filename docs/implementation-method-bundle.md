# implement-spec implementation and Review

Both phase selections use the pinned public `implement-spec` root through
`implement-spec-staged-v1`. This is an executable Host adapter, not concatenated
method text. The planning bundle and its existing snapshots are unchanged.

## Resource identity

The execution lock pins fourteen public files at upstream commit
`b0618bc436ad893b3c5e84e55fba86586d34a404`: implement-spec, TDD and its two
references, code-review, conditional codebase-design and its references, agent
metadata, the original invocation policy and MIT license. Eight files are new;
the union with planning is twenty files. Original bytes and invocation flags
remain intact. `implementation-provenance.json` records the execution closure.

The Host selects an exact step projection. Workers progressively load
`implement-spec`, then `tdd` for a writer or `code-review` for a reviewer. Owned
relative references are closed and digest-checked. The Host records each read
before releasing it and requires successful model delivery of both skill bodies
before admitting a stage handoff. Loading and reporting in one model response
does not establish that delivery. Ambient/global skills and arbitrary cross-skill
invocation are unavailable.

## Persisted local workflow

The Host binds the confirmed local spec, ticket graph, clause references, design,
testing seams, plan revision and separate implementation grant. It computes the
ready frontier and runs one eligible ticket at a time in the demand's existing
worktree. Each implementation records observed test evidence at approved seams.
Completion advances the local graph only after the native process tree stops and
resource grants are revoked.

After all tickets are done, Standards and Spec run in separate fresh read-only
contexts over identical frozen content K. They do not receive the implementation
conversation or each other's broad-review findings. Standards retains documented
violations separately from advisory smells; Spec cites the approved local spec.
The interface preserves both axes instead of combining their rankings.

Actionable findings and failed checks form an immutable repair scope. One writer
repairs it, followed by focused independent resolution and relevant checks.
Broad review is not recursively restarted after every ticket or fix. A
standards-only behavior-preserving repair may use passing regression receipts
without inventing a failing test; behavioral implementation/repair requires an
observed red-to-green cycle. Unresolved findings, missing evidence, exhausted
budget, changed authority or inability to prove stop block progress.

The existing final-design confirmation supplies approval for unchanged testing
seams. New behavior, scope, constraints or seam choices require user decisions.
No internal ticket split approval is added. Planning completion, model/data
permission, execution, local commits and acceptance remain separate decisions.

## Exact content and test evidence

Review compares the explicit verified ancestor baseline to the Host's immutable
source snapshot, including uncommitted additions, changes and deletions. The
comparison preserves exact text, binary identity and executable metadata. It
does not substitute a HEAD-only diff or commit merely to make review possible.
Missing spec, baseline or K, empty review changes, source drift, sensitive paths
and oversized material fail closed. Discovered repository standards are quoted
task data, never promoted into system instructions.

TDD receipts must come from the same authorized writer generation. A red test
must exit nonzero normally, then the identical command must exit zero after a
verified source change. Green receipts cover the final exact source files.
Timeouts, incomplete descendants and fabricated artifact bodies cannot stand in
for test execution. These observations establish command ordering and results;
independent review still evaluates test relevance and behavioral correctness.

## Explicit upstream adaptations

- Automatic invocation is limited to the Host-selected stage and frozen graph;
  original upstream user-only flags remain preserved as provenance.
- The local spec/ticket store replaces remote issue-tracker discovery and writes.
- Host frontier scheduling serializes tickets into one demand worktree. Workers
  cannot create/reset/merge branches or launch competing writers.
- Independent axes run in separate bounded contexts under the existing demand
  scheduler; no reviewer can write source or spawn a repair writer.
- The verified base-to-K comparison replaces upstream's HEAD-only shell diff.
- Local result recording replaces automatic push, PR creation/ready transitions,
  tracker closure and worktree cleanup. Those upstream instructions confer no
  authority here.
- Conditional codebase-design vocabulary is a Host-selected read-only reference
  within the writer's already approved method resources. Reading it needs no
  extra design decision; it cannot approve new seams, scope or additional agents.

Node-only tools, finite model grants, pause/cancel, actual-stop barriers and
immutable acceptance remain in force. Neither this method selection nor its
tests certify Windows 11 release readiness or real-model implementation quality.

See [configuration](configuration.md), [support limits](support-matrix.md), and
the [pinned upstream entry](https://github.com/mattpocock/skills/blob/b0618bc436ad893b3c5e84e55fba86586d34a404/skills/engineering/implement-spec/SKILL.md).
