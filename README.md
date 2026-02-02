# cisco-axl-mcp

MCP server for interacting with Cisco CUCM via the AXL SOAP API.

Wraps the `cisco-axl` library and exposes a small, composable tool surface for AI/LLM tooling.

## Installation

Build and link globally:

```bash
yarn install
yarn build
npm link
```

This makes `cisco-axl-mcp` available as a global command.

## Configuration

Environment variables for default credentials:

```bash
CUCM_HOST=cucm.example.com
CUCM_USERNAME=axl_user
CUCM_PASSWORD=axl_password
CUCM_VERSION=14.0
```

Each tool also accepts runtime credential overrides (`cucm_host`, `cucm_username`, `cucm_password`, `cucm_version`).

## Tools

Three tools are exposed:

| Tool | Description |
|------|-------------|
| `axl_execute` | Execute any AXL operation by name |
| `axl_list_objects` | List top-level objects from WSDL |
| `axl_list_operations` | List CRUD operations for an object |

### axl_execute

Parameters:
- `operation` (required): operation name (e.g. `addPhone`, `getUser`, `listLineGroup`)
- `tags` (required): payload passed to `executeOperation(operation, tags)`
- `opts` (optional): `{ clean, removeAttributes, dataContainerIdentifierTails }`

### Object Allowlisting (Optional)

Restrict which CRUD operations are allowed:

```bash
AXL_MCP_ENABLED_OBJECTS=Phone,User,LineGroup
```

Or via CLI:

```bash
cisco-axl-mcp --enabled-objects Phone,User,LineGroup
```

## Claude Code Configuration

Add to `~/.claude.json` under `mcpServers`:

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

## Development

```bash
yarn install
yarn build
yarn test:mcp
```
