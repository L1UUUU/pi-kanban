# Staged planning method resources

The `design-feature-staged-v1` adapter binds an explicitly selected private
planning entry to a complete, pinned public dependency bundle. It implements
resource loading; the Host planning flow owns state transitions, user decisions,
independent review, and implementation authorization.

## Explicit configuration and immutable identity

`bundledPlanningMethod(entry, vendorRoot)` in `src/host/configuration.ts` constructs
a `MethodSourceConfiguration` from an absolute local entry file reference
(`id`, `path`, SHA-256) and an explicitly selected absolute vendor directory.
It does not inspect ancestor directories, global skill installations or the
network. The helper names all twelve known public files directly. It does not
read or copy the private entry into the repository.

The configuration's `skillBundle` contains a portable, digest-locked resource
graph: every material has one identity, one relative path and one SHA-256;
each stage skill has its entry, original invocation metadata and owned
references; the original license and invocation policy are supporting material.
Every configured file must have exactly one place in this graph. Unknown
fields, missing resources, duplicate identities/paths, unpinned upstream
revisions, escaping paths and undisclosed overrides fail validation.

`loadMethods` checks regular local files, rejects symbolic links and changed
bytes, verifies exact UTF-8 round trips and enforces existing per-file/aggregate
bounds. It adds a canonical generated `<entry-id>:skill-bundle` material, whose
SHA-256 is an explicit snapshot dependency. The complete graph also participates
in the method digest. All approved input hashes therefore remain visible to
the Host's ordinary model-data approval and method-freezing mechanisms.

`resolvePlanningBundle(snapshot, materials)` reconstructs a bundle only from
that frozen snapshot and exact frozen material set. It verifies the method
digest, every dependency and the complete pinned reference closure. It never
consults the current configuration or the current filesystem. A changed source
file blocks a new load without rewriting existing frozen planning evidence.

## Stage projection and actual Pi integration

`projectPlanningSkillBundle(bundle, stage)` produces a bounded Worker payload.
It carries the selected entry, the active skill, its original agent policy and
its owned references. Other skills and supporting upstream documents remain
outside the payload. The active mapping is:

| Host run stage | Skill |
| --- | --- |
| facts | selected private design-feature entry |
| clarification | grilling |
| design | codebase-design |
| design-review | selected private design-feature entry |
| design-resolution | codebase-design |
| spec | to-spec |
| tickets | to-tickets |

Waiting for a human decision is not a Worker stage. Independent review receives
method rules and its narrow Host-selected data, never the planner conversation.

`createPlanningSkillSession(projection, { onRead })` provides actual Pi `Skill`
metadata, the two controlled tools, stage instructions and the primary read
identity. `explicitResourceLoader` exposes exactly that active skill through
Pi's real `getSkills` interface. It retains the original description and
`disableModelInvocation` value. Built-in slash-command expansion, implicit
filesystem readers, resource extension and ancestor/global discovery are not
enabled. The Host-selected skill is explicitly named by the adapter because
Pi correctly omits disabled skills from automatic skill prompting.

No method body is included in the initial system context. The model must call
`controlled_skill({name})` to receive the exact original active body. Upstream
instructions to use the Skill tool refer to this controlled tool in this
adapter. A different skill name is rejected. The session's `activeSkill` gives
`id`, `sha256`, `skillName` and portable `path`, and `hasLoadedPrimary()` records
whether its read audit succeeded. The Host additionally enforces persisted
primary-read evidence before accepting staged handoff reports. The Host also
requires a successful bounded model operation whose normalized context contains
the exact audited active skill tool result. A single response that batches a
skill load and a terminal report is rejected before artifact ingestion; it may
retry after the next model operation actually receives the skill. This proves
body delivery through the controlled channel, not semantic model adherence.

Staged `getAgentsFiles` is empty: Pi promotes those files into system
instructions, which is inappropriate for source text and generated planning
artifacts. The Worker supplies the exact approved stage data in an explicitly
labeled untrusted-data section of its initial user prompt. Artifact content
cannot supply additional skill, execution or approval authority.

`controlled_skill_resource({from,path})` follows a declared Markdown link from
a resource already loaded in this stage. Paths resolve in memory relative to
that resource and must stay inside its skill's owned directory and explicit
hash map. Absolute paths, URL schemes, UNC paths, backslashes, encoded aliases,
alternate streams, query/fragment inputs, unlisted resources and cross-stage
references are denied. Neither tool reads a file nor contacts a network.

The asynchronous `onRead` hook must succeed before exact body bytes are
returned. Production uses the authenticated Host bridge to record that read;
a failed receipt releases no body. Loading an optional reference is auditable
and does not authorize its execution or additional agents.

## Scoped adapter overrides

The upstream originals remain untouched, including both disabled invocation
flags for to-spec/to-tickets and the prohibition on other skills invoking
user-invoked skills. The manifest separately records these product adaptations:

1. `host-selected-stage`: the approved workflow explicitly permits the Host to
   select each stage automatically, including the private entry, to-spec and
   to-tickets. The model cannot invoke other stages or choose a new method.
2. `local-plan-artifacts`: spec and tickets use the Host's local versioned plan
   artifact destination. Original templates, vertical slicing, wide-refactor
   exceptions and dependency semantics remain in use; a remote tracker or setup
   skill is not required.
3. `agent-owned`: already approved internal technical ticket granularity and
   dependency splitting do not create another mandatory human approval step.

These overrides do not approve scope or behavioral tradeoffs, final design and
test seams, implementation, source execution, model use, data transmission,
budget increases, extra agent spending, commit or push. Valid human confirmations
are reused; unresolved consequential choices remain blocked. Reading the
optional DESIGN-IT-TWICE resource does not make a parallel design contest
mandatory or authorize one.

## Verification

`tests/planning-skills.test.ts` verifies the original Git blobs and SHA-256
locks, frozen reconstruction, active-stage metadata, policy preservation,
audit-before-release, owned relative references and unsafe-resolution failures.
Configuration tests cover the shared local-file and aggregate bounds. The
production journey suite exercises these tools through the installed Pi SDK
and authenticated Host frame protocol with deterministic model transport; it
does not claim native Windows isolation or live-provider verification.
