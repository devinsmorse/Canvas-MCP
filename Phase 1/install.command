#!/bin/bash
# =====================================================================
# Canvas MCP — Phase 1 installer (read-only). Double-click to run.
#
# What it does, in order (nothing is sent anywhere except Canvas):
#   1. Finds Node.js on this Mac.
#   2. Asks for your course links and short labels.
#   3. Copies the server to /usr/local/lib/canvas-mcp and the course list to
#      /usr/local/etc/canvas-mcp, owned by root (needs your Mac password once),
#      so nothing running as you, Claude included, can change them.
#   4. Stores each Canvas token in your login Keychain (you paste it; it is
#      never shown or saved anywhere else).
#   5. Adds the server to the Claude app's settings (backup kept).
#   6. Runs a self-test that prints counts only, never names.
# Undo everything with uninstall.command.
# =====================================================================
set -u
cd "$(dirname "$0")"
LIB=/usr/local/lib/canvas-mcp
ETC=/usr/local/etc/canvas-mcp
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Canvas MCP — Phase 1 (read-only) installer"

# 1. Node.js -----------------------------------------------------------
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  say "Node.js is not installed."
  echo "Install the LTS version from https://nodejs.org (the macOS Installer .pkg), then double-click this file again."
  read -r -p "Press Return to close." _; exit 1
fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then say "Node.js $MAJOR is too old (need 18 or later). Update it from https://nodejs.org and run this again."; read -r -p "Press Return to close." _; exit 1; fi
echo "Using Node.js $("$NODE" -v) at $NODE"

# 2. Courses -----------------------------------------------------------
say "Step 2 of 6: your courses"
echo "Paste the link to each course you want connected, one at a time"
echo "(open the course in Canvas and copy the address, e.g. https://uncch.instructure.com/courses/12345)."
echo "Press Return on an empty line when done."
TMPC=$(mktemp)
echo '[]' > "$TMPC"
while true; do
  read -r -p "Course link: " URL
  [ -z "$URL" ] && break
  if [[ ! "$URL" =~ ^https://([^/]+)/courses/([0-9]+) ]]; then echo "  That doesn't look like a Canvas course link; try again."; continue; fi
  HOST="${BASH_REMATCH[1]}"; ID="${BASH_REMATCH[2]}"
  case "$HOST" in *unc*) INST=unc;; *elon*) INST=elon;; *) INST="${HOST%%.*}";; esac
  read -r -p "  Short label for course $ID (e.g. PHIL 143): " LABEL
  "$NODE" -e '
    const fs=require("fs"); const [f,inst,host,id,label]=process.argv.slice(1);
    const a=JSON.parse(fs.readFileSync(f)); a.push({instance:inst, base:"https://"+host, id:Number(id), label:label||("course "+id)});
    fs.writeFileSync(f, JSON.stringify(a));' "$TMPC" "$INST" "$HOST" "$ID" "$LABEL"
  echo "  Added $LABEL ($INST, course $ID)."
done
COUNT=$("$NODE" -p "JSON.parse(require('fs').readFileSync('$TMPC')).length")
if [ "$COUNT" -eq 0 ]; then
  if [ -f "$ETC/courses.json" ]; then echo "No new courses entered; keeping the existing course list."; else say "No courses entered. Nothing installed."; read -r -p "Press Return to close." _; exit 1; fi
else
  "$NODE" -e '
    const fs=require("fs"); const a=JSON.parse(fs.readFileSync(process.argv[1]));
    const instances={}; a.forEach(c=>{ instances[c.instance]={base:c.base}; });
    fs.writeFileSync(process.argv[1], JSON.stringify({instances, courses:a.map(c=>({instance:c.instance,id:c.id,label:c.label}))}, null, 1));' "$TMPC"
fi

# 3. Install root-owned files ------------------------------------------
say "Step 3 of 6: installing (your Mac password is needed once)"
sudo mkdir -p "$LIB" "$ETC" || { echo "Install cancelled."; exit 1; }
sudo install -o root -g wheel -m 644 server.js scrub.js roster.js canvas.js "$LIB/" || exit 1
[ "$COUNT" -gt 0 ] && sudo install -o root -g wheel -m 644 "$TMPC" "$ETC/courses.json"
sudo chown root:wheel "$LIB" "$ETC"; sudo chmod 755 "$LIB" "$ETC"
rm -f "$TMPC"
echo "Installed to $LIB (owned by root)."

# 4. Tokens in the Keychain ---------------------------------------------
say "Step 4 of 6: Canvas tokens"
for INST in $("$NODE" -p "Object.keys(JSON.parse(require('fs').readFileSync('$ETC/courses.json')).instances).join(' ')"); do
  BASE=$("$NODE" -p "JSON.parse(require('fs').readFileSync('$ETC/courses.json')).instances['$INST'].base")
  if security find-generic-password -s canvas-mcp -a "$INST" >/dev/null 2>&1; then
    read -r -p "A token for $INST is already saved. Replace it? (y/N) " R; [[ "$R" =~ ^[Yy] ]] || continue
  fi
  echo "In Canvas ($BASE): Account → Settings → + New Access Token."
  echo "  Purpose: Claude Canvas MCP.  Expires: the last day of term."
  echo "  Copy the token, then paste it below (it won't show as you paste; press Return)."
  security add-generic-password -U -s canvas-mcp -a "$INST" -l "Canvas MCP ($INST)" -w || echo "  Token not saved for $INST."
done

# 5. Claude app settings -------------------------------------------------
say "Step 5 of 6: adding the server to the Claude app"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.before-canvas-mcp.$(date +%Y%m%d%H%M%S)"
"$NODE" -e '
  const fs=require("fs"); const [f,node,lib]=process.argv.slice(1);
  let c={}; try { c=JSON.parse(fs.readFileSync(f,"utf8")); } catch(e) {}
  c.mcpServers=c.mcpServers||{}; c.mcpServers.canvas={command:node, args:[lib+"/server.js"]};
  fs.writeFileSync(f, JSON.stringify(c,null,2));' "$CFG" "$NODE" "$LIB"
echo "Added \"canvas\" to the Claude app settings (backup saved next to it)."

# 6. Self-test ------------------------------------------------------------
say "Step 6 of 6: self-test (counts only)"
"$NODE" "$LIB/server.js" --selftest

say "Done. Quit the Claude app (Cmd-Q) and open it again, then tell Claude in chat: \"Canvas Phase 1 is installed.\""
read -r -p "Press Return to close." _
