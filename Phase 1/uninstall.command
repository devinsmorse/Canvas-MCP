#!/bin/bash
# Canvas MCP — removes everything install.command added. Double-click to run.
# Keeps student-codes.json (shared with the Mail bridge) and roster.csv.
set -u
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
NODE=$(for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do [ -x "$c" ] && echo "$c" && break; done)
echo "Removing Canvas MCP (your Mac password is needed once)."
sudo rm -rf /usr/local/lib/canvas-mcp /usr/local/etc/canvas-mcp
for INST in unc elon; do security delete-generic-password -s canvas-mcp -a "$INST" >/dev/null 2>&1 && echo "Deleted the $INST token from the Keychain."; done
if [ -n "$NODE" ] && [ -f "$CFG" ]; then
  "$NODE" -e 'const fs=require("fs"),f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8")); if(c.mcpServers) delete c.mcpServers.canvas; fs.writeFileSync(f, JSON.stringify(c,null,2));' "$CFG" && echo "Removed \"canvas\" from the Claude app settings."
fi
rm -f "$HOME/Library/Application Support/Claude Bridge/canvas-roster.json"
echo "Done. Also revoke the tokens in Canvas: Account → Settings → Approved Integrations → Delete."
read -r -p "Press Return to close." _
