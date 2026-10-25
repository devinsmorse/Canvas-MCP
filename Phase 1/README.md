# Canvas MCP — Phase 1 (read-only)

Plan and reasoning: https://claude.ai/artifact/TkxzNcjTM6PEHHswHhcai7

## Install
1. Double-click `install.command`. It asks for your course links, your Mac password once, and each Canvas token.
2. When it says Done, quit the Claude app (Cmd-Q) and reopen it.
3. Tell Claude: "Canvas Phase 1 is installed." Claude checks the rest from its side.

Running it again replaces the course list. `uninstall.command` removes everything (and reminds you to revoke the tokens in Canvas).

## Files
| File | What it is |
| --- | --- |
| `server.js` | The MCP server: the tool list, which fields each tool keeps, page-visibility logic. |
| `scrub.js` | De-identification: names, emails, login IDs, SIS IDs and user IDs become `{{type:S-XXXX}}` tags. Name matching is copied from the Mail bridge. A second, independent check withholds any response where an identifier survived. |
| `roster.js` | Builds the roster from Canvas enrollments plus the bridge's `roster.csv`, and shares `student-codes.json` with the bridge. |
| `canvas.js` | Talks to Canvas. GET only, and only to a fixed list of endpoints and parameters; submissions, grades, people, analytics and discussions are refused before any request. |
| `test/` | Tests against a fake Canvas full of made-up students (`node test/run-tests.js`). 51 checks. |

## Where things live after install
- Server: `/usr/local/lib/canvas-mcp/` (owned by root)
- Course list: `/usr/local/etc/canvas-mcp/courses.json` (owned by root)
- Tokens: login Keychain, items named "Canvas MCP (unc)" / "Canvas MCP (elon)"
- Private, never sent to Claude: `~/Library/Application Support/Claude Bridge/` — `student-codes.json` (shared with the bridge), `canvas-roster.json`, `canvas-mcp-log.txt` (tool names and sizes, no content)
