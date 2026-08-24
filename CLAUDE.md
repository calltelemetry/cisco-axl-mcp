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
- In normal MCP mode, inline `cucm_host`, `cucm_username`, and `cucm_password` are disabled. The
  optional `cucm_version` selector must match the configured schema; it is not a cluster router.
- Provider mode is a single fixed target: `CUCM_HOST`, `CUCM_VERSION`, TLS, allowlists, retry
  policy, and other service policy are captured at startup. Only username/password may rotate.
- Configure provider mode with `AXL_MCP_CREDENTIAL_PROVIDER` as an absolute-path JSON argv array,
  plus `AXL_MCP_CREDENTIAL_TTL_S`, `AXL_MCP_CREDENTIAL_MAX_STALE_S`,
  `AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS`, and optional
  `AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP`. Provider stdout must be exactly a two-key JSON object,
  `username` and `password`; values never appear in responses, logs, or errors.
- TTL is the primary refresh path. SIGHUP is optional. Old credential generations drain existing
  leases, new admissions cannot use retired generations, and stale credentials are bounded and
  fail closed.
- The implementation does not retry authentication based on unproven response text. If stable
  numeric authentication evidence is unavailable, only TTL/SIGHUP refresh applies. There are no
  credential-management MCP tools; preserve the fixed eight-tool surface.

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

- MCP exposes the fixed eight-tool surface: `axl_execute`, `axl_preview_mutation`,
  `axl_describe_operation`, `axl_list_objects`, `axl_list_operations`,
  `axl_list_action_operations`, `axl_sql_query`, and `axl_sql_update`.
- `axl_execute` uses `data` (not `tags`) as the request payload parameter.
- The WSDL-derived CRUD map lives in `src/types/generated/axl-objects.ts` and is used for discovery + allowlisting.
- Object allowlisting is configured via `AXL_MCP_ENABLED_OBJECTS`, `AXL_MCP_CONFIG`, or `--enabled-objects` (restricts mapped CRUD ops).
