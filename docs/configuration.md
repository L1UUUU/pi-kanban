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

All listed keys are required. Unknown keys are rejected, including `authorized`,
`verified`, `executionEnabled`, `apiKey`, arbitrary headers, and authorization
IDs inside the provider configuration. Current schema version is exactly `1`.

The user’s actual `design-feature` content is **not supplied by this repository**.
Leave `methods.planning` null until the actual source and all its declared
transitive dependencies are available. The implementation and review stages may
use separately and explicitly named candidate methods. A logical method name or
a passing fixture is not evidence that the actual user method was validated.

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

A non-null `runtime` has these required fields:

- `profileId`: stable identifier.
- `osBuild`: exact Windows release string, or null.
- `arch`: `x64`, or null.
- `node`, `helper`, `worker`: null, or objects with `id`, absolute `path`, exact
  semantic `version`, and `sha256`. Node must pin a Node 24 version.
- `pi`: null, or the same file-reference fields plus
  `package: "@earendil-works/pi-coding-agent"` and an exact version.
- `policySha256`: exact lowercase SHA-256, or null.
- `evidence`: required object with `privateChannel`, `filesystem`, `processTree`
  and `network`. Each is null or an explicit `{id,path,sha256}` file reference.

The settings inspection hashes each selected runtime artifact and evidence
file. An individual artifact is bounded to 256 MiB; an evidence reference is
bounded to 128 KiB at this settings boundary. These are binary/artifact locks,
not evidence inferred from their filenames or claimed version strings.

`runtimeProfileInput(config)` transforms the values to the native verifier’s
input: it removes the display IDs on binary locks and lists the four evidence
references. `verifyWindowsRuntimeProfile(input, trustedEvidenceRoot)` owns the
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
provider prerequisites, endpoint/credential-reference validation, finite
limits, separate trusted decision checks, stable summaries, atomic persistence,
revision conflicts and corrupted state.

These tests do not certify the actual user `design-feature` method, Windows
isolation, real provider egress, paid usage or G1–G5 completion.
