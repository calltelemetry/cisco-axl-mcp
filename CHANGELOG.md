# Changelog

## [0.10.0](https://github.com/calltelemetry/cisco-axl-mcp/compare/v0.9.0...v0.10.0) (2026-09-11)


### Features

* add axl_describe_operation tool with full schema extraction ([0dc71a6](https://github.com/calltelemetry/cisco-axl-mcp/commit/0dc71a60769d81eb264ea17dcbb9be673321231d))
* add bounded CUCM AXL credential rotation ([#181](https://github.com/calltelemetry/cisco-axl-mcp/issues/181)) ([b5b7226](https://github.com/calltelemetry/cisco-axl-mcp/commit/b5b722636c4170e9341c85c4b37197a0c71f1b76))
* add MCP tool annotations (readOnly, destructive, idempotent, openWorld) ([bf6cdc9](https://github.com/calltelemetry/cisco-axl-mcp/commit/bf6cdc97e9719660454a0ba307e8593cf954ecbc))
* add schema-driven CUCM AXL CLI package ([#162](https://github.com/calltelemetry/cisco-axl-mcp/issues/162)) ([79e94a3](https://github.com/calltelemetry/cisco-axl-mcp/commit/79e94a36903847f02f6455b8933cb72833263ad6))
* add SQL tools, auto-pagination, retry, and JSONL audit log ([ee473d6](https://github.com/calltelemetry/cisco-axl-mcp/commit/ee473d68bf720237a3de10c0c771d3669b487835))
* harden AXL MCP execution and release contract ([#173](https://github.com/calltelemetry/cisco-axl-mcp/issues/173)) ([323ab47](https://github.com/calltelemetry/cisco-axl-mcp/commit/323ab47e3a0f643da8cdb97c2a8069252de15d21))
* replace hardcoded TARGET_OPERATIONS with dynamic core object detection ([b04a7e0](https://github.com/calltelemetry/cisco-axl-mcp/commit/b04a7e08b82c2e4b77fcc2e4cf1a82dc0e46e942))


### Bug Fixes

* **ci:** remove yarn cache from setup-node to fix corepack error ([3f6ffdc](https://github.com/calltelemetry/cisco-axl-mcp/commit/3f6ffdc21fa8c3b2ef029b66a3e196456acecc24))
* default to permissive TLS for self-signed CUCM ([a480d0b](https://github.com/calltelemetry/cisco-axl-mcp/commit/a480d0b0622134f3f1f495ee2b1ba1986a6d46d1))
* standardize credential env vars, add cisco-ris-mcp to related servers ([7192583](https://github.com/calltelemetry/cisco-axl-mcp/commit/7192583a3c3e6652a667d61ca448fb2822a26f54))
* trigger release after branch protection update ([fd8a9a8](https://github.com/calltelemetry/cisco-axl-mcp/commit/fd8a9a8f8400bd36e13ef839cc175d4448023ce8))
* use configured release app id ([#174](https://github.com/calltelemetry/cisco-axl-mcp/issues/174)) ([57bd0e2](https://github.com/calltelemetry/cisco-axl-mcp/commit/57bd0e2d6dcb51b339ef7db562db4ec33490f453))

## [0.8.0](https://github.com/calltelemetry/cisco-axl-mcp/compare/v0.7.0...v0.8.0) (2026-08-24)


### Features

* add bounded CUCM AXL credential rotation ([#181](https://github.com/calltelemetry/cisco-axl-mcp/issues/181)) ([b5b7226](https://github.com/calltelemetry/cisco-axl-mcp/commit/b5b722636c4170e9341c85c4b37197a0c71f1b76))

## [0.7.0](https://github.com/calltelemetry/cisco-axl-mcp/compare/v0.6.0...v0.7.0) (2026-08-22)


### Features

* harden AXL MCP execution and release contract ([#173](https://github.com/calltelemetry/cisco-axl-mcp/issues/173)) ([323ab47](https://github.com/calltelemetry/cisco-axl-mcp/commit/323ab47e3a0f643da8cdb97c2a8069252de15d21))


### Bug Fixes

* use configured release app id ([#174](https://github.com/calltelemetry/cisco-axl-mcp/issues/174)) ([57bd0e2](https://github.com/calltelemetry/cisco-axl-mcp/commit/57bd0e2d6dcb51b339ef7db562db4ec33490f453))

## [0.6.0](https://github.com/calltelemetry/cisco-axl-mcp/compare/v0.5.1...v0.6.0) (2026-08-21)


### Features

* add schema-driven CUCM AXL CLI package ([#162](https://github.com/calltelemetry/cisco-axl-mcp/issues/162)) ([79e94a3](https://github.com/calltelemetry/cisco-axl-mcp/commit/79e94a36903847f02f6455b8933cb72833263ad6))
