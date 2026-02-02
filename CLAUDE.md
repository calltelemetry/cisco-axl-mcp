# cisco-axl-mcp

MCP server that wraps `cisco-axl` to call CUCM AXL operations.

## Dev

```bash
yarn install
yarn build
yarn test:mcp
```

## Credentials

- Defaults come from `CUCM_HOST`, `CUCM_USERNAME`, `CUCM_PASSWORD`, `CUCM_VERSION`.
- Any tool may override via `cucm_host`, `cucm_username`, `cucm_password`, `cucm_version`.

## Type Generation

- `yarn generate:types` parses `schema/*/AXLAPI.wsdl` and writes:
  - `src/types/generated/wsdl-support.ts`
  - `src/types/generated/axl-objects.ts`
  - `generated/axl-top-level-objects.json`
- `yarn build` runs type generation automatically.

## Tool Model

- MCP exposes a small fixed tool surface: `axl_execute`, `axl_list_objects`, `axl_list_operations`.
- The WSDL-derived CRUD map lives in `src/types/generated/axl-objects.ts` and is used for discovery + allowlisting.
- Object allowlisting is configured via `AXL_MCP_ENABLED_OBJECTS`, `AXL_MCP_CONFIG`, or `--enabled-objects` (restricts mapped CRUD ops).
