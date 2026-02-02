# cisco-axl-mcp

MCP server for interacting with Cisco CUCM via the AXL SOAP API.

This server wraps the `cisco-axl` library and exposes a small, composable tool surface so it fits in model/tooling context.

## Configuration

Environment variables (default credentials):

```bash
CUCM_HOST=cucm.example.com
CUCM_USERNAME=axl_user
CUCM_PASSWORD=axl_password
CUCM_VERSION=14.0
```

Each tool also accepts optional credential overrides (`cucm_host`, `cucm_username`, `cucm_password`, `cucm_version`).

## Installation

Install from npm:

```bash
npm install -g @calltelemetry/cisco-axl-mcp
```

Or run directly with npx:

```bash
npx -y @calltelemetry/cisco-axl-mcp
```

## Tools

Only 3 tools are exposed:

- `axl_execute`: execute any AXL operation by name (raw `executeOperation`)
- `axl_list_objects`: list top-level objects discovered in the WSDL
- `axl_list_operations`: list CRUD operation names for a given top-level object

### `axl_execute` shape

`axl_execute` accepts:

- `operation` (required): operation name (e.g. `addPhone`, `getUser`, `listLineGroup`)
- `tags` (required): raw payload passed to `executeOperation(operation, tags)`
- `opts` (optional): `{ clean, removeAttributes, dataContainerIdentifierTails }`

All tools accept optional credential overrides (`cucm_host`, `cucm_username`, `cucm_password`, `cucm_version`).

### Enabling Only Certain Objects (Optional Allowlist)

If you only want to allow a subset of CRUD operations, allowlist top-level objects at server startup:

```bash
AXL_MCP_ENABLED_OBJECTS=Phone,User,LineGroup
```

Or via a JSON config object:

```bash
AXL_MCP_CONFIG='{"enabled_objects":["Phone","User","LineGroup"]}'
```

Or via CLI:

```bash
node build/index.js --enabled-objects Phone,User,LineGroup
```

When `AXL_MCP_ENABLED_OBJECTS` is set, `axl_execute` only allows CRUD operations that map to the enabled objects (from the generated WSDL CRUD map).

The allowlist keys are generated during `yarn build` / `yarn generate:types` into:

- `src/types/generated/axl-objects.ts`
- `generated/axl-top-level-objects.json`

Print the JSON list:

```bash
yarn print:objects
```

## MCP Client Configuration

### OpenCode

Create or edit `mcp.json` in your project root or `~/.config/opencode/mcp.json` globally:

```json
{
  "mcpServers": {
    "cucm_axl": {
      "command": "npx",
      "args": ["-y", "@calltelemetry/cisco-axl-mcp"],
      "env": {
        "CUCM_HOST": "cucm.example.com",
        "CUCM_USERNAME": "axl_user",
        "CUCM_PASSWORD": "axl_password",
        "CUCM_VERSION": "14.0"
      }
    }
  }
}
```

### Claude Desktop (macOS)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cucm_axl": {
      "command": "npx",
      "args": ["-y", "@calltelemetry/cisco-axl-mcp"],
      "env": {
        "CUCM_HOST": "cucm.example.com",
        "CUCM_USERNAME": "axl_user",
        "CUCM_PASSWORD": "axl_password",
        "CUCM_VERSION": "14.0"
      }
    }
  }
}
```

## Run

```bash
yarn install
yarn build
node build/index.js
```
