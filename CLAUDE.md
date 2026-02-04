# cisco-axl-mcp

MCP server that wraps `cisco-axl` to call CUCM AXL operations.

## Dev

```bash
yarn install
yarn build        # Uses committed generated types, no WSDL needed
yarn test:mcp
```

## Credentials

- Defaults come from `CUCM_HOST`, `CUCM_USERNAME`, `CUCM_PASSWORD`, `CUCM_VERSION`.
- Any tool may override via `cucm_host`, `cucm_username`, `cucm_password`, `cucm_version`.

## Type Generation

- Generated types are committed to git — `yarn build` does NOT regenerate them.
- To regenerate (only needed when adding CUCM versions or AXL objects):
  ```bash
  yarn generate:types    # reads WSDLs from node_modules/cisco-axl/schema/
  ```
- Custom schema path: `yarn generate:types --schema-dir /path/to/schema`
- Outputs:
  - `src/types/generated/wsdl-support.ts` — version support matrix
  - `src/types/generated/axl-objects.ts` — top-level objects and CRUD operation map
  - `src/types/generated/axl-operation-schemas.ts` — operation input schemas, enums, and field metadata (942 operations)
  - `generated/axl-top-level-objects.json`
- Commit updated generated files after regeneration.

## Tool Model

- MCP exposes a small fixed tool surface: `axl_execute`, `axl_describe_operation`, `axl_list_objects`, `axl_list_operations`.
- `axl_execute` uses `data` (not `tags`) as the request payload parameter.
- The WSDL-derived CRUD map lives in `src/types/generated/axl-objects.ts` and is used for discovery + allowlisting.
- Object allowlisting is configured via `AXL_MCP_ENABLED_OBJECTS`, `AXL_MCP_CONFIG`, or `--enabled-objects` (restricts mapped CRUD ops).
