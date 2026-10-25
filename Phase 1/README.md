# Canvas MCP — Phase 1 (read-only)

Plan and reasoning: https://claude.ai/artifact/TkxzNcjTM6PEHHswHhcai7

## Install
1. Double-click `install.command`. It asks for your course links, your Mac password once, and each Canvas token.
2. When it says Done, quit the Claude app (Cmd-Q) and reopen it.
3. Tell Claude: "Canvas Phase 1 is installed." Claude checks the rest from its side.

## The Keychain prompt
Each token is stored with no app trusted to read it, so every read shows a macOS prompt ("security wants to use … Canvas MCP (unc)"). That keeps anything else running as you, including Claude Code, from reading the token silently. You'll see it once per Canvas site during the install self-test, and again the first time Claude uses each site after the Claude app starts.
- Click **Allow** (and type your Mac password if it asks). **Never Always Allow**: that puts the `security` tool on the trusted list, and the protection is gone until you reinstall the token.
- If the prompt appears when you aren't using Canvas with Claude, click **Deny**.
- The server waits 90 seconds for an answer. After a Deny or no answer it says so and doesn't ask again for 10 minutes.

Running it again replaces the course list. It stops before changing anything if the Claude app's settings aren't valid JSON, or if a different server named "canvas" is already there.

`uninstall.command` removes everything: the Keychain tokens of every Canvas site the installer recorded, the Claude app's "canvas" entry (only if it runs this installation), the roster cache and the log. It keeps `student-codes.json` and `roster.csv`, which the Mail bridge uses, tells you about any other "canvas-mcp" Keychain item it finds, and reminds you to revoke the tokens in Canvas.

## Canvas sites
Tokens can only be sent to these sites, at exactly these addresses (`SITES` in `canvas.js`, root-owned once installed). Course links may use either address in the Links column.

| Instance (Keychain account) | API address | Links |
| --- | --- | --- |
| `unc` | `https://uncch.instructure.com` | `uncch.instructure.com`, `canvas.unc.edu` |
| `elon` | `https://elon.instructure.com` | `elon.instructure.com`, `canvas.elon.edu` |

Checked on 2026-10-25: both API addresses answer Canvas API requests directly; `canvas.elon.edu` redirects to `elon.instructure.com`, which signs in through `idp.elon.edu`. To add a site, check it the same way and add its exact addresses; never match by suffix.

## Files
| File | What it is |
| --- | --- |
| `server.js` | The MCP server: the tool list, which fields each tool keeps, page-visibility logic. |
| `scrub.js` | De-identification: names, emails, login IDs, SIS IDs and user IDs become `{{type:S-XXXX}}` tags. Name matching is copied from the Mail bridge. A second check (plain substring search for full names and IDs; it shares only the text-decoding step with the matcher) withholds any response where an identifier survived. |
| `roster.js` | Builds the roster from Canvas enrollments plus the bridge's `roster.csv`, and shares `student-codes.json` with the bridge. |
| `canvas.js` | Talks to Canvas. GET only, only to the sites above, and only to a fixed list of endpoints and parameters; submissions, grades, people, analytics and discussions are refused before any request, and so are paths with encoded slashes, backslashes or dots. Also checks course links for the installer. |
| `claude-config.js` | Used by the installer and uninstaller to add or remove the "canvas" entry in the Claude app's settings without overwriting anything else. |
| `test/` | Tests against a fake Canvas full of made-up students (`node test/run-tests.js`). 186 checks. |

## Roster rules
- Enrollments are re-read every 6 hours, one course at a time. A course that fails keeps its last good copy; after a failure the server waits 10 minutes before trying again.
- If a course's students haven't been read for 24 hours, or no roster can be loaded at all, the tools refuse that course's text. A sync time in the future counts as never synced. `roster_status` says which course is failing (labels only).
- `courses.json` is checked whole when the server starts: an unknown site or address, a bad instance name, or a repeated course or label stops the server with the reason, instead of being skipped.
- In page text, a single first or last name is scrubbed in any case ("jane submitted"), except names that are also everyday words (`EVERYDAY` in `scrub.js`: will, long, price, young, ...), which only count when capitalised. In titles, file names and slugs every name counts in any case.
- A student's own two-letter names (Li, Wu, Ng, Xu, a preferred "Ed", ...) also count on their own. In page text only when written as a name ("Li", not "li", and not all-caps like "AI" or "MA"); in titles, file names and slugs in any case. Two-letter nicknames from the nickname table (ed, al, jo, zo) and the English words in `SHORT_WORDS` (he, an, do, ...) never count alone; with the surname they still do.
- Each part of a hyphenated first name counts on its own (Mary-Kate: Mary, Kate). A suffix or pronouns in a display name ("Jr.", "(she/her)", "[any pronouns]") are ignored when the roster is read; any other word in parentheses or brackets counts as another name for the student ("Xiaoming (Sam) Li": Sam; "Doe (Smith), Jane": Smith), except filler like "née" or "aka".
- First and last name joined by a dot or plus with no spaces ("will.long@gmail.com", "jane+doe") count as the full name, even for names that are everyday words. The final check looks for these forms, and for names from parentheses, only as whole words, so "swill.longitude" isn't taken for Will Long.
- A name with an apostrophe or hyphen also counts written without it or with a space or hyphen in its place: O'Brien as OBrien, obrien (as in URL slugs), O Brien, o-brien; Mary-Kate as MaryKate or Mary Kate; Ji-woo as Jiwoo. The final check reads any run of spaces, hyphens and underscores as one space, so "jose-de-la-cruz" counts as "jose de la cruz".
- Initials count as a name only with a dot ("J. Doe", "Doe, J.") or as capitals next to a capitalised surname ("J Doe", "JQ Doe"), so "a long reading" or "or Long" isn't taken for Alice or Olivia Long.
- `page_visibility` gives `visible_to_students: null` (with `after_requirements: true`) when it depends on each student's progress through prerequisites or sequential items.
- `get_course_settings` returns only the settings Canvas documents (`SETTING_FIELDS` in `server.js`); anything else is dropped until it has been looked at and added.

## Where things live after install
- Server: `/usr/local/lib/canvas-mcp/` (owned by root)
- Course list: `/usr/local/etc/canvas-mcp/courses.json`, and `instances.txt` (every Canvas site set up on this Mac, for uninstall), owned by root
- Tokens: login Keychain, items named "Canvas MCP (unc)" / "Canvas MCP (elon)", no trusted apps (see The Keychain prompt)
- Private, never sent to Claude: `~/Library/Application Support/Claude Bridge/` — `student-codes.json` (shared with the bridge), `canvas-roster.json`, `canvas-mcp-log.txt` (tool names and sizes, no content)
