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
`runtime.shell` and `runtime.policyVariant` fields described below. Unknown keys are rejected, including `authorized`,
`verified`, `executionEnabled`, `apiKey`, arbitrary headers, and authorization
IDs inside the provider configuration. Current schema version is exactly `1`.

The user’s actual `design-feature` content is **not supplied by this repository**.
Leave `methods.planning` null until the actual source and all its declared
transitive dependencies are available. The implementation and review stages may
use separately and explicitly named candidate methods. A logical method name or
a passing fixture is not evidence that the actual user method was validated.

This repository supplies two new, explicitly named candidates:
[implementation-candidate-v1](../methods/implementation-candidate-v1.md) and
[review-candidate-v1](../methods/review-candidate-v1.md). They implement the
documented scope, verification and independent-review conventions as text methods;
they are not the user's preexisting methods and have not been evaluated with a
paid model. Select and hash them explicitly if desired, with `dependencies: []`.
The Host's report adapter supplies the concrete role-specific protocol separately,
so external methods do not need to guess report fields or native evidence IDs.

## Exact method sources

Each non-null method has this shape (illustrative paths and hashes must be
replaced with the actual file selections and hashes):

```json
{
  "id": "user-design-feature",
  "logicalName": "design-feature",
  "version": "2026-10-08",
  "adapter": "explicit-text-v1",
  "path": "C:\\Methods\\design-feature\\SKILL.md",
  "sha256": "<64 lowercase hexadecimal characters>",
  "dependencies": [
    {
      "id": "design-boundaries",
      "path": "C:\\Methods\\design-feature\\boundaries.md",
      "sha256": "<64 lowercase hexadecimal characters>"
    }
  ]
}
```

- Planning requires the logical name `design-feature`.
- Implementation and review require explicit logical names, e.g.
  `implementation-candidate-v1` and `independent-review-candidate-v1`.
- Every method declares `dependencies`, including `[]` when none are needed.
  Declare **all** files the method requires, including transitive dependencies.
  The loader follows no textual links, shell paths, imports, extension files,
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
- `shell`: null, or an explicitly locked Git Bash executable and manifest as
  described below. Older schema-v1 documents may omit this field; parsing
  canonicalizes omission to null. There is no default shell or PATH discovery.
- `policyVariant`: optional exact enum `lpac-strict-v1`,
  `lpac-registry-read-no-network-v2` or `appcontainer-no-network-v3`. Omission
  canonicalizes to `lpac-strict-v1`. Null, unknown values and automatic selection
  are rejected. The registry-read variant explicitly adds that capability to
  LPAC while retaining network denial. It remains a diagnostic candidate with
  observed compatibility failures, not a verified production profile. The
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

Evidence binds the exact OS build, runtime artifacts, policy variant and optional
shell manifest. It must cover permitted work, role restrictions, cross-demand
and shared-Git denial, Host/private-channel boundaries, real network denial,
descendant termination, helper closure, reparse handling and role transition.
Changing a bound artifact or capability policy invalidates the old evidence.
The repository's CI recorder reports partial observations with
`releaseAuthorized: false`; its output is intentionally insufficient to enable
production. Target-machine validation and independent release authorization
remain required.

### Optional locked Git Bash

The shell is an additional explicit runtime artifact. This example is a schema
illustration only; substitute the selected installation's exact version and
hashes. Importing it neither runs Bash nor authorizes a command.

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
artifact is bounded to 256 MiB, with a 1 GiB total. Inspection verifies the
manifest and all listed hashes, rejects duplicate paths, traversal, aliases,
symlinks and junctions, and never scans PATH or launches a process. A changed
manifest or dependency invalidates the lock even if Bash itself is unchanged.
Unknown fields, credential values, authorization flags and custom launch
arguments are not supported.

`runtimeProfileInput` passes the exact executable and manifest locks to the
independent native verifier without display IDs. Missing/null shell is omitted
from the native profile and cannot enable shell tools. A configured shell stays
unverified until authenticated evidence covers its exact executable, manifest,
dependencies and actual Git Bash probe on the current Windows host. A generic
process-spawn result, a version string or synthetic fixture is not such proof.
The native runner fixes startup arguments to disable profile and rc-file
loading; arbitrary shell fallback is unsupported. Separate role, workspace,
process-tree, resource-budget and command checks still apply before use.

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
  material set inside the same verified isolated run. It does not include new
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
