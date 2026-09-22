# MCP engine provenance

Vendored from `pi-mcp-adapter` 2.34.0, published by Nico Bailon under the MIT license. The original license is retained in `LICENSE`.

Source: https://github.com/nicobailon/pi-mcp-adapter

Pix imports this source directly; this directory's original package manifest is retained for provenance, not installed as a separate Pi package. Runtime dependencies are declared in Pix's package manifest. No upstream skill is automatically added to the model context.

Pix's integration is `extensions/mcp.ts`. It owns tool activation, discovery, and gateway descriptions. The engine retains configuration discovery, transports, authentication stores, server management, and MCP protocol behavior. Existing configuration and credential locations are unchanged.

For updates, replace this snapshot deliberately, review its runtime dependencies and public API, and run Pix's MCP integration and full regression tests. Do not enable the standalone adapter alongside the Pix entry point.
