#!/bin/bash
# Canvas MCP — removes everything install.command added. Double-click to run.
# Keeps student-codes.json (shared with the Mail bridge) and roster.csv.
# Deletes only the Keychain tokens of the Canvas sites this Mac was set up for
# (instances.txt, plus the course list), and the Claude app's "canvas" entry
# only if it runs this installation.
set -u
cd "$(dirname "$0")"
HERE="$PWD"
LIB=/usr/local/lib/canvas-mcp
ETC=/usr/local/etc/canvas-mcp
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PRIV="$HOME/Library/Application Support/Claude Bridge"
NODE=$(for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do [ -x "$c" ] && echo "$c" && break; done)
echo "Removing Canvas MCP (your Mac password is needed once)."

# Tokens: every site the installer recorded, plus any in the course list
# (installs before v1.2 kept no record).
NAMES=$( { cat "$ETC/instances.txt" 2>/dev/null
           [ -n "$NODE" ] && "$NODE" -e 'try { console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).instances).join("\n")); } catch (e) { /* no list */ }' "$ETC/courses.json"
         } | grep -E '^[a-z0-9-]{1,32}$' | sort -u )
for INST in $NAMES; do
  security delete-generic-password -s canvas-mcp -a "$INST" >/dev/null 2>&1 && echo "Deleted the $INST token from the Keychain."
done
if security find-generic-password -s canvas-mcp >/dev/null 2>&1; then
  echo "A Keychain item named \"canvas-mcp\" is still there that this install didn't record."
  echo "  If it is an old Canvas MCP token, delete it in Keychain Access (search for canvas-mcp)."
fi

if [ -n "$NODE" ] && [ -f "$HERE/claude-config.js" ]; then
  "$NODE" "$HERE/claude-config.js" remove "$CFG" "$LIB" || echo "  If it is this server, remove \"canvas\" from $CFG by hand."
else
  echo "Node.js or claude-config.js not found; remove \"canvas\" from $CFG by hand."
fi

sudo rm -rf "$LIB" "$ETC"
rm -f "$PRIV/canvas-roster.json" "$PRIV/canvas-mcp-log.txt"
echo "Done. Quit the Claude app (Cmd-Q) so the running server stops."
echo "Also revoke the tokens in Canvas: Account → Settings → Approved Integrations → Delete."
read -r -p "Press Return to close." _
