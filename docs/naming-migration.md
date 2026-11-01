# OpenIndustries names and existing installations

New integrations use the OpenIndustries product name. The inference model selected
in OpenCode is independent of these MCP server and tool names.

| Surface | Canonical name | Compatibility |
| --- | --- | --- |
| MCP server identity / configuration label | `openindustries` | Existing client labels may remain unchanged |
| MCP entry point | `server/openindustries-mcp.mjs` | `server/astra-mcp.mjs` forwards to the same implementation |
| Discovered tools | `openindustries.*` | Existing `astra.*` calls dispatch to the same operations |
| CLI | `openindustries` / `cli/openindustries.mjs` | `astra` / `cli/astra.mjs` remain aliases |
| Configuration | `OI_ROOT`, `OI_SCENE_BACKEND`, other `OI_*` equivalents | Corresponding `ASTRA_*` names remain fallback inputs |

Only canonical tool names appear in `tools/list`; aliases do not double the model's
tool list. Both names preserve the same schemas, authorization checks, error codes,
image results, request IDs and persisted revision checks. An explicitly supplied
`OI_*` setting wins over its `ASTRA_*` counterpart, even when empty or `false`.

## Local OpenCode setup

Install Node.js 22.16+, run `npm ci`, and merge this entry into the installed
OpenCode version's configuration. Use absolute paths when the host runs elsewhere.
The repository `opencode.json` uses the legacy `mcp.<name>` layout; OpenCode V2
places the same entry under `mcp.servers.<name>`. Do not mix those layouts.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openindustries": {
      "type": "local",
      "command": ["node", "/absolute/path/OpenIndustries/server/openindustries-mcp.mjs"],
      "cwd": "/absolute/path/OpenIndustries",
      "enabled": true,
      "environment": {
        "OI_ROOT": "/absolute/path/OpenIndustries",
        "OI_SCENE_TOOLS_ENABLED": "true",
        "OI_SCENE_BACKEND": "local"
      }
    }
  }
}
```

Restart the MCP connection and run `opencode mcp list`. Discover the tools, call
`openindustries.list_scene_assets` with `{"version":1}`, and then use
`openindustries.create_scene`, `openindustries.read_scene` and
`openindustries.update_scene`. The local backend needs no Supabase credentials.
See [local persistence and portable export](mcp-scenes.md#local-persistence-without-supabase).

## Existing data and external addresses

This naming change does not migrate persistent data. Existing `.astra` state
directories, browser storage keys, `Mergence/auth.json` credentials, `astra.scene`
and other versioned file-format identifiers, cloud bucket names, and stored runtime
receipts retain their identities. Historical evidence and source hashes are retained.
The hosted deployment URL and third-party Form feedback route also keep their
existing addresses; renaming those requires a separate deployment/integration change.

To choose a different local scene directory, explicitly set `OI_SCENE_DATA_DIR`
to the same absolute path for MCP and CLI. Keep an existing populated directory
unless deliberately moving the complete database and assets together. An empty
directory is a different store, not a migration.

Verification includes real new/legacy stdio processes creating and reopening the
same scene, alias retry identity, historical revision reads, stale-update conflicts,
configuration precedence and both CLI entry points. Run `npm run test:mcp`.
