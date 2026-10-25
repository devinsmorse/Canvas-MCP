#!/bin/bash
# =====================================================================
# Canvas MCP — Phase 1 installer (read-only). Double-click to run.
#
# What it does, in order (nothing is sent anywhere except Canvas):
#   1. Finds Node.js on this Mac, and checks the Claude app's settings can be
#      updated (it stops here if they can't, before changing anything).
#   2. Asks for your course links and short labels. Only links on the Canvas
#      sites listed in canvas.js (SITES) are accepted, so a token can't be sent
#      anywhere else.
#   3. Copies the server to /usr/local/lib/canvas-mcp and the course list to
#      /usr/local/etc/canvas-mcp, owned by root (needs your Mac password once),
#      so nothing running as you, Claude included, can change them. It also
#      keeps instances.txt there: every Canvas site this Mac has been set up
#      for, so uninstall.command knows exactly which tokens to delete.
#   4. Stores each Canvas token in your login Keychain (you paste it; it is
#      never shown or saved anywhere else).
#   5. Adds the server to the Claude app's settings (backup kept). A different
#      server already named "canvas" is left alone.
#   6. Runs a self-test that prints counts only, never names.
# Undo everything with uninstall.command.
# =====================================================================
set -u
cd "$(dirname "$0")"
HERE="$PWD"
LIB=/usr/local/lib/canvas-mcp
ETC=/usr/local/etc/canvas-mcp
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
stop() { say "$*"; read -r -p "Press Return to close." _; exit 1; }

say "Canvas MCP — Phase 1 (read-only) installer"

# 1. Node.js and the Claude app settings ---------------------------------
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  stop "Node.js is not installed. Install the LTS version from https://nodejs.org (the macOS Installer .pkg), then double-click this file again."
fi
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then stop "Node.js $MAJOR is too old (need 18 or later). Update it from https://nodejs.org and run this again."; fi
echo "Using Node.js $("$NODE" -v) at $NODE"
"$NODE" "$HERE/claude-config.js" check "$CFG" "$LIB" || stop "Nothing was installed."

# 2. Courses -----------------------------------------------------------
say "Step 2 of 6: your courses"
echo "Paste the link to each course you want connected, one at a time"
echo "(open the course in Canvas and copy the address, e.g. https://canvas.unc.edu/courses/12345)."
echo "Press Return on an empty line when done."
TMPC=$(mktemp); TMPI=$(mktemp)
trap 'rm -f "$TMPC" "$TMPI"' EXIT
echo '[]' > "$TMPC"
while true; do
  read -r -p "Course link: " URL || break
  [ -z "$URL" ] && break
  # canvas.js parses the link as a URL and knows which Canvas site it belongs to
  if ! PARSED=$("$NODE" "$HERE/canvas.js" course-link "$URL" 2>&1); then echo "  Not added: $PARSED"; continue; fi
  IFS=$'\t' read -r INST BASE ID <<< "$PARSED"
  read -r -p "  Short label for course $ID (e.g. PHIL 143): " LABEL || LABEL=""
  # Entering a course again replaces it; the server refuses duplicate courses and labels.
  if ! MSG=$("$NODE" -e '
    const fs=require("fs"); const [f,inst,base,id,typed]=process.argv.slice(1);
    const label=(typed||"").trim()||("course "+id);
    if (label.length>80) { console.log("the label is longer than 80 characters"); process.exit(1); }
    const a=JSON.parse(fs.readFileSync(f,"utf8")).filter(c=>!(c.instance===inst && c.id===Number(id)));
    if (a.some(c=>c.label.toLowerCase()===label.toLowerCase())) { console.log("another course already has the label \""+label+"\""); process.exit(1); }
    a.push({instance:inst, base, id:Number(id), label});
    fs.writeFileSync(f, JSON.stringify(a));' "$TMPC" "$INST" "$BASE" "$ID" "$LABEL"); then
    echo "  Not added: $MSG"; continue
  fi
  echo "  Added ${LABEL:-course $ID} ($INST, course $ID)."
done
COUNT=$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length' "$TMPC")
if [ "$COUNT" -eq 0 ]; then
  [ -f "$ETC/courses.json" ] || stop "No courses entered. Nothing installed."
  LIST="$ETC/courses.json"
  echo "No new courses entered; keeping the existing course list."
else
  "$NODE" -e '
    const fs=require("fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const instances={}; a.forEach(c=>{ instances[c.instance]={base:c.base}; });
    fs.writeFileSync(process.argv[1], JSON.stringify({instances, courses:a.map(c=>({instance:c.instance,id:c.id,label:c.label}))}, null, 1));' "$TMPC"
  LIST="$TMPC"
fi
# The list must pass the same checks the server makes when it starts (lists from
# before v1.2 could name any host).
if ! MSG=$(CANVAS_MCP_CONFIG="$LIST" "$NODE" -e '
  try { require(process.argv[1]).loadConfig({ clientOpts: () => ({ token: "" }) }); }
  catch (e) { console.log(e.message); process.exit(1); }' "$HERE/server.js"); then
  stop "The course list can't be used: $MSG. Run this again and paste your course links."
fi
# Every site ever set up on this Mac, so uninstall can find each token.
"$NODE" -e '
  const fs=require("fs"); const [list,old,out]=process.argv.slice(1);
  const names=new Set(Object.keys(JSON.parse(fs.readFileSync(list,"utf8")).instances));
  try { fs.readFileSync(old,"utf8").split("\n").forEach(n=>{ if (/^[a-z0-9-]{1,32}$/.test(n)) names.add(n); }); } catch (e) { /* first install */ }
  fs.writeFileSync(out, Array.from(names).sort().join("\n")+"\n");' "$LIST" "$ETC/instances.txt" "$TMPI"

# 3. Install root-owned files ------------------------------------------
say "Step 3 of 6: installing (your Mac password is needed once)"
sudo mkdir -p "$LIB" "$ETC" || stop "Install cancelled."
sudo install -o root -g wheel -m 644 server.js scrub.js roster.js canvas.js "$LIB/" || exit 1
if [ "$COUNT" -gt 0 ]; then sudo install -o root -g wheel -m 644 "$TMPC" "$ETC/courses.json" || exit 1; fi
sudo install -o root -g wheel -m 644 "$TMPI" "$ETC/instances.txt" || exit 1
sudo chown root:wheel "$LIB" "$ETC"; sudo chmod 755 "$LIB" "$ETC"
echo "Installed to $LIB (owned by root)."

# 4. Tokens in the Keychain ---------------------------------------------
say "Step 4 of 6: Canvas tokens"
for INST in $("$NODE" -p 'Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).instances).join(" ")' "$ETC/courses.json"); do
  BASE=$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).instances[process.argv[2]].base' "$ETC/courses.json" "$INST")
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
[ -f "$CFG" ] && cp "$CFG" "$CFG.before-canvas-mcp.$(date +%Y%m%d%H%M%S)"
"$NODE" "$HERE/claude-config.js" add "$CFG" "$LIB" "$NODE" || stop "Fix the Claude app settings, then run this installer again."
echo "  (A backup of the old settings is saved next to them.)"

# 6. Self-test ------------------------------------------------------------
say "Step 6 of 6: self-test (counts only)"
"$NODE" "$LIB/server.js" --selftest

say "Done. Quit the Claude app (Cmd-Q) and open it again, then tell Claude in chat: \"Canvas Phase 1 is installed.\""
read -r -p "Press Return to close." _
