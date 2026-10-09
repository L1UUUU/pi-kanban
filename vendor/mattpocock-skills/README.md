# Pinned public planning dependencies

Source: [mattpocock/skills at b0618bc436ad893b3c5e84e55fba86586d34a404](https://github.com/mattpocock/skills/tree/b0618bc436ad893b3c5e84e55fba86586d34a404).

The twelve original files listed in `provenance.json` are an exact byte-for-byte
subset of that public commit. Each record contains its original Git blob SHA,
byte length and independently calculated SHA-256. Their original directory
layout, frontmatter, `agents/openai.yaml`, invocation policy and MIT license
are preserved. The provenance test verifies all three identities.

Included closure:

- `skills/productivity/grilling/SKILL.md` and its agent metadata
- `skills/engineering/codebase-design/SKILL.md`, `DEEPENING.md`,
  `DESIGN-IT-TWICE.md`, and its agent metadata
- `skills/engineering/to-spec/SKILL.md` and its agent metadata
- `skills/engineering/to-tickets/SKILL.md` and its agent metadata
- `.agents/invocation.md` and `LICENSE`

The only local Markdown links in the four selected skills resolve within the
codebase-design directory. Those links and the links in both reference files
are closed by these files. Mentions of a project's glossary, ADRs, tracker or
spec are task inputs, not upstream dependencies. The human setup-skill pointers
do not authorize loading or executing the setup skill. No upstream scripts,
plugins, executable extensions or unrelated skills are included or executed.

The private planning entry is not vendored. Users configure its existing local
file and SHA-256. This directory contains no copy or translation of that entry.

Project-specific invocation and output-destination adaptations live separately
in [the adapter documentation](../../docs/planning-method-bundle.md) and
`src/agent/planning-skills.ts`; they do not modify upstream originals.
