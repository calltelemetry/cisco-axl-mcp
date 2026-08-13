# Schema-Driven Cisco AXL CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, schema-driven `cisco-axl` CLI beside the existing MCP server while preserving public MCP compatibility and establishing complete version-aware AXL schema metadata.

**Architecture:** The package will expose `cisco-axl-mcp` and `cisco-axl` as separate import-safe entrypoints over one AXL service/runner. Generated WSDL metadata is the source of operation/version/schema truth; the CLI adapter adds strict validation and mutation grants while the existing MCP adapter retains its compatible raw-operation contract. Private CallTelemetry workflows and A2A are follow-on consumers, not part of this public package.

**Tech Stack:** TypeScript, Node.js 18+, Vite/Rollup, Zod 4, Vitest, strong-soap, Cisco AXL WSDLs from `cisco-axl`, MCP stdio transport.

## Global Constraints

- `ct-cli` remains appliance-only and receives no AXL management commands.
- The public MCP surface remains the seven generic tools: `axl_execute`, `axl_describe_operation`, `axl_list_objects`, `axl_list_operations`, `axl_list_action_operations`, `axl_sql_query`, and `axl_sql_update`.
- `OPERATIONS_BY_VERSION` and the schema map are explicit generated artifacts for every supported version: `11.0`, `11.5`, `12.0`, `12.5`, `14.0`, and `15.0`.
- Generated metadata represents XSD choices, arrays and array items, occurrence bounds, nillability, enums, and documented opaque vendor content; unsupported features fail generation rather than being silently dropped.
- Golden generator tests cover CUCM 11.5 and 15.0, including `listCallManager`, `getCallManager` identifier choices, `updateEnterprisePhoneConfig`, action operations, arrays, and vendor configuration fields.
- The public MCP uses `validationMode: "compatible"`; CLI/workflow/A2A callers use `validationMode: "strict"` and caller-specific mutation grants.
- Shared execution has the shape:

  ```ts
  runAxl({
    request,
    source: "mcp" | "cli" | "workflow" | "a2a",
    validationMode: "compatible" | "strict",
    mutationGrant,
  });
  ```

- Secrets never appear in CLI arguments, MCP results, A2A artifacts, logs, audit records, SOAP faults, or error strings; client cache keys contain no plaintext passwords.
- The CLI has an explicit secure TLS default; insecure certificate verification is opt-in and visibly reported, never a process-wide silent default.
- CLI stdout is pure `cisco-axl.cli.v1` JSON, diagnostics use stderr, and exit codes are stable: `0` success, `2` input/schema failure, `3` unsupported capability, `4` authentication/transport/AXL failure, and `5` policy or mutation-grant rejection.
- Writes require a target-bound, schema/package-bound, expiry-bound mutation grant; preview apply rejects target drift and replay.
- All changes are tested at exact branch head, and clean-package execution proves both binaries after packing.

---

### Task 1: Complete the generated versioned AXL schema contract

**Files:**
- Modify: `scripts/generate-types.ts`
- Modify: `src/types/generated/wsdl-support.ts` (generated output)
- Modify: `src/types/generated/axl-objects.ts` (generated output)
- Modify: `src/types/generated/axl-operation-schemas.ts` (generated output)
- Modify: `generated/axl-top-level-objects.json` (generated output)
- Create: `test/generate-types.test.ts`
- Create: `test/fixtures/generator/11.5/` and `test/fixtures/generator/15.0/` only if focused fixture copies are required by the repository's test pattern

**Interfaces:**
- Consumes: versioned `node_modules/cisco-axl/schema/<version>/AXLAPI.wsdl` and `AXLEnums.xsd` inputs.
- Produces: deterministic generated exports for `OPERATIONS_BY_VERSION`, version-to-schema mapping/digests, operation metadata, and field schema nodes with choice, array, occurrence, nillable, enum, and opaque-content semantics.

- [ ] **Step 1: Add failing generator contract tests.** Assert that generated metadata contains all six supported versions, that `listCallManager`, `getCallManager`, `updateEnterprisePhoneConfig`, and action operations are present in their actual version catalogs, and that 11.5/15.0 schema snapshots preserve identifier choices, repeated elements, nillability, enums, and `XVendorConfig` as explicit opaque content.
- [ ] **Step 2: Run the focused generator tests and confirm they fail against the current latest-WSDL/CRUD-only generator.**

  Run: `yarn vitest run test/generate-types.test.ts`

  Expected: FAIL because current output is latest-version-only for schemas and loses choice/array semantics.

- [ ] **Step 3: Replace latest-only operation extraction with per-version generation.** Iterate every supported WSDL, emit `OPERATIONS_BY_VERSION`, retain object/action discovery per version, and include operations outside the full-CRUD subset. Keep generated ordering stable and include source WSDL version plus content digests.
- [ ] **Step 4: Extend the intermediate schema model.** Represent `choice`, `items`, `minOccurs`, `maxOccurs`, `nillable`, enums, and an explicit `opaque` node for vendor extension content. Remove the hard depth-3 truncation; recurse through named complex types with cycle protection and fail generation when a construct has no safe representation.
- [ ] **Step 5: Generate the new artifacts and update the tests to compare deterministic snapshots/digests.** Confirm `getCallManager` does not incorrectly require both mutually exclusive identifiers and that array item schemas are present.
- [ ] **Step 6: Run the focused tests, typecheck, and generator reproducibility check.**

  Run: `yarn vitest run test/generate-types.test.ts && yarn typecheck && yarn generate:types && git diff --exit-code src/types/generated generated`

- [ ] **Step 7: Commit.**

  ```bash
  git add scripts/generate-types.ts src/types/generated generated test/generate-types.test.ts test/fixtures/generator
  git commit -m "feat: generate versioned AXL operation schemas"
  ```

### Task 2: Add the policy-aware shared AXL runner and credential-safe auditing

**Files:**
- Create: `src/lib/axl-runner.ts`
- Create: `src/lib/mutation-grants.ts`
- Modify: `src/lib/audit-log.ts`
- Modify: `src/lib/axl-client.ts`
- Modify: `src/services/axl/index.ts`
- Modify: `src/types/axl/errors.ts`
- Create: `test/axl-runner.test.ts`
- Modify: `test/audit-log.test.ts`
- Modify: `test/axl-client.test.ts`

**Interfaces:**
- Consumes: generated operation/version catalog from Task 1 and existing `AxlAPIService` retry/pagination behavior.
- Produces: `runAxl({ request, source, validationMode, mutationGrant })`, strict/compatible policy separation, recursive redaction, metadata-first audit records, and cache keys that do not contain passwords.

- [ ] **Step 1: Write failing tests** for compatible MCP execution, strict CLI rejection, target-bound mutation grants, preview expiry/drift/replay rejection, nested/SOAP-fault redaction, metadata-only audit defaults, and password-free client cache keys.
- [ ] **Step 2: Run the focused tests and confirm failure.**

  Run: `yarn vitest run test/axl-runner.test.ts test/audit-log.test.ts test/axl-client.test.ts`

- [ ] **Step 3: Implement the runner and policy types.** Keep SOAP, retry, pagination, response normalization, and error classification shared; apply strict validation and grants only when requested by the caller policy. Preserve current MCP-compatible behavior, including raw operation routing.
- [ ] **Step 4: Implement recursive redaction and safe audit persistence.** Redact case variants/pattern-based credential keys and credential-like values in nested objects, arrays, URLs, XML faults, errors, requests, responses, and audit data. Use metadata-first records by default and enforce `0700` directories/`0600` files where supported.
- [ ] **Step 5: Remove plaintext passwords from cache identity and make TLS mode explicit.** Do not mutate global TLS verification defaults; pass an explicit secure/insecure mode through the client/profile boundary and expose insecure mode in diagnostics without secrets.
- [ ] **Step 6: Run focused tests plus typecheck.**
- [ ] **Step 7: Commit.**

### Task 3: Build the schema-driven `cisco-axl` CLI

**Files:**
- Create: `src/cli.ts`
- Create: `src/cli/command.ts`
- Create: `src/cli/input.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/schema-validation.ts`
- Modify: `src/lib/credential-resolver.ts`
- Create: `test/cli.test.ts`
- Create: `test/cli-input.test.ts`
- Create: `test/cli-output.test.ts`

**Interfaces:**
- Consumes: Task 1 generated catalog/schemas and Task 2 `runAxl` strict policy.
- Produces: `versions`, `objects`, `operations`, `describe`, `execute`, `sql query`, and `sql update` commands with `cisco-axl.cli.v1` output.

- [ ] **Step 1: Write failing CLI contract tests** for command parsing, operation/version allowlisting, `--data`/`@file`/stdin precedence, payload-size limits, stable envelopes, deterministic exits, and missing-secret handling without password output.
- [ ] **Step 2: Run focused CLI tests and confirm failure.**
- [ ] **Step 3: Implement input parsing and Zod envelopes.** Reject conflicting input sources, validate unknown JSON before SOAP, and return field paths/choice/enum/array details in the error envelope.
- [ ] **Step 4: Implement discovery/describe/execute/SQL command adapters.** Keep operation names dynamic from generated metadata; do not add one permanent command per AXL operation. Require strict mutation grants for writes.
- [ ] **Step 5: Run focused tests and typecheck.**
- [ ] **Step 6: Commit.**

### Task 4: Split package entrypoints and harden distribution

**Files:**
- Modify: `src/index.ts`
- Modify: `vite.config.ts`
- Modify: `package.json`
- Create/Modify: `test/package-build.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 shared runner and Task 3 `runCli`/command contract.
- Produces: import-safe `startMcp()` and `runCli()`, `cisco-axl-mcp` and `cisco-axl` package binaries, runtime package version reporting, and clean tarball proof.

- [ ] **Step 1: Write failing packaging tests** for both executable paths, shebangs/modes, pure MCP stdio behavior, runtime version derived from package metadata, and clean tarball installation.
- [ ] **Step 2: Run the focused packaging tests and confirm failure.**
- [ ] **Step 3: Extract import-safe MCP startup and configure explicit multi-entry Vite/Rollup output with shared chunks.** Preserve Node runtime declaration and executable file modes.
- [ ] **Step 4: Update package metadata, README command examples, TLS configuration documentation, and remove the hard-coded MCP version.** Defer shell completion until a separate contract exists.
- [ ] **Step 5: Run build, package, clean-install, MCP conformance, and full validation.**

  Run: `yarn build && yarn pack --filename /tmp/cisco-axl-mcp.tgz && yarn test:mcp && yarn validate`

- [ ] **Step 6: Commit.**

### Task 5: Exact-head public-package review and lab-safe proof

**Files:**
- Modify: `docs/superpowers/plans/2026-08-12-cisco-axl-cli.md` only for execution notes if needed
- No production code changes unless a review finding requires a scoped fix

**Interfaces:**
- Consumes: Tasks 1–4 exact-head branch and generated artifacts.
- Produces: review evidence for CUCM 11.5/15.0 discovery and read-only CallManager calls; no production mutation.

- [ ] **Step 1: Run the complete exact-head validation suite and archive redacted results.**
- [ ] **Step 2: Execute read-only CLI/MCP discovery against CUCM 11.5 and 15.0 lab targets only when credentials and target leases are available.**
- [ ] **Step 3: Verify no secrets, private workflow macros, A2A transport, or `ct-cli` changes entered the public package.**
- [ ] **Step 4: Request a current-head code review and resolve findings through the review loop before any PR/merge action.**

