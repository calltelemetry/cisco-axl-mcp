# cisco-axl-mcp

[![CI](https://github.com/calltelemetry/cisco-axl-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/calltelemetry/cisco-axl-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/calltelemetry/cisco-axl-mcp/graph/badge.svg?token=6CFM37EMBS)](https://codecov.io/gh/calltelemetry/cisco-axl-mcp)
[![npm](https://img.shields.io/npm/v/@calltelemetry/cisco-axl-mcp)](https://www.npmjs.com/package/@calltelemetry/cisco-axl-mcp)

Built by [Call Telemetry](https://calltelemetry.com) — realtime tools for Cisco Collaboration.

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to Cisco Unified Communications Manager (CUCM) via the AXL SOAP API.

**You describe the task in plain language. The LLM figures out the AXL operations.**

The MCP server ships with pre-parsed schemas from Cisco's official AXL WSDL for every supported CUCM version (11.0, 11.5, 12.0, 12.5, 14.0, 15.0). When you set `CUCM_VERSION`, it loads the schema for **your exact version** — so the LLM only sees object types, operations, fields, and enums that actually exist on your CallManager. No guessing, no hallucinated field names, no version mismatches.

Eight composable tools give the LLM progressive disclosure of this schema — 232 object types, 1,065+ operations (including 123 action operations like apply, reset, restart, lock, wipe), thousands of fields — including guarded mutation preview and direct SQL access to the CUCM Informix database. The server handles auto-pagination for large result sets, retries with exponential backoff on transient failures, and maintains a per-cluster JSONL audit trail of every AXL call.

Instead of hand-crafting XML payloads, you say things like:

- _"Provision 2,000 phones from this Excel spreadsheet"_
- _"Audit end users and find anyone missing an associated phone device"_
- _"Build a report of all 7940G phones in Device Pool Dallas-DP"_
- _"Set up a hunt group for the support team with round-robin distribution"_
- _"Enable Built-in Bridge on every phone in the Sales CSS"_
- _"Apply config changes to all phones in Device Pool Dallas-DP"_
- _"Reset every phone in the building after the firmware upgrade"_
- _"Wipe a stolen Jabber client — erase all local data and credentials"_

The LLM uses the tools below to discover the right object types, inspect required fields and valid enums, then execute the AXL operations — iterating through hundreds of records if needed.

## Related Cisco MCP Servers

| Server                                                                  | Description                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[cisco-axl-mcp](https://github.com/calltelemetry/cisco-axl-mcp)**     | CUCM provisioning and admin via AXL SOAP API (this repo)                   |
| **[cisco-ris-mcp](https://github.com/calltelemetry/cisco-ris-mcp)**     | Real-time device registration, PerfMon counters, cluster health            |
| **[cisco-phone-mcp](https://github.com/calltelemetry/cisco-phone-mcp)** | Direct IP phone control — dial, screenshot, RTP stats                      |
| **[cisco-cucm-mcp](https://github.com/calltelemetry/cisco-cucm-mcp)**   | CUCM operational debugging — logs, traces, packet capture, service control |

## What It Does

Exposes eight composable tools that let an LLM discover, inspect, preview, and execute CUCM operations — phones, users, line groups, hunt lists, SQL queries, and any other AXL-managed object:

| Tool                         | Description                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `axl_execute`                | Execute any AXL SOAP operation (add, get, list, update, remove, apply, reset, restart, lock, wipe, etc.). Supports `autoPage` for automatic pagination of list results |
| `axl_preview_mutation`       | Validate an exact authorized mutation without transport and return a short-lived, single-use approval grant                                                            |
| `axl_describe_operation`     | Describe required fields, types, and enums for an operation                                                                                                            |
| `axl_list_objects`           | Discover available CUCM object types                                                                                                                                   |
| `axl_list_operations`        | List CRUD and action operations for a specific object type                                                                                                             |
| `axl_list_action_operations` | Discover all 123 non-CRUD action operations (apply, reset, restart, do, lock, wipe, assign, unassign), filterable by object or verb                                    |
| `axl_sql_query`              | Execute a conservatively screened SQL SELECT; requires a mutation grant because CUCM SQL side effects cannot be proven absent                                          |
| `axl_sql_update`             | Execute a SQL INSERT, UPDATE, or DELETE against the CUCM Informix database                                                                                             |

**Built-in resilience:**

- **Retry with exponential backoff** — automatically retries on 429, 503, connection errors, and AXL memory allocation errors
- **Adaptive rate limiting** — learns from recent throttle events and proactively delays requests to avoid overloading CUCM
- **JSONL audit trail** — every AXL call is logged per-host to `~/.cisco-axl-mcp/audit/` with timestamps, durations, and status

Supports CUCM versions **11.0, 11.5, 12.0, 12.5, 14.0, and 15.0**.

## Installation

No install required — npx downloads and runs automatically:

```bash
npx @calltelemetry/cisco-axl-mcp
```

The package publishes two executables:

| Command             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `cisco-axl-mcp`     | MCP stdio server for MCP-compatible clients                   |
| `cisco-axl-mcp-cli` | Schema-driven JSON CLI for discovery and direct AXL execution |

`cisco-axl` was an ambiguous legacy alias and is no longer published. This is a breaking command
rename; use `cisco-axl-mcp-cli` in scripts and automations. The package is executable-only: it
does not expose a supported JavaScript import API.

For a global installation:

```bash
npm install --global @calltelemetry/cisco-axl-mcp
cisco-axl-mcp
cisco-axl-mcp-cli versions
```

To run the secondary CLI without installing it globally, select its package binary explicitly:

```bash
npx --package @calltelemetry/cisco-axl-mcp cisco-axl-mcp-cli versions
```

## Command-line AXL client

`cisco-axl-mcp-cli` writes one `cisco-axl.cli.v1` JSON envelope to stdout. Human-readable
diagnostics and TLS warnings go to stderr, which keeps stdout safe for pipes and automation.
Both executables handle `--help` and `--version` locally, before loading dotenv, credentials,
network clients, or an MCP transport.
For normal direct execution, both then load `.env` through dotenv before resolving their runtime
configuration; process environment values retain their usual precedence over `.env` values.

Discovery commands do not require CUCM credentials:

```bash
cisco-axl-mcp-cli versions
cisco-axl-mcp-cli objects --version 15.0
cisco-axl-mcp-cli operations --version 15.0 --object Phone
cisco-axl-mcp-cli describe getPhone --version 15.0
```

Execution credentials come from `CUCM_HOST`, `CUCM_USERNAME`, `CUCM_PASSWORD`, and
`CUCM_VERSION`. `--host` and `--version` can override the target for one call. JSON request
data can come from `--data`, `--data @file.json`, or stdin; combining an explicit source with
non-empty stdin is rejected.

```bash
export CUCM_HOST=cucm.example.com
export CUCM_USERNAME=axl_user
export CUCM_PASSWORD=axl_password
export CUCM_VERSION=15.0

cisco-axl-mcp-cli execute getPhone --data '{"name":"SEP001122334455"}'
cisco-axl-mcp-cli execute getPhone --data @get-phone.json
printf '%s\n' '{"searchCriteria":{"name":"SEP%"},"returnedTags":{"name":""}}' \
  | cisco-axl-mcp-cli execute listPhone --auto-page

cisco-axl-mcp-cli sql query --file inventory.sql --write --confirm sql-query
printf '%s\n' 'select name from device' | cisco-axl-mcp-cli sql query --write --confirm sql-query
```

Mutations require both an explicit write flag and an exact confirmation token. For an AXL
operation, the token is the operation name; SQL queries use `sql-query`; SQL updates use `sql-update`:

```bash
cisco-axl-mcp-cli execute updatePhone \
  --data @update-phone.json \
  --write \
  --confirm updatePhone

cisco-axl-mcp-cli sql update \
  --file update-device.sql \
  --write \
  --confirm sql-update
```

### TLS behavior

The direct `cisco-axl-mcp-cli` CLI verifies CUCM TLS certificates by default. Use `--insecure` only for
a specific call to a cluster whose certificate cannot be verified; the CLI emits a warning on
stderr.

The MCP executable also verifies CUCM TLS certificates by default. Its TLS configuration precedence is
`CUCM_AXL_TLS_MODE` → `MCP_TLS_MODE` → `AXL_MCP_CONFIG` `tls_mode`/`tlsMode` → secure default.
`CUCM_AXL_TLS_MODE` is the preferred dedicated environment variable; `MCP_TLS_MODE` is a legacy
environment name retained only for compatibility. A supplied higher-precedence environment value wins,
but malformed JSON configuration still fails startup rather than being ignored.

The exact accepted values are case-insensitive after trimming whitespace:

- `secure`, `strict`, and `verify` enable certificate verification.
- `insecure` disables certificate verification. Use it only for a deliberately approved self-signed cluster.
- `default` is a legacy compatibility alias for `insecure` and is deprecated. Do not use it for new deployments.

For JSON configuration, use exactly one of `tls_mode` or `tlsMode`, for example
`AXL_MCP_CONFIG='{"tls_mode":"insecure"}'`. Supplying both aliases, an unknown value, or an empty value
fails startup instead of silently changing TLS policy.

## Quick Start

### Claude Code (one-liner)

```bash
claude mcp add cucm_axl \
  -e CUCM_HOST=cucm.example.com \
  -e CUCM_USERNAME=axl_user \
  -e CUCM_PASSWORD=axl_password \
  -e CUCM_VERSION=14.0 \
  -- npx @calltelemetry/cisco-axl-mcp
```

Or add to `~/.claude.json` manually:

```json
{
  "mcpServers": {
    "cucm_axl": {
      "command": "npx",
      "args": ["@calltelemetry/cisco-axl-mcp"],
      "env": {
        "CUCM_HOST": "cucm.example.com",
        "CUCM_USERNAME": "axl_user",
        "CUCM_PASSWORD": "axl_password",
        "CUCM_VERSION": "14.0"
      },
      "type": "stdio"
    }
  }
}
```

### Other MCP Clients

Any MCP-compatible client can launch the server via stdio:

```bash
CUCM_HOST=cucm.example.com \
CUCM_USERNAME=axl_user \
CUCM_PASSWORD=axl_password \
CUCM_VERSION=14.0 \
npx @calltelemetry/cisco-axl-mcp
```

## Configuration

### Credentials

| Environment Variable | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `CUCM_HOST`          | CUCM server hostname or IP                                    |
| `CUCM_USERNAME`      | AXL API username                                              |
| `CUCM_PASSWORD`      | AXL API password                                              |
| `CUCM_VERSION`       | CUCM version (`11.0`, `11.5`, `12.0`, `12.5`, `14.0`, `15.0`) |

MCP tools use these process credentials by default. They are injected by the MCP host configuration and are not exposed in normal tool schemas or model transcripts. `cucm_version` remains an optional non-secret target-version selector.

### Credential provider mode

For long-running MCP processes, provider mode can refresh only the username and password while
keeping one process bound to one fixed target. Set `CUCM_HOST` and `CUCM_VERSION` at startup; the
target host, schema version, TLS mode, allowlists, retry policy, and other service policy are
immutable for the life of the process. Provider mode is therefore single-target, not a
multi-cluster credential router. It rejects `CUCM_USERNAME` and `CUCM_PASSWORD` as well as inline
credential compatibility mode; choose static credentials or a provider, never both.

The provider setting is a JSON argv array. Its first element must be an absolute executable path;
remaining elements are passed as separate arguments with shell execution disabled. Do not put
secrets in the array or in process arguments. This vendor-neutral example uses only a non-secret
asset label:

```bash
CUCM_HOST=cucm.example.test
CUCM_VERSION=11.5
AXL_MCP_CREDENTIAL_PROVIDER='["/absolute/path/to/provider","--asset-id","lab-cucm"]'
AXL_MCP_CREDENTIAL_TTL_S=300
AXL_MCP_CREDENTIAL_MAX_STALE_S=0
AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS=10000
AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP=false
```

Each provider invocation must write exactly one JSON object to stdout with exactly these two keys
and no others: `{"username":"<username>","password":"<password>"}`. Credential values are
consumed in memory and are never emitted in MCP responses, diagnostics, audit records, or failure
messages. Provider stderr is not part of the credential protocol.

| Environment Variable | Default | Contract |
| -------------------- | ------- | -------- |
| `AXL_MCP_CREDENTIAL_PROVIDER` | unset | JSON argv array with an absolute executable path; enables provider mode. |
| `AXL_MCP_CREDENTIAL_TTL_S` | `300` | Primary refresh interval in seconds (`30`–`86400`). |
| `AXL_MCP_CREDENTIAL_MAX_STALE_S` | `0` | Maximum bounded stale window after TTL (`0`–`259200`). Outside it, admission fails closed. |
| `AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS` | `10000` | Provider process timeout in milliseconds (`100`–`60000`). |
| `AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP` | platform default | Optional early refresh on `SIGHUP`; TTL remains the primary refresh mechanism. |

When a TTL refresh succeeds with a changed password, new requests use the new credential
generation while already-admitted work keeps its old lease until it drains. A provider timeout,
non-zero exit, malformed output, or expired stale window never falls back to an unbounded or
partially parsed credential. A failed refresh may use the previous snapshot only inside the
configured bounded stale window; after that, requests fail closed with the value-free
`AXL_CREDENTIALS_UNAVAILABLE` error. Provider setup/output failures use the value-free
`AXL_CREDENTIAL_PROVIDER_INVALID` error.

This release does not infer authentication failures from arbitrary AXL response text and does not
retry authentication by rotating credentials. When transport evidence is insufficient to prove a
stable numeric authentication-status shape, credential refresh is available only through the TTL
and optional `SIGHUP` controls above. There is no credential-management MCP tool; the existing
eight-tool surface is unchanged.

#### Deprecated inline credential compatibility

Per-request `cucm_host`, `cucm_username`, and `cucm_password` fields are disabled by default. Supplying any of them returns `AXL_INLINE_CREDENTIALS_DISABLED` before an AXL transport is created. This keeps credentials out of model-visible tool schemas, responses, errors, retry diagnostics, and audit records.

For a temporary migration only, set `AXL_MCP_ALLOW_INLINE_CREDENTIALS=true` (or `allow_inline_credentials: true` in `AXL_MCP_CONFIG`). The server writes a startup warning and deliberately adds only the exact `cucm_host`, `cucm_username`, and `cucm_password` fields back to the execution and SQL tool schemas; aliases remain rejected. Treat this mode as deprecated: use a separate MCP host/process with its own `CUCM_*` environment for each CUCM cluster instead.

### Object Allowlisting (Optional)

Restrict which object types the server can operate on:

```bash
# Environment variable
AXL_MCP_ENABLED_OBJECTS=Phone,User,LineGroup

# CLI argument
npx @calltelemetry/cisco-axl-mcp --enabled-objects Phone,User,LineGroup

# JSON config
AXL_MCP_CONFIG='{"enabled_objects": ["Phone", "User", "LineGroup"]}'
```

When set, only the specified object types and their CRUD + action operations are available. Global
actions require a separate explicit opt-in. Omit the list to expose no object operations; use `*` or
`all` to opt into every supported object type.

### Resilience & Audit

| Environment Variable          | Default    | Description                                                                |
| ----------------------------- | ---------- | -------------------------------------------------------------------------- |
| `AXL_MCP_MAX_RETRIES`         | `3`        | Max retry attempts on transient failures                                   |
| `AXL_MCP_RETRY_BASE_DELAY_MS` | `1000`     | Initial backoff delay in milliseconds                                      |
| `AXL_MCP_ENABLE_SQL`          | `false`    | Enable SQL tools (`true` to enable)                                        |
| `AXL_MCP_MAX_AUTOPAGINATE`    | `10000`    | Max rows returned by `autoPage`                                            |
| `AXL_MCP_AUDIT_LOG`           | `metadata` | Audit log detail level (see below); unknown values fail closed to metadata |
| `AXL_MCP_AUDIT_MAX_SIZE_MB`   | `10`       | Audit log rotation threshold per host                                      |

### Audit Log

Every AXL call is logged per cluster to an opaque stable filename under `~/.cisco-axl-mcp/audit/`; the CUCM host is not included in the path. The `AXL_MCP_AUDIT_LOG` variable controls what gets logged:

| Level                | Request Payload | Response Payload | Description                                                                   |
| -------------------- | :-------------: | :--------------: | ----------------------------------------------------------------------------- |
| `off`                |                 |                  | No audit logging                                                              |
| `metadata` (default) |                 |                  | Operation, status, duration, rows only; also used for unknown or empty values |
| `request`            |     **yes**     |                  | Metadata + request payload with credentials redacted                          |
| `full`               |     **yes**     |     **yes**      | Metadata + request + full response payload                                    |

Credentials (`cucm_password`, `cucm_username`, `cucm_host`, `password`, `username`, `host`) are automatically redacted from request payloads at all log levels.

```jsonl
{"ts":"2026-03-14T15:30:00.000Z","operation":"listPhone","durationMs":342,"status":"ok","rows":50,"request":{"searchCriteria":{"name":"SEP%"}}}
{"ts":"2026-03-14T15:30:01.000Z","operation":"executeSQLQuery","durationMs":1200,"status":"throttled","error":"Maximum AXL Memory Allocation Consumed","request":{"sql":"SELECT name FROM device"}}
```

When recent throttle events are detected, the server automatically adds a proactive delay before subsequent requests to avoid overloading CUCM.

### MCP cancellation and mutation outcomes

The MCP server propagates the SDK request cancellation signal through queueing,
retry/backoff, the AXL service, and the SOAP transport. A cancellation before
dispatch is recorded as `AXL_REQUEST_CANCELLED` and queued work never reaches
CUCM. Do not interpret cancellation after a mutation has been dispatched as
proof that CUCM did not apply it: the server records and returns
`AXL_MUTATION_OUTCOME_UNKNOWN` with the audit `errorCode`/`category` set to the
same value. Some MCP clients suppress a response once they cancel a request;
that does not change the server-side outcome. Reconcile with a fresh safe
readback and the audit/status path before attempting another mutation.

## Tools

### `axl_execute`

Execute any AXL operation by name.

**Parameters:**

| Parameter      | Required | Description                                                                                                                       |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `operation`    | Yes      | AXL operation name (e.g. `addPhone`, `getUser`, `listLineGroup`)                                                                  |
| `data`         | Yes      | AXL request payload — the JSON body sent as the SOAP request                                                                      |
| `returnedTags` | No       | List of field names to return. Supports dot notation for nested fields, e.g. `["name", "model", "lines.line.dirn.pattern"]`       |
| `opts`         | No       | Options: `{ clean, removeAttributes, dataContainerIdentifierTails }`                                                              |
| `autoPage`     | No       | When `true`, automatically paginates list operations and returns all results (max 10,000 rows). Only valid for `list*` operations |
| `cucm_version` | No       | Override default version                                                                                                          |

`cucm_host`, `cucm_username`, and `cucm_password` appear only when the deprecated `AXL_MCP_ALLOW_INLINE_CREDENTIALS=true` compatibility setting is enabled.

Mutations require a `mutationGrant` returned by `axl_preview_mutation`. The
client must first show the exact preview to a human and obtain explicit approval,
then submit that unchanged grant with `axl_execute`. A preview does not contact
CUCM and does not verify a human identity; client-side approval records are the
operator's responsibility. Grants are short-lived, single-use, process-local,
and bind an opaque authority-keyed endpoint and exact transport-principal/profile
digest (not the host, username, or password). Password rotation for the same
principal is allowed; hostname, username (including case or whitespace), version,
schema, package, operation, and payload drift are rejected before dispatch.

### `axl_preview_mutation`

Validate and normalize one enabled AXL mutation without performing transport,
then return the exact single-use `mutationGrant` for an approved execution.
It is advertised only when configuration permits at least one mutation. Reads,
disabled objects, denied global actions, disabled SQL, invalid version/schema,
and unapproved inline credential aliases are rejected before a grant is minted.

**Parameters:** the same `operation`, `data`, `returnedTags`, `opts`,
`autoPage`, and optional `cucm_version` fields as `axl_execute`, excluding
`mutationGrant`.

### `axl_describe_operation`

Returns the input schema for an AXL operation — required fields, types, enums, defaults, and nested structure. Use this to build correct payloads for `axl_execute` without guessing.

**Parameters:**

| Parameter       | Required | Description                                                 |
| --------------- | -------- | ----------------------------------------------------------- |
| `operationName` | Yes      | AXL operation name (e.g. `addPhone`, `getUser`, `listLine`) |

**Returns:** `{ wsdlVersion, operationName, verb, object, fields }` where each field includes:

| Property   | Description                                                    |
| ---------- | -------------------------------------------------------------- |
| `type`     | `"string"`, `"boolean"`, `"integer"`, `"object"`, or `"array"` |
| `required` | `true` when the field is mandatory (omitted when optional)     |
| `default`  | Default value from the XSD, if any                             |
| `enum`     | Inline enum values for small enums (≤ 30 values)               |
| `enumType` | Reference to a large enum type (look up via `AXL_ENUMS`)       |
| `typeName` | XSD type name for complex types                                |
| `fields`   | Nested child fields (depth-limited to 3 levels)                |

### `axl_list_objects`

Returns all top-level CUCM object types available in the loaded WSDL version.

**Parameters:** None

**Returns:** `{ wsdlVersion, objectCount, objects[] }`

### `axl_list_operations`

Returns the CRUD operations available for a specific object type.

**Parameters:**

| Parameter    | Required | Description                                          |
| ------------ | -------- | ---------------------------------------------------- |
| `objectName` | Yes      | Object type name (e.g. `Phone`, `User`, `LineGroup`) |

**Returns:** `{ wsdlVersion, objectName, operations: { add, get, list, update, remove, apply?, reset?, restart?, lock?, wipe?, ... } }`

Action verbs (apply, reset, restart, lock, wipe, etc.) are included when the object supports them. For example, Phone returns `apply`, `reset`, `restart`, `lock`, `wipe` alongside the standard CRUD verbs.

### `axl_list_action_operations`

Discover all 123 non-CRUD action operations across the AXL schema — apply, reset, restart, do, lock, wipe, assign, unassign.

**Parameters:**

| Parameter    | Required | Description                                                           |
| ------------ | -------- | --------------------------------------------------------------------- |
| `objectName` | No       | Filter by object type (e.g. `Phone` shows only phone-related actions) |
| `verb`       | No       | Filter by verb prefix (e.g. `reset` shows all reset operations)       |

**Returns:** `{ wsdlVersion, totalCount, operations[] }` where each operation includes the verb, object (if mapped), and full operation name.

**Examples:**

```json
// All action ops for Phone
{ "objectName": "Phone" }
// → applyPhone, resetPhone, restartPhone, lockPhone, wipePhone

// All "do" operations (global actions)
{ "verb": "do" }
// → doDeviceReset, doLdapSync, doChangeDNDStatus, ...
```

### `axl_sql_query`

Execute a conservatively screened SQL SELECT against CUCM Informix via AXL's
`executeSQLQuery`. CUCM views, virtual tables, sequences, and routines cannot
be proven side-effect-free without an immutable catalog, so every SQL query
requires a single-use, request-bound mutation grant and is dispatched at most
once. The lexical screen rejects comments, multiple statements, sequences,
calls, subqueries, and other ambiguous forms; it intentionally accepts only a
small simple-SELECT subset. Obtain its grant with `axl_preview_mutation` after
explicit human approval, then submit that unchanged grant with the SQL request.

**Parameters:**

| Parameter       | Required | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `sql`           | Yes      | Conservatively screened SQL SELECT               |
| `mutationGrant` | Yes      | Single-use grant returned by an approved preview |
| `cucm_version`  | No       | Override default version                         |

**Example:**

```json
{
  "sql": "SELECT name, description FROM device WHERE name = 'SEP001122334455' ORDER BY name LIMIT 1"
}
```

### `axl_sql_update`

Execute a SQL INSERT, UPDATE, or DELETE against the CUCM Informix database via AXL's `executeSQLUpdate`.

**Parameters:**

| Parameter       | Required | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `sql`           | Yes      | SQL INSERT, UPDATE, or DELETE statement          |
| `mutationGrant` | Yes      | Single-use grant returned by an approved preview |
| `cucm_version`  | No       | Override default version                         |

> **Note:** SQL tools can be disabled by setting `AXL_MCP_ENABLE_SQL=false`.

## How `returnedTags` Works

AXL uses `returnedTags` to select which fields come back in a response — like a SELECT clause in SQL. Without it, AXL returns every field on the object.

The `returnedTags` parameter accepts a **list of field names**. Flat fields are straightforward:

```json
{
  "operation": "getPhone",
  "data": { "name": "SEP001122334455" },
  "returnedTags": ["name", "model", "callingSearchSpaceName"]
}
```

For **nested fields** (like line details on a phone), use dot notation:

```json
{
  "returnedTags": [
    "name",
    "lines.line.index",
    "lines.line.dirn.pattern",
    "lines.line.dirn.routePartitionName"
  ]
}
```

The MCP server automatically expands dot notation into the nested object structure that AXL expects. The example above becomes:

```json
{
  "name": "SEP001122334455",
  "returnedTags": {
    "name": true,
    "lines": {
      "line": {
        "index": true,
        "dirn": {
          "pattern": true,
          "routePartitionName": true
        }
      }
    }
  }
}
```

You can also pass the nested object form directly in `data.returnedTags` if you prefer — the array form is just a convenience.

## Discovery Flow

An LLM discovers how to use AXL operations in three steps:

```
axl_list_objects              → what object types exist? (Phone, User, LineGroup, ...)
axl_list_operations           → what ops exist for Phone? (add, get, list, update, remove, apply, reset, restart, lock, wipe)
axl_list_action_operations    → what action ops exist? (123 non-CRUD ops: apply, reset, do, lock, wipe, ...)
axl_describe_operation        → what fields does addPhone require?
axl_execute                   → call addPhone with the correct payload
axl_sql_query                 → run SQL directly against the CUCM Informix database
```

Fields marked `required: true` must be included. Fields with `enum` or `enumType` constrain valid values. For complex queries that don't map well to AXL CRUD operations, use `axl_sql_query` to query the database directly. See the [Examples](#examples--llm-conversations-real-cucm-15-output) section below for full interactive walkthroughs.

## Examples — LLM Conversations (Real CUCM 15 Output)

All examples below are real interactions with a live CUCM 15.0.1 cluster, showing how an LLM uses the tools conversationally.

---

### "What can I manage through AXL?"

> **User:** What object types are available in AXL?

<details><summary>Tool call: <code>axl_list_objects</code></summary>

```json
{}
```

```json
{
  "wsdlVersion": "15.0",
  "objectCount": 232,
  "objects": [
    "AarGroup",
    "Announcement",
    "AppUser",
    "CallManager",
    "CallManagerGroup",
    "CallPark",
    "CallPickupGroup",
    "CommonDeviceConfig",
    "Css",
    "CtiRoutePoint",
    "DevicePool",
    "DeviceProfile",
    "H323Gateway",
    "H323Trunk",
    "HuntList",
    "HuntPilot",
    "Line",
    "LineGroup",
    "Location",
    "MediaResourceGroup",
    "MediaResourceList",
    "Phone",
    "RecordingProfile",
    "Region",
    "RouteGroup",
    "RouteList",
    "RoutePartition",
    "RoutePattern",
    "SipProfile",
    "SipTrunk",
    "TransPattern",
    "User",
    "VoiceMailProfile",
    "... 199 more objects"
  ]
}
```

</details>

> **Assistant:** AXL exposes **232 object types** on your CUCM 15.0 cluster. The most commonly used ones:
>
> - **Devices:** Phone, DeviceProfile, H323Gateway, SipTrunk, CtiRoutePoint
> - **Dial plan:** Line, RoutePartition, Css, RoutePattern, TransPattern, HuntList, HuntPilot, LineGroup
> - **Users:** User, AppUser
> - **Infrastructure:** DevicePool, CallManagerGroup, Region, Location, MediaResourceList
>
> Want me to check what operations are available for a specific object?

---

### "What operations can I do with phones?"

> **User:** What CRUD operations exist for Phone?

<details><summary>Tool call: <code>axl_list_operations</code></summary>

```json
{ "objectName": "Phone" }
```

```json
{
  "wsdlVersion": "15.0",
  "objectName": "Phone",
  "operations": {
    "add": "addPhone",
    "get": "getPhone",
    "list": "listPhone",
    "remove": "removePhone",
    "update": "updatePhone",
    "apply": "applyPhone",
    "reset": "resetPhone",
    "restart": "restartPhone",
    "lock": "lockPhone",
    "wipe": "wipePhone"
  }
}
```

</details>

> **Assistant:** Phone supports 5 CRUD operations plus 5 action operations:
>
> | Operation   | Name           | Use case                                                                                   |
> | ----------- | -------------- | ------------------------------------------------------------------------------------------ |
> | **add**     | `addPhone`     | Provision a new device                                                                     |
> | **get**     | `getPhone`     | Retrieve full config by name or UUID                                                       |
> | **list**    | `listPhone`    | Search/filter phones with wildcards                                                        |
> | **update**  | `updatePhone`  | Modify settings on an existing phone                                                       |
> | **remove**  | `removePhone`  | Delete a device                                                                            |
> | **apply**   | `applyPhone`   | Push pending config changes to the phone                                                   |
> | **reset**   | `resetPhone`   | Full reset — unregisters, reloads config, re-registers                                     |
> | **restart** | `restartPhone` | Restart the phone process without full re-registration                                     |
> | **lock**    | `lockPhone`    | Lock the device PIN (Cisco Jabber/Webex mobile clients)                                    |
> | **wipe**    | `wipePhone`    | Factory-reset a mobile client, erasing all local data and credentials (Cisco Jabber/Webex) |
>
> Want me to describe the required fields for any of these?

---

### "What fields does addPhone need?"

> **User:** What are the required fields for adding a phone?

<details><summary>Tool call: <code>axl_describe_operation</code> — schema discovery</summary>

```json
{ "operationName": "addPhone" }
```

```json
{
  "wsdlVersion": "15.0",
  "operationName": "addPhone",
  "verb": "add",
  "object": "Phone",
  "fields": {
    "phone": {
      "type": "object",
      "required": true,
      "fields": {
        "name":            { "type": "string",  "required": true },
        "product":         { "type": "string",  "required": true, "enumType": "XProduct" },
        "class":           { "type": "string",  "required": true, "enum": ["Phone", "Gateway", "..."] },
        "protocol":        { "type": "string",  "required": true, "enum": ["SCCP", "SIP", "..."] },
        "protocolSide":    { "type": "string",  "required": true, "default": "User" },
        "devicePoolName":  { "type": "string",  "required": true },
        "commonPhoneConfigName": { "type": "string", "required": true },
        "locationName":    { "type": "string",  "required": true },
        "phoneTemplateName": { "type": "string", "required": true },
        "builtInBridgeStatus": { "type": "string", "required": true, "default": "Default" },
        "packetCaptureMode": { "type": "string", "required": true, "default": "None" },
        "certificateOperation": { "type": "string", "required": true, "default": "No Pending Operation" },
        "deviceMobilityMode": { "type": "string", "required": true, "default": "Default" },
        "description":     { "type": "string" },
        "callingSearchSpaceName": { "type": "string" },
        "lines":           { "type": "object", "fields": { "line": ["index", "dirn", "..."] } },
        "...70+ optional fields"
      }
    }
  }
}
```

</details>

> **Assistant:** `addPhone` requires a `phone` object with these mandatory fields:
>
> | Field                   | Type   | Notes                                             |
> | ----------------------- | ------ | ------------------------------------------------- |
> | `name`                  | string | Device name (e.g. `SEPAABBCCDDEEFF`)              |
> | `product`               | enum   | Product model (uses `XProduct` enum — large list) |
> | `class`                 | enum   | `Phone`, `Gateway`, etc.                          |
> | `protocol`              | enum   | `SIP` or `SCCP` (most common)                     |
> | `devicePoolName`        | string | FK to a Device Pool                               |
> | `commonPhoneConfigName` | string | FK to Common Phone Config                         |
> | `locationName`          | string | FK to a Location                                  |
> | `phoneTemplateName`     | string | FK to a Phone Button Template                     |
>
> Several required fields have defaults (`protocolSide: "User"`, `builtInBridgeStatus: "Default"`, etc.) so you can omit them unless you need non-default values. There are 70+ optional fields for lines, speed dials, BLF, services, security, and more.

---

### "Show me all phones on the cluster"

> **User:** List all the phones configured on CUCM.

<details><summary>Tool call: <code>axl_execute</code> — listPhone</summary>

```json
{
  "operation": "listPhone",
  "data": {
    "searchCriteria": { "name": "SEP%" },
    "returnedTags": { "name": "", "model": "", "description": "" }
  }
}
```

```json
{
  "phone": [
    { "name": "SEP000832C78E0F", "model": "Cisco 7821", "description": "Auto 1001" },
    { "name": "SEP000C291130BA", "model": "Cisco IP Communicator", "description": "Auto 1002" },
    { "name": "SEP0022905C7710", "model": "Cisco 7975", "description": "Auto 1000 7975 Phone3" },
    { "name": "SEP010CE46F48A2", "model": "Cisco 7965", "description": "Lexie Towne - Ardith" },
    { "name": "SEP505C885DF37F", "model": "Cisco 9841", "description": "Auto 1003 9841" },
    "... 118 phones total"
  ]
}
```

</details>

> **Assistant:** Found **123 phones** configured in AXL. Here's a summary by model:
>
> | Model                 | Count | Examples                                            |
> | --------------------- | ----- | --------------------------------------------------- |
> | Cisco 7965            | ~60   | Provisioned users (Lexie Towne, Gabe Gottlieb, ...) |
> | Cisco 7945            | ~55   | Provisioned users                                   |
> | Cisco 7821            | 1     | SEP000832C78E0F — Auto 1001                         |
> | Cisco 7975            | 1     | SEP0022905C7710 — Auto 1000                         |
> | Cisco 9841            | 1     | SEP505C885DF37F — Auto 1003                         |
> | Cisco IP Communicator | 1     | SEP000C291130BA — Auto 1002                         |
>
> The bulk of the inventory appears to be synthetic test data (7945/7965 models). The 3 "Auto" phones are the real lab devices.

---

### "Get the full config for a specific phone"

> **User:** Show me the config for the 7821 phone, including its line details.

<details><summary>Tool call: <code>axl_execute</code> — getPhone with nested returnedTags</summary>

```json
{
  "operation": "getPhone",
  "data": { "name": "SEP000832C78E0F" },
  "returnedTags": [
    "name",
    "model",
    "description",
    "devicePoolName",
    "callingSearchSpaceName",
    "lines.line.index",
    "lines.line.dirn.pattern",
    "lines.line.dirn.routePartitionName"
  ]
}
```

```json
{
  "phone": {
    "name": "SEP000832C78E0F",
    "description": "Auto 1001",
    "model": "Cisco 7821",
    "callingSearchSpaceName": "CT-Internal-CSS",
    "devicePoolName": "Default",
    "lines": {
      "line": [
        {
          "index": "1",
          "dirn": {
            "pattern": "1001",
            "routePartitionName": "CT-Internal"
          }
        }
      ]
    }
  }
}
```

</details>

> **Assistant:** Here's the 7821 config:
>
> - **Device:** SEP000832C78E0F (Cisco 7821)
> - **Description:** Auto 1001
> - **Device Pool:** Default
> - **Calling Search Space:** CT-Internal-CSS
> - **Line 1:** DN `1001` in partition `CT-Internal`
>
> The `returnedTags` dot notation (`lines.line.dirn.pattern`) automatically expands into the nested AXL structure — you don't need to build the XML nesting manually.

---

### "What operations exist for LineGroup?"

> **User:** I need to set up hunt groups. What can I do with LineGroup?

<details><summary>Tool call: <code>axl_list_operations</code></summary>

```json
{ "objectName": "LineGroup" }
```

```json
{
  "wsdlVersion": "15.0",
  "objectName": "LineGroup",
  "operations": {
    "add": "addLineGroup",
    "get": "getLineGroup",
    "list": "listLineGroup",
    "remove": "removeLineGroup",
    "update": "updateLineGroup"
  }
}
```

</details>

> **Assistant:** LineGroup supports full CRUD. For a hunt group setup, the typical workflow is:
>
> 1. **`addLineGroup`** — Create a line group with member DNs and a distribution algorithm (Top Down, Circular, etc.)
> 2. **`addHuntList`** — Create a hunt list referencing one or more line groups
> 3. **`addHuntPilot`** — Create the pilot number users dial to reach the hunt group
>
> Want me to describe the required fields for `addLineGroup` so we can build the payload?

---

### "Enable Built-in Bridge on a phone"

> **User:** Turn on BIB for the 7821.

<details><summary>Tool calls: preview, explicit approval, then <code>axl_execute</code> — updatePhone</summary>

```json
{
  "operation": "updatePhone",
  "data": {
    "name": "SEP000832C78E0F",
    "builtInBridgeStatus": "On"
  }
}
```

After the client displays this preview and records explicit human approval, it
submits the exact returned grant:

```json
{
  "operation": "updatePhone",
  "data": {
    "name": "SEP000832C78E0F",
    "builtInBridgeStatus": "On"
  },
  "mutationGrant": "<the exact object returned by axl_preview_mutation>"
}
```

```json
{ "return": "{7C6B3FC2-C043-480F-811D-641BA7E47909}" }
```

</details>

> **Assistant:** Done — Built-in Bridge is now **On** for SEP000832C78E0F. The phone will need to reset for the change to take effect. Update operations just take the device name plus the fields to change.

---

### "Query a different cluster"

> **User:** Can you check phones on our London cluster too?

> **Assistant:** Configure a separate MCP host process for the London cluster so its credentials stay outside model-visible tool calls:

```json
{
  "command": "npx",
  "args": ["@calltelemetry/cisco-axl-mcp"],
  "env": {
    "CUCM_HOST": "10.1.1.5",
    "CUCM_USERNAME": "london_axl",
    "CUCM_PASSWORD": "set-by-your-secret-manager",
    "CUCM_VERSION": "14.0"
  }
}
```

> Start that process with credentials injected by your secret manager, then call its ordinary tools without credential arguments. The legacy inline fields can be temporarily re-enabled only with `AXL_MCP_ALLOW_INLINE_CREDENTIALS=true`; do not use that compatibility mode for new integrations.

## CUCM Prerequisites

The AXL API user needs the **Standard AXL API Access** role in CUCM. To set this up:

1. In CUCM Administration, go to **User Management > Application User** (or End User)
2. Create or select a user
3. Add the **Standard AXL API Access** role
4. Ensure the AXL Web Service is activated in **Cisco Unified Serviceability > Tools > Service Activation**

## Development

Requires **Node.js 22+** and **Yarn 4** (via Corepack).

### Building and Testing

```bash
git clone https://github.com/calltelemetry/cisco-axl-mcp.git
cd cisco-axl-mcp
corepack enable           # Activates Yarn 4 via packageManager field
yarn install
yarn build                # Uses pre-committed generated types — no WSDL schemas needed
yarn test                 # Run full test suite
```

The generated TypeScript types in `src/types/generated/` and `generated/` are checked into the repo. Contributors can build, test, and modify the MCP server without needing access to any WSDL files.

### Available Scripts

| Command             | Description                                     |
| ------------------- | ----------------------------------------------- |
| `yarn build`        | Build with Vite                                 |
| `yarn test`         | Run all tests (Vitest)                          |
| `yarn test:mcp`     | Run MCP conformance tests only                  |
| `yarn typecheck`    | TypeScript type checking                        |
| `yarn lint`         | ESLint                                          |
| `yarn lint:fix`     | ESLint with auto-fix                            |
| `yarn format`       | Prettier format                                 |
| `yarn format:check` | Prettier check                                  |
| `yarn validate`     | Typecheck + lint + test (full pre-commit check) |

### Regenerating AXL Types

This is only needed when adding support for new CUCM versions or new AXL object types. The [`cisco-axl`](https://github.com/sieteunoseis/cisco-axl) library by [Jeremy Worden](https://github.com/sieteunoseis) bundles Cisco AXL WSDL schemas for versions 11.0–15.0 in its npm package. The type generation script reads these directly from `node_modules`:

```bash
yarn install                # cisco-axl ships WSDLs in node_modules/cisco-axl/schema/
yarn generate:types         # Parses WSDLs, updates src/types/generated/ and generated/
```

To use schemas from a custom location:

```bash
yarn generate:types --schema-dir /path/to/schema
```

After regeneration, commit the updated generated files.

## Contributing

Contributions are welcome! To get started:

1. Fork the repo and create a feature branch
2. Run `corepack enable && yarn install`
3. Make your changes
4. Run `yarn validate` (typecheck + lint + tests must all pass)
5. Open a pull request against `main`

CI runs automatically on pull requests — typecheck, lint, tests with coverage, and build must all pass before merge. The `main` branch is protected and requires CI to pass.

## npm trusted publishing

Releases are created by Release Please from `main`; the release job then checks out the exact
release tag and publishes with npm OIDC provenance. The workflow uses the GitHub Actions
environment named `npm`, job-level `id-token: write`, and no npm token secret. Its repository
release App requires the `RELEASE_APP_CLIENT_ID` repository variable and the
`RELEASE_APP_PRIVATE_KEY` secret.

The trusted-publisher relationship is an external npm setting and must be operator-confirmed as
`calltelemetry` / `cisco-axl-mcp` / `release.yml` / `npm`. Source changes cannot prove that
setting or a registry artifact. Until a protected-branch release is authorized, its exact tag is
published, and the package's npm provenance/attestation is inspected, release proof remains
pending. Do not use a manual `npm publish` or token-based fallback.

## Acknowledgments

This project is made possible by:

- **[cisco-axl](https://github.com/sieteunoseis/cisco-axl)** by [Jeremy Worden](https://github.com/sieteunoseis) — the underlying AXL SOAP client that handles all CUCM communication
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)** by Anthropic — the MCP server framework
- **[strong-soap](https://github.com/loopbackio/strong-soap)** by IBM Corp. & LoopBack contributors — WSDL parsing

## License

MIT — see [LICENSE](LICENSE) for details.
