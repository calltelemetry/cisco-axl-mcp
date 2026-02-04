# cisco-axl-mcp

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to Cisco Unified Communications Manager (CUCM) via the AXL SOAP API.

Built on the [`cisco-axl`](https://github.com/sieteunoseis/cisco-axl) library by [Jeremy Worden](https://github.com/sieteunoseis).

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

```bash
npm install -g @calltelemetry/cisco-axl-mcp
```

Or with npx (no install):

```bash
npx @calltelemetry/cisco-axl-mcp
```

## Quick Start

### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "cucm_axl": {
      "command": "cisco-axl-mcp",
      "args": [],
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
cisco-axl-mcp
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
cisco-axl-mcp --enabled-objects Phone,User,LineGroup

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

**Example: describe addPhone**

```
Tool call → axl_describe_operation
  operationName: "addPhone"

Returns:
{
  "wsdlVersion": "15.0",
  "operationName": "addPhone",
  "verb": "add",
  "object": "Phone",
  "fields": {
    "phone": {
      "type": "object",
      "required": true,
      "typeName": "XPhone",
      "fields": {
        "name": { "type": "string", "required": true },
        "product": { "type": "string", "required": true, "enumType": "XProduct" },
        "protocol": { "type": "string", "required": true, "enum": ["SIP", "SCCP"] },
        "devicePoolName": { "type": "string", "required": true },
        "description": { "type": "string" },
        ...
      }
    }
  }
}
```

Fields marked `required: true` must be included. Fields with `enum` or `enumType` constrain valid values.

## Examples

### Look up a phone

```json
{
  "operation": "getPhone",
  "data": { "name": "SEP001122334455" },
  "returnedTags": ["name", "model", "callingSearchSpaceName", "devicePoolName"]
}
```

### Get a phone with line and recording details

```json
{
  "operation": "getPhone",
  "data": { "name": "SEP001122334455" },
  "returnedTags": [
    "name",
    "model",
    "builtInBridgeStatus",
    "callingSearchSpaceName",
    "lines.line.index",
    "lines.line.dirn.pattern",
    "lines.line.dirn.routePartitionName",
    "lines.line.recordingFlag",
    "lines.line.recordingMediaSource",
    "lines.line.recordingProfileName",
    "lines.line.monitoringCssName"
  ]
}
```

### Search for users

```json
{
  "operation": "listUser",
  "data": { "searchCriteria": { "lastName": "Smith%" } },
  "returnedTags": ["firstName", "lastName", "userid", "department"]
}
```

The `%` wildcard works like SQL LIKE — `Smith%` matches any last name starting with "Smith", `%` alone returns all.

### List phones with line info

```json
{
  "operation": "listPhone",
  "data": { "searchCriteria": { "name": "%" } },
  "returnedTags": ["name", "model", "lines.line.dirn.pattern"]
}
```

### Add a route partition

```json
{
  "operation": "addRoutePartition",
  "data": {
    "routePartition": {
      "name": "INTERNAL-PT",
      "description": "Internal directory numbers"
    }
  }
}
```

Add operations wrap the payload in a container element named after the object type.

### Get a user's device associations

```json
{
  "operation": "getUser",
  "data": { "userid": "jsmith" },
  "returnedTags": ["firstName", "lastName", "associatedDevices", "primaryExtension"]
}
```

### Update a phone

```json
{
  "operation": "updatePhone",
  "data": {
    "name": "SEPAAAABBBBCCCC",
    "builtInBridgeStatus": "On",
    "callInfoPrivacyStatus": "Off"
  }
}
```

Update operations take the object identifier (`name` or `uuid`) plus the fields to change.

### Discover available objects

```
Tool call → axl_list_objects

Returns:
{
  "wsdlVersion": "15.0",
  "objectCount": 6,
  "objects": ["Phone", "User", "AppUser", "Line", "LineGroup", "HuntList"]
}
```

### Check operations for an object

```
Tool call → axl_list_operations
  objectName: "LineGroup"

Returns:
{
  "wsdlVersion": "15.0",
  "objectName": "LineGroup",
  "operations": {
    "add": "addLineGroup",
    "get": "getLineGroup",
    "list": "listLineGroup",
    "update": "updateLineGroup",
    "remove": "removeLineGroup"
  }
}
```

### Multi-cluster query

```json
{
  "operation": "getPhone",
  "data": { "name": "SEP112233445566" },
  "cucm_host": "10.1.1.5",
  "cucm_username": "london_axl",
  "cucm_password": "london_pass",
  "cucm_version": "14.0"
}
```

Credential overrides let you query different clusters without restarting the MCP server.

## CUCM Prerequisites

The AXL API user needs the **Standard AXL API Access** role in CUCM. To set this up:

1. In CUCM Administration, go to **User Management > Application User** (or End User)
2. Create or select a user
3. Add the **Standard AXL API Access** role
4. Ensure the AXL Web Service is activated in **Cisco Unified Serviceability > Tools > Service Activation**

## Development

### Building and Testing

```bash
git clone https://github.com/calltelemetry/cisco-axl-mcp.git
cd cisco-axl-mcp
yarn install
yarn build       # Uses pre-committed generated types — no WSDL schemas needed
yarn test:mcp
```

The generated TypeScript types in `src/types/generated/` and `generated/` are checked into the repo. Contributors can build, test, and modify the MCP server without needing access to any WSDL files.

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

## Acknowledgments

This project is made possible by:

- **[cisco-axl](https://github.com/sieteunoseis/cisco-axl)** by [Jeremy Worden](https://github.com/sieteunoseis) — the underlying AXL SOAP client that handles all CUCM communication
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)** by Anthropic — the MCP server framework
- **[strong-soap](https://github.com/loopbackio/strong-soap)** by IBM Corp. & LoopBack contributors — WSDL parsing

## License

MIT — see [LICENSE](LICENSE) for details.
