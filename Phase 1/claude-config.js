'use strict';
// =====================================================================
// Canvas MCP — Claude app settings (used by install.command and uninstall.command)
//
//   node claude-config.js check  <settings.json> <lib dir>
//   node claude-config.js add    <settings.json> <lib dir> <node>
//   node claude-config.js remove <settings.json> <lib dir>
//
// A settings file that isn't valid JSON is never rewritten. A "canvas" entry
// that doesn't run <lib dir>/server.js belongs to something else, so it is
// never replaced or removed. Writes go to a private temp file, then rename.
// Exit code 1 (with a one-line reason) means nothing was changed.
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function read(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  let c;
  try { c = JSON.parse(text); } catch (e) { throw new Error('the Claude app settings file is not valid JSON (' + e.message + '); it was left as it is: ' + file); }
  if (!isObj(c) || (c.mcpServers !== undefined && !isObj(c.mcpServers))) throw new Error('the Claude app settings file is not laid out as expected; it was left as it is: ' + file);
  return c;
}

// Ours = runs this installation's server.js.
const ours = (entry, lib) => isObj(entry) && Array.isArray(entry.args) && entry.args.some(a => typeof a === 'string' && path.resolve(a) === path.resolve(lib, 'server.js'));
const entryOf = c => (c.mcpServers && Object.prototype.hasOwnProperty.call(c.mcpServers, 'canvas') ? c.mcpServers.canvas : undefined);

function write(file, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (e) { /* new file stays private */ }
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing left behind */ }
    throw e;
  }
}

function check(file, lib) {
  const e = entryOf(read(file));
  if (e !== undefined && !ours(e, lib)) throw new Error('the Claude app already has a different MCP server named "canvas"; rename or remove it, then run this again');
  return 'Claude app settings can be updated.';
}
function add(file, lib, node) {
  const c = read(file);
  const e = entryOf(c);
  if (e !== undefined && !ours(e, lib)) throw new Error('the Claude app already has a different MCP server named "canvas"; it was left as it is');
  c.mcpServers = c.mcpServers || {};
  c.mcpServers.canvas = { command: node, args: [path.resolve(lib, 'server.js')] };
  write(file, c);
  return 'Added "canvas" to the Claude app settings.';
}
function remove(file, lib) {
  if (!fs.existsSync(file)) return 'No Claude app settings file; nothing to remove.';
  const c = read(file);
  const e = entryOf(c);
  if (e === undefined) return 'No "canvas" entry in the Claude app settings.';
  if (!ours(e, lib)) return 'The "canvas" entry in the Claude app settings runs something else, so it was left as it is.';
  delete c.mcpServers.canvas;
  write(file, c);
  return 'Removed "canvas" from the Claude app settings.';
}

module.exports = { read, ours, check, add, remove };

if (require.main === module) {
  const [mode, file, lib, node] = process.argv.slice(2);
  const commands = { check: () => check(file, lib), add: () => add(file, lib, node), remove: () => remove(file, lib) };
  try {
    if (!Object.prototype.hasOwnProperty.call(commands, mode) || !file || !lib || (mode === 'add' && !node)) throw new Error('usage: claude-config.js check|add|remove <settings.json> <lib dir> [node]');
    console.log('  ' + commands[mode]());
  } catch (e) {
    console.log('  Stopped: ' + e.message);
    process.exit(1);
  }
}
