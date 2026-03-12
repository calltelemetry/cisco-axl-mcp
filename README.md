# cisco-axl-mcp

[![CI](https://github.com/calltelemetry/cisco-axl-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/calltelemetry/cisco-axl-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/calltelemetry/cisco-axl-mcp/graph/badge.svg)](https://codecov.io/gh/calltelemetry/cisco-axl-mcp)
[![npm](https://img.shields.io/npm/v/@calltelemetry/cisco-axl-mcp)](https://www.npmjs.com/package/@calltelemetry/cisco-axl-mcp)

Built by [Call Telemetry](https://calltelemetry.com) — realtime tools for Cisco Collaboration.

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to Cisco Unified Communications Manager (CUCM) via the AXL SOAP API.

All AXL operations are supported, with schemas auto-generated from Cisco's WSDL version data. Gives LLMs progressive disclosure of the full AXL schema — discover object types, inspect operation fields and enums, then execute any CRUD operation — without hardcoding a single phone model or field name.

## What It Does

Exposes four composable tools that let an LLM discover, inspect, and execute CUCM operations — phones, users, line groups, hunt lists, and any other AXL-managed object:

| Tool | Description |
|------|-------------|
| `axl_execute` | Execute any AXL SOAP operation (add, get, list, update, remove) |
| `axl_describe_operation` | Describe required fields, types, and enums for an operation |
| `axl_list_objects` | Discover available CUCM object types |
| `axl_list_operations` | List CRUD operations for a specific object type |

Supports CUCM versions **11.0, 11.5, 12.0, 12.5, 14.0, and 15.0**.

## Installation

No install required — npx downloads and runs automatically:

```bash
npx @calltelemetry/cisco-axl-mcp
```

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

| Environment Variable | Description |
|---|---|
| `CUCM_HOST` | CUCM server hostname or IP |
| `CUCM_USERNAME` | AXL API username |
| `CUCM_PASSWORD` | AXL API password |
| `CUCM_VERSION` | CUCM version (`11.0`, `11.5`, `12.0`, `12.5`, `14.0`, `15.0`) |

Each tool call can also override credentials at runtime via `cucm_host`, `cucm_username`, `cucm_password`, and `cucm_version` parameters — useful for querying multiple clusters in a single session.

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

When set, only the specified object types and their CRUD operations are available. Omit to allow all objects.

## Tools

### `axl_execute`

Execute any AXL operation by name.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `operation` | Yes | AXL operation name (e.g. `addPhone`, `getUser`, `listLineGroup`) |
| `data` | Yes | AXL request payload — the JSON body sent as the SOAP request |
| `returnedTags` | No | List of field names to return. Supports dot notation for nested fields, e.g. `["name", "model", "lines.line.dirn.pattern"]` |
| `opts` | No | Options: `{ clean, removeAttributes, dataContainerIdentifierTails }` |
| `cucm_host` | No | Override default CUCM host |
| `cucm_username` | No | Override default username |
| `cucm_password` | No | Override default password |
| `cucm_version` | No | Override default version |

### `axl_describe_operation`

Returns the input schema for an AXL operation — required fields, types, enums, defaults, and nested structure. Use this to build correct payloads for `axl_execute` without guessing.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `operationName` | Yes | AXL operation name (e.g. `addPhone`, `getUser`, `listLine`) |

**Returns:** `{ wsdlVersion, operationName, verb, object, fields }` where each field includes:

| Property | Description |
|---|---|
| `type` | `"string"`, `"boolean"`, `"integer"`, `"object"`, or `"array"` |
| `required` | `true` when the field is mandatory (omitted when optional) |
| `default` | Default value from the XSD, if any |
| `enum` | Inline enum values for small enums (≤ 30 values) |
| `enumType` | Reference to a large enum type (look up via `AXL_ENUMS`) |
| `typeName` | XSD type name for complex types |
| `fields` | Nested child fields (depth-limited to 3 levels) |

### `axl_list_objects`

Returns all top-level CUCM object types available in the loaded WSDL version.

**Parameters:** None

**Returns:** `{ wsdlVersion, objectCount, objects[] }`

### `axl_list_operations`

Returns the CRUD operations available for a specific object type.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `objectName` | Yes | Object type name (e.g. `Phone`, `User`, `LineGroup`) |

**Returns:** `{ wsdlVersion, objectName, operations: { add, get, list, update, remove } }`

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
axl_list_objects          → what object types exist? (Phone, User, LineGroup, ...)
axl_list_operations       → what operations exist for Phone? (addPhone, getPhone, ...)
axl_describe_operation    → what fields does addPhone require?
axl_execute               → call addPhone with the correct payload
```

Fields marked `required: true` must be included. Fields with `enum` or `enumType` constrain valid values. See the [Examples](#examples--llm-conversations-real-cucm-15-output) section below for full interactive walkthroughs.

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
    "AarGroup", "Announcement", "AppUser", "CallManager",
    "CallManagerGroup", "CallPark", "CallPickupGroup",
    "CommonDeviceConfig", "Css", "CtiRoutePoint", "DevicePool",
    "DeviceProfile", "H323Gateway", "H323Trunk", "HuntList",
    "HuntPilot", "Line", "LineGroup", "Location",
    "MediaResourceGroup", "MediaResourceList", "Phone",
    "RecordingProfile", "Region", "RouteGroup", "RouteList",
    "RoutePartition", "RoutePattern", "SipProfile", "SipTrunk",
    "TransPattern", "User", "VoiceMailProfile",
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
    "update": "updatePhone"
  }
}
```

</details>

> **Assistant:** Phone supports all 5 CRUD operations:
>
> | Operation | Name | Use case |
> |-----------|------|----------|
> | **add** | `addPhone` | Provision a new device |
> | **get** | `getPhone` | Retrieve full config by name or UUID |
> | **list** | `listPhone` | Search/filter phones with wildcards |
> | **update** | `updatePhone` | Modify settings on an existing phone |
> | **remove** | `removePhone` | Delete a device |
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
> | Field | Type | Notes |
> |-------|------|-------|
> | `name` | string | Device name (e.g. `SEPAABBCCDDEEFF`) |
> | `product` | enum | Product model (uses `XProduct` enum — large list) |
> | `class` | enum | `Phone`, `Gateway`, etc. |
> | `protocol` | enum | `SIP` or `SCCP` (most common) |
> | `devicePoolName` | string | FK to a Device Pool |
> | `commonPhoneConfigName` | string | FK to Common Phone Config |
> | `locationName` | string | FK to a Location |
> | `phoneTemplateName` | string | FK to a Phone Button Template |
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
    { "name": "SEP000832C78E0F", "model": "Cisco 7821",  "description": "Auto 1001" },
    { "name": "SEP000C291130BA", "model": "Cisco IP Communicator", "description": "Auto 1002" },
    { "name": "SEP0022905C7710", "model": "Cisco 7975",  "description": "Auto 1000 7975 Phone3" },
    { "name": "SEP010CE46F48A2", "model": "Cisco 7965",  "description": "Lexie Towne - Ardith" },
    { "name": "SEP505C885DF37F", "model": "Cisco 9841",  "description": "Auto 1003 9841" },
    "... 118 phones total"
  ]
}
```

</details>

> **Assistant:** Found **123 phones** configured in AXL. Here's a summary by model:
>
> | Model | Count | Examples |
> |-------|-------|---------|
> | Cisco 7965 | ~60 | Provisioned users (Lexie Towne, Gabe Gottlieb, ...) |
> | Cisco 7945 | ~55 | Provisioned users |
> | Cisco 7821 | 1 | SEP000832C78E0F — Auto 1001 |
> | Cisco 7975 | 1 | SEP0022905C7710 — Auto 1000 |
> | Cisco 9841 | 1 | SEP505C885DF37F — Auto 1003 |
> | Cisco IP Communicator | 1 | SEP000C291130BA — Auto 1002 |
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
    "name", "model", "description",
    "devicePoolName", "callingSearchSpaceName",
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

<details><summary>Tool call: <code>axl_execute</code> — updatePhone</summary>

```json
{
  "operation": "updatePhone",
  "data": {
    "name": "SEP000832C78E0F",
    "builtInBridgeStatus": "On"
  }
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

> **Assistant:** Yes — each tool call can override credentials for a different cluster without restarting the MCP server:

```json
{
  "operation": "listPhone",
  "data": { "searchCriteria": { "name": "SEP%" }, "returnedTags": { "name": "", "model": "" } },
  "cucm_host": "10.1.1.5",
  "cucm_username": "london_axl",
  "cucm_password": "london_pass",
  "cucm_version": "14.0"
}
```

> The `cucm_host`, `cucm_username`, `cucm_password`, and `cucm_version` parameters override the defaults on a per-call basis. This lets you query multiple clusters in a single session.

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

| Command | Description |
|---------|-------------|
| `yarn build` | Build with Vite |
| `yarn test` | Run all tests (Vitest) |
| `yarn test:mcp` | Run MCP conformance tests only |
| `yarn typecheck` | TypeScript type checking |
| `yarn lint` | ESLint |
| `yarn lint:fix` | ESLint with auto-fix |
| `yarn format` | Prettier format |
| `yarn format:check` | Prettier check |
| `yarn validate` | Typecheck + lint + test (full pre-commit check) |

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

## Acknowledgments

This project is made possible by:

- **[cisco-axl](https://github.com/sieteunoseis/cisco-axl)** by [Jeremy Worden](https://github.com/sieteunoseis) — the underlying AXL SOAP client that handles all CUCM communication
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)** by Anthropic — the MCP server framework
- **[strong-soap](https://github.com/loopbackio/strong-soap)** by IBM Corp. & LoopBack contributors — WSDL parsing

## License

MIT — see [LICENSE](LICENSE) for details.
