# Explicit runtime, method and provider settings

`src/host/configuration.ts` is the Host-only settings boundary. It reads and
validates real, explicitly selected files; it does not discover global skills,
resolve credential values, call a model, install software or authorize execution.

The configuration is versioned JSON. The desktop imports it through the native
file picker; the Host copies the validated values to its own application-data
folder as `configuration.v1.json`. No path in the imported JSON can redirect this
storage location. The public configuration summary is serializable and includes
the editable values, the configuration digest, method snapshot hashes, missing
prerequisites, and separate runtime/provider states.

## Start with unknown values

This complete minimal file is valid. Unknown values stay unknown; none means
unlimited, approved, a default provider, a working method or verified isolation.

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "runtime": null,
  "methods": {
    "planning": null,
    "implementation": null,
    "review": null
  },
  "provider": null
}
```

All listed keys are required, except the backward-compatible optional
`runtime.shell`, `runtime.policyVariant`, and conditional method `skillBundle`
and `executionBundle` fields described below. Unknown keys are rejected, including `authorized`,
`verified`, `executionEnabled`, `apiKey`, arbitrary headers, and authorization
IDs inside the provider configuration. Current schema version is exactly `1`.

The user’s actual `design-feature` content is **not supplied by this repository**.
Leave `methods.planning` null until the actual source and its explicit
digest-locked graph are selected. The public downstream closure is supplied in
`vendor/mattpocock-skills`, pinned to commit
`b0618bc436ad893b3c5e84e55fba86586d34a404`; no private entry is included.

Production implementation and Review both select the public `implement-spec`
root with `implement-spec-staged-v1`. Implementation projects `tdd` and scoped
fix work; Review projects `code-review` into fresh independent read-only
contexts. These share an explicit fourteen-file execution closure, separately
locked from the unchanged planning `skillBundle`. Importing either selection
only verifies resources. It does not grant invocation, model, spending, data
transmission, workspace-write, publication or runtime privileges.

The older [implementation-candidate-v1](../methods/implementation-candidate-v1.md)
and [review-candidate-v1](../methods/review-candidate-v1.md) text selections remain
inspectable for compatibility and deterministic fixtures. They cannot substitute
for the staged production adapter. The product does not concatenate candidate
text or use static text as a fallback when the selected closure is missing.

## Exact method sources

Legacy inspectable text methods use this shape (illustrative paths and hashes
must be replaced with actual file selections and hashes; this does not enable
staged production execution):

```json
{
  "id": "selected-implementation",
  "logicalName": "implementation-candidate-v1",
  "version": "2026-10-08",
  "adapter": "explicit-text-v1",
  "path": "C:\\Methods\\implementation-candidate-v1.md",
  "sha256": "<64 lowercase hexadecimal characters>",
  "dependencies": []
}
```

- Production planning requires logical name `design-feature`, adapter
  `design-feature-staged-v1`, and its explicit `skillBundle`. An old
  `explicit-text-v1` planning selection can remain inspectable, but the production
  dispatcher blocks it. Legacy synthetic fixtures do not establish production
  compatibility.
- Production implementation and Review require logical name `implement-spec`,
  adapter `implement-spec-staged-v1`, and their explicit `executionBundle`. Each
  stage selects this root; `tdd` and `code-review` are stage projections rather
  than alternative root methods. Legacy text sources remain inspectable only.
- Every method declares `dependencies`, including `[]` when none are needed.
  Declare **all** files the method requires, including transitive dependencies.
  The file loader follows no textual links, shell paths, imports, extension files,
  ancestor `AGENTS.md`, global settings or user skill directories.
- Paths are exact, absolute and local. Relative paths, `..`, UNC/device aliases,
  alternate streams, symbolic links and directory junctions are rejected.
- Files must be regular UTF-8 text, nonempty, without NUL or a byte-order mark.
  The bound is 1 MiB per file, 64 dependencies per method, and 8 MiB total across
  the three stages. No directories, pipes, device nodes or oversized files are
  loaded. A symlink in an ancestor is also rejected.
- File bytes must match each SHA-256. The `MethodSnapshot.digest` additionally
  covers method ID, logical name, version, adapter, main-file digest and **every**
  dependency ID/digest in stable sorted order. Declared dependency order does not
  change the snapshot. Changed dependencies require a new snapshot.
- A material ID cannot refer to different files or revisions in different
  stages. Reusing the same explicitly declared dependency is supported.
- Each stage receives fresh `AgentMaterial` objects with exact content hashes;
  a failed stage gets no partial material. The explicit Pi resource loader still
  enforces its independent role/resource restrictions.

### Staged planning bundle

Use the exported `bundledPlanningMethod(entry, vendorRoot)` constructor to build
the planning configuration from the user's exact `{id,path,sha256}` entry
reference and an explicit absolute path to `vendor/mattpocock-skills`. Serialize
the resulting object as `methods.planning`; the ordinary configuration import
validates it. The helper names the twelve pinned files directly and performs no
global discovery. The private entry is read only from its selected external path.

The `skillBundle` graph maps every material ID and SHA-256 to a portable relative
resource path. Each of the four stage skills names its entry, original
`agents/openai.yaml` and owned references; license and invocation-policy files
are explicit supporting resources. The graph records the scoped automatic Host
invocation, local artifact destination and agent-owned internal split overrides.
Neither a new upstream revision nor changed invocation metadata is accepted by
editing a hash in settings. See [the complete adapter contract](planning-method-bundle.md).

Loading freezes the full graph and adds the generated `<entry-id>:skill-bundle`
material to the method snapshot's explicit dependencies. Its bytes count toward
the aggregate material bound. The generated identity is reserved across all
configured stages. Restart reconstructs the selected graph from frozen evidence,
not current files or settings.

The initial model context receives no method body. Pi registers only the active
skill metadata; `controlled_skill` and `controlled_skill_resource` release exact
bodies only after an authenticated Host read receipt. Relative references are
restricted to declared links inside the active skill's pinned closure. Other
stage bodies, global skills and scripts cannot be loaded through these tools.
Source and planning artifacts travel as labeled task data, not `AGENTS.md`
system instructions.

### Staged implementation and Review bundle

Use `bundledImplementationMethod(vendorRoot)` with the explicit absolute path to
`vendor/mattpocock-skills`, then serialize its output in both
`methods.implementation` and `methods.review`:

```ts
const selected = bundledImplementationMethod(absoluteVendorRoot);
configuration.methods.implementation = selected;
configuration.methods.review = structuredClone(selected);
```

This helper constructs references without scanning or reading a directory. Its
root is exactly `skills/engineering/implement-spec/SKILL.md`, with the pinned
upstream bytes. `executionBundle` declares fourteen resources: `implement-spec`,
`tdd`, `code-review`, `codebase-design`, each original `agents/openai.yaml`, TDD
and codebase-design references, license, and invocation policy. Thirteen files
are declared dependencies; loading adds a generated `<entry-id>:skill-bundle`
manifest as the fourteenth dependency. The generated identity is reserved across
all stages. Shared exact public resources may have the same identity and file
reference across planning, implementation and Review.

`executionBundle` is not accepted on planning or on a legacy adapter, and
`skillBundle` remains planning-only. The parser verifies stage, adapter, logical
root, complete resource graph, every reference identity and pinned digest.
Changing a resource hash, stage mapping, root or adapter override cannot silently
select another upstream method. Load failure exposes no partial materials for
the affected stage. Method snapshots bind the complete execution graph, not just
the root text; restart uses the frozen snapshot rather than following changed
settings. The private planning entry stays at its external user-selected path
and is never copied into the public bundle or exposed to these phases.

At runtime the selected root governs the workflow, while the current substep
gets only its permitted resource projection through authenticated progressive
reads. An implementation writer uses TDD evidence for eligible tickets in the
persisted dependency graph. Once all tickets are done, fresh read-only contexts
review the entire Spec on two axes: project standards and Spec consistency.
Every review binds exact content K. Standards findings distinguish a documented
violation, including its cited basis, from a design smell. Original review
records are immutable and retain their original content version.

A single implementation context repairs the explicit set of findings and
related check failures. The following read-only resolution records state the
outcome and evidence for those exact findings at the new content K. They do not
silently rewrite original reviews or start an unrestricted review loop. Changes
to scope, interfaces or testing seams require an explicit product decision and
revision/confirmation of the affected design. Closing a decision item alone
does not authorize a design change.

The Execution tab displays persisted ticket progress and eligible frontier,
whole-Spec axis evidence, current/historical K, scoped repair and focused
resolutions. Eligibility does not imply that a run is active or authorized;
missing graph data is shown as unknown. Pauses, prior rounds, failed checks and
user decisions remain visible through the existing controls and evidence views.
The adapter's destination override is local results only: no push, PR creation,
merge, deployment or ready-for-publication declaration is performed. Original
upstream invocation metadata is preserved, and only explicit adapter-scoped
invocation is supported; no generic invocation rights are inferred.

To compute a hash without executing the file, Node 24 can be used locally:

```sh
node --input-type=module -e "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "C:\Methods\design-feature\SKILL.md"
```

Method bodies and credential values are not included in the UI summary.

## Runtime input and independent native evidence

A non-null `runtime` has these fields (required unless marked optional):

- `profileId`: stable identifier.
- `osBuild`: exact Windows release string, or null.
- `arch`: `x64`, or null.
- `node`, `helper`, `worker`: null, or objects with `id`, absolute `path`, exact
  semantic `version`, and `sha256`. Node must pin a Node 24 version.
- `pi`: null, or the same file-reference fields plus
  `package: "@earendil-works/pi-coding-agent"` and an exact version.
- `shell`: **null for the approved Node-only product scope**. Older schema-v1
  documents may omit this field; parsing canonicalizes omission to null. A legacy
  non-null Git Bash selection can remain visible for inspection but blocks product
  execution and must be cleared. It never becomes a supported optional runtime.
  There is no default shell or PATH discovery.
- `policyVariant`: optional exact enum `lpac-strict-v1`,
  `lpac-registry-read-no-network-v2` or `appcontainer-no-network-v3`. Omission
  canonicalizes to `lpac-strict-v1`. Null, unknown values and automatic selection
  are rejected. The registry-read variant explicitly adds that capability to
  LPAC while retaining network denial. It remains a diagnostic candidate with
  actual hosted-Windows Node/Pi observations, not a verified production profile. The
  standard AppContainer candidate selects `appcontainer-no-network-v3`, with no
  network capability and no filesystem-root ACL grant. Neither alternate policy
  is ever selected after another policy fails. Selection is preserved in
  settings, the configuration digest, the UI summary and native verifier input.
  Signed evidence must bind that exact policy; evidence from either LPAC variant
  cannot authorize the standard AppContainer candidate, or vice versa. All
  candidates still require independent target-machine validation before use.
- `policySha256`: exact lowercase SHA-256, or null.
- `evidence`: required object with `privateChannel`, `filesystem`, `processTree`
  and `network`. Each is null or an explicit `{id,path,sha256}` file reference.

The settings inspection hashes each selected runtime artifact and evidence
file. An individual artifact is bounded to 256 MiB; an evidence reference is
bounded to 128 KiB at this settings boundary. These are binary/artifact locks,
not evidence inferred from their filenames or claimed version strings.

`runtimeProfileInput(config)` transforms the values to the native verifier’s
input: it removes the display IDs on binary locks and lists the four evidence
references. `verifyWindowsRuntimeProfile(input, trustedEvidenceRoot, trustAnchor)` owns the
separate machine/artifact/probe verification. Only that verifier may construct
an executable verified-profile instance. Evidence must originate in the
Host-owned evidence directory and apply to the exact machine and artifact
hashes. Configuration references alone cannot prove AppContainer, Job Object,
network, IPC, descendant-stop, reparse or role-transition behavior.

`ConfigurationSummary.runtime.status` is one of `missing`, `invalid`, or
`configured-unverified`. Even a complete settings file has
`executionEnabled: false` in the configuration inspection. The actual execution
coordinator must independently establish current isolation, workspace, grant,
method, private-channel and process-control prerequisites before a launch.
There is no unrestricted-platform fallback.

### Independently trusted native evidence

The runtime verifier requires Ed25519-signed observations from a separately
trusted Host recorder. An adjacent public key, a user-edited all-pass JSON file,
or an artifact hash alone cannot establish that trust. The two-argument verifier
form deliberately remains closed.

An operator-provisioned Host installation supplies the fixed file
`windows-evidence-trust.json` with `schemaVersion: 1`, `keyId`, `publicKeyPem` and
`recorderSha256`. Its digest is independently pinned at trusted application
startup. `PI_KANBAN_RUNTIME_TRUST_DIR` and `PI_KANBAN_RUNTIME_TRUST_SHA256` select
that installation directory and exact digest; these fields are never accepted
from renderer IPC, project configuration, a Worker, or an adjacent digest file.
Only public verification material belongs in this file. Signing keys must stay
with the independently controlled recorder and are never created or imported by
configuration loading.

Evidence binds the exact OS build, runtime artifacts, policy variant and absence
of shell authority in the Node-only product. Legacy diagnostic signatures can also bind a shell manifest, but cannot enable the product. It must cover permitted work, role restrictions, cross-demand
and shared-Git denial, Host/private-channel boundaries, real network denial,
descendant termination, helper closure, reparse handling and role transition.
Changing a bound artifact or capability policy invalidates the old evidence.
The repository's CI recorder reports partial observations with
`releaseAuthorized: false`; its output is intentionally insufficient to enable
production. Target-machine validation and independent release authorization
remain required.

### Unsupported legacy Git Bash metadata

The approved first product scope excludes Git Bash. **Do not add this selection to
a Node-only configuration; set `runtime.shell` to null.** The following schema is
retained only to inspect old configurations and reproduce separately labeled
unsupported-feature diagnostics. It is not an optional production feature.
Importing it neither runs Bash nor authorizes a command, and inspection reports a
blocking unsupported selection even if all hashes are valid.

```json
{
  "id": "approved-git-bash",
  "kind": "git-bash",
  "path": "C:\\ApprovedGit\\usr\\bin\\bash.exe",
  "version": "5.2.37",
  "sha256": "<64 lowercase hexadecimal characters>",
  "manifest": {
    "id": "approved-git-bash-artifacts",
    "path": "C:\\WorkbenchHost\\git-bash-manifest.json",
    "sha256": "<64 lowercase hexadecimal characters>"
  }
}
```

The separately hashed UTF-8 JSON manifest has exactly this structure:

```json
{
  "schemaVersion": 1,
  "rootPath": "C:\\ApprovedGit",
  "files": [
    {
      "path": "C:\\ApprovedGit\\usr\\bin\\bash.exe",
      "sha256": "<same executable SHA-256 as runtime.shell>"
    },
    {
      "path": "C:\\ApprovedGit\\usr\\bin\\msys-2.0.dll",
      "sha256": "<exact dependency SHA-256>"
    }
  ]
}
```

This abbreviated example is not a complete Git for Windows dependency list.
List every approved executable, DLL and other runtime file required by the
selected installation and supported commands. Entries are exact regular files;
the manifest must include the selected Bash executable with its matching hash.
Every entry must be strictly inside the explicit canonical installation root.
The root must be a directory below the filesystem root. It defines containment
only and does not grant access to that directory, its parents, or unlisted
files. The manifest itself may be stored outside the installation root as
Host-managed metadata.

The manifest is bounded separately to 4 MiB and at most 512 entries; it is never
embedded into or allowed to enlarge the 128 KiB settings file. Each listed
artifact is bounded to 256 MiB, with a 1 GiB total. The retained diagnostic manifest
parser verifies the manifest and all listed hashes, rejects duplicate paths, traversal, aliases,
symlinks and junctions, and never scans PATH or launches a process. A changed
manifest or dependency invalidates the lock even if Bash itself is unchanged.
Unknown fields, credential values, authorization flags and custom launch
arguments are not supported. Product configuration inspection reports an unsupported
shell selection without opening the shell executable or its manifest dependencies.

`runtimeProfileInput` rejects a non-null shell selection. The independent runtime
verifier, Host command dispatch and Worker bootstrap also reject shell authority.
Missing/null shell is omitted from the native profile and advertises no shell tool.
The retained native diagnostic adapter fixes startup arguments and exact dependency
locks, but its failing MSYS compatibility probe cannot authorize product execution.
The [support matrix](support-matrix.md) describes applicable direct Node commands.

## Provider selection and finite proposal

A provider proposal pins its destination exactly. This synthetic example makes
no calls and contains no credential value:

```json
{
  "provider": "synthetic",
  "modelId": "fixture-v1",
  "destination": "https://synthetic.invalid/v1/messages",
  "credentialRef": "env:PI_KANBAN_TEST_CREDENTIAL",
  "contextPolicy": "exact-materials-only",
  "data": [
    { "id": "synthetic-material", "sha256": "<64 lowercase hexadecimal characters>" }
  ],
  "allowedRoles": ["planning", "boundary-review", "implementation", "review"],
  "limits": {
    "maxRequests": 4,
    "maxTokens": 400,
    "maxCostMicros": 4000,
    "currency": "USD",
    "expiresAt": "2026-12-01T00:00:00.000Z",
    "meteringPolicy": "synthetic-v1"
  }
}
```

Requirements before producing a grant:

- Exact provider, model ID and canonical HTTPS destination, without user info,
  query parameters or a fragment. The URL is never inferred from the provider.
- `credentialRef` is `env:UPPERCASE_NAME` or `host:credential-name`. It may be
  null while configuring. The settings layer never reads environment variables
  or secrets. Never put a key, token, password or credential URL in this file.
- An explicit immutable `data` allowlist with non-conflicting IDs and hashes.
  Empty lists do not mean all data. A later changed hash is a different version
  and requires its own data permission.
- Explicit `contextPolicy`: `exact-materials-only` permits only the listed exact
  materials. `approved-run-derived-v1` additionally proposes transmission of the
  generated conversation and tool results derived from that exact initial
  material set inside verified isolated runs for the approved demand. For staged
  planning this includes verified local artifacts passed into the next fresh
  stage context. It does not include new
  arbitrary sources or another project. Null means unknown and blocks grant
  creation. The chosen scope must be displayed in the separate user approval;
  a configuration file cannot approve this transmission.
- Explicit roles from planning, implementation, review, boundary-review and
  check. Empty lists do not mean every role.
- `limits` may be null while configuring. Before use, requests, tokens and cost
  must be positive finite safe integers. Cost is in millionths of the selected
  three-letter uppercase currency. Expiration is an exact UTC ISO timestamp
  and must still be in the future. A metering-policy identifier is mandatory.
- Expired proposals may be loaded for inspection, but cannot create a grant.
  Restart, resume and re-import do not add budget or extend expiration.

Staged planning requires both `planning` and `boundary-review` roles and the
explicit `approved-run-derived-v1` policy. The initial candidate lists the full
frozen method closure, even though each Worker receives only its active stage
resources. Human answers, requirement confirmation, final-design confirmation
and revision instructions change the exact planning-input digest. A previous
grant does not automatically cover those new bytes: prepare and approve the
current exact data candidate before the next model request. This data/spend
authorization is separate from both product decisions and implementation consent.

`createModelGrant(config, {id,demandId,decisionId}, trustedAuthorizer)` constructs
an exact deeply frozen candidate and calls a **separately supplied synchronous
Host verifier**. The verifier must match a persisted authenticated user decision
for the exact demand, provider/model/destination, data, context policy, roles and finite limits.
It must reject absent approval. Merely possessing a `decisionId` is not approval.
An asynchronous/unawaited verifier or boolean-returning predicate is rejected;
the trusted verifier must complete normally without returning a value or throw
a denial. No callback comes from JSON,
Worker messages or renderer JavaScript.

After that check, the grant still goes through `ModelBudgetLedger.grant` and its
own trusted authorization adapter. The real Pi-ai transport requires its supported `pi-ai-cost-v1` metering policy
and exact registry model/endpoint binding; an arbitrary policy identifier is not
evidence of a usable transport. Real provider transports, credential
resolution and outbound runtime evidence are separate requirements. The
configuration module does not make paid calls or record any real-world user
approval. The desktop must clearly show the proposed data and finite spending
before its separate authorization action.

## Persistence, imports and inspection

- `new ConfigurationStore(appOwnedDirectory)` takes its path from trusted Host
  bootstrap code. Config JSON cannot choose the application-data directory.
- `load()` returns the empty schema only when the settings file is absent. An
  invalid schema or corrupted file throws; `inspect()` exposes an invalid source
  state and blockers instead of crashing the settings UI.
- `save(input)` validates the entire proposed document before mutation. It
  requires the current revision, advances it by one, writes a unique mode-0600
  temporary file, flushes it, and atomically renames it over the previous file.
  POSIX also flushes the containing directory. Windows directory-flush crash
  durability remains part of native validation; it is not claimed by Node here.
  The application-owned directory must not be a link or group/world writable.
- The Host is the single settings writer. Revision checks prevent stale UI
  overwrites. Invalid or stale saves leave the existing file intact.
- `importFromFile(path)` validates a bounded regular JSON file and copies it into
  app-owned storage. An imported revision cannot replace local revision history.
- Configurations are bounded to 128 KiB, including the serialized persisted
  representation. Imports, persistence, method loading and artifact inspection
  do not modify the imported files.
- Corrupt persisted settings are visibly blocked and not silently reset or
  overwritten. Recover through an explicit administrator/user repair of the
  application settings file; the app does not infer what missing values meant.

## Verification covered

`node --test tests/configuration.test.ts` uses only synthetic temporary files.
It covers missing settings, strict schema/no authorization flags, dependency
hashing and stale files, missing/oversized/invalid-text materials, symlink and
junction aliases, no global resource discovery, pinned runtime hashes, unknown
shell kinds and version ranges, manifest bounds, dependency mutations,
missing executable entries, duplicate and outside-root shell paths, unknown
provider prerequisites, endpoint/credential-reference validation, finite
limits, separate trusted decision checks, stable summaries, atomic persistence,
revision conflicts and corrupted state.

These tests do not certify the actual user `design-feature` method, Windows
isolation, real provider egress, paid usage or G1–G5 completion.

`tests/planning-skills.test.ts` additionally checks the actual pinned public Git
blobs, complete frozen graph, stage isolation, original invocation flags,
unsafe-reference failures and progressive tool loading through installed Pi.
The staged production journey uses those public files with a synthetic private
entry and deterministic transport. An external private entry can be locally
validated without copying it into the test suite; validation of its bytes is
not a real-model planning run. CI for the new final commit remains to be checked.

`tests/configuration-execution.test.ts` verifies the actual public execution
closure in both phase selections, stage/adapter/root/digest rejection, reserved
manifest identities, stale-file fail-closed behavior and preservation of the
external private planning entry. `tests/execution-renderer.test.ts` verifies the
actual renderer's exact-content labeling, dependent-ticket eligibility, separate
violation/smell presentation, focused resolution, history and explicit decisions.
These are local contract/UI checks and do not establish real-model quality or
Windows runtime isolation.
