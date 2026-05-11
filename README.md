# @cm64/cli

Stateless command-line tool for [CM64 Studio](https://build.cm64.io). Build, manage, and deploy web applications from your terminal or AI agent.

## Install

```bash
npm install -g @cm64/cli
```

## Quick Start

The local-first workflow: pull the project to disk, edit with your editor, push back.

```bash
# 1. Login (one time)
cm64 login                                # email + verification code
# cm64 login cm64_pat_abc123              # ...or paste an existing PAT

# 2. Pick a project
cm64 projects                             # list yours
cm64 use my-app.cm64.site                 # set active (id or domain works)

# 3. The loop
cm64 pull                                 # → ./my-app.cm64.site/ + writes .cm64.workspace inside it
# edit files in your editor of choice
cd ./my-app.cm64.site                     # any cm64 commands from inside resolve to this project
cm64 push                                 # diffs against server, refuses to resurrect deleted files
cm64 push --check                         # preview what would change without uploading

# 4. Ship
cm64 snapshot "v1.0"                      # named checkpoint
cm64 deploy latest                        # pin to production
```

Useful one-liners:

```bash
cm64 status -v                            # snapshot pin, dynamic pages, last push, env keys, db counts
cm64 doctor                               # missing meta titles, OG images, no production pin, bad JSON
cm64 debug --function voteStory --since 2026-05-08
cm64 invalidate-cache                     # flush framework caches when something looks stale
cm64 learn seo                            # read a skill (also: cm64 learn with no arg = system prompt + skills index)
```

## How It Works

Each command is a single HTTP POST to `/api/cli`. No sessions, no persistent connections, no MCP protocol overhead. Token and project ID stored locally in `~/.cm64/config.json`.

## For AI Models

See [SKILL.md](./SKILL.md) for comprehensive AI model documentation.

## Commands

### Workflow (use these every day)
- `cm64 pull [path]` — Pull project (or one file/folder) to disk
- `cm64 push [path]` — Push local changes; warns if local files were deleted server-side
- `cm64 sync` — Bidirectional reconcile (`cm64 sync --help` for the full conflict policy)
- `cm64 use <id|domain>` — Set active project
- `cm64 status [-v]` — Context check (`-v` = full info)
- `cm64 info [-v]` — Project metadata
- `cm64 doctor` — Health checks (missing titles, OG, snapshots, bad JSON)
- `cm64 invalidate-cache [-t all|components|site]` — Flush framework caches
- `cm64 rename <from> <to>` — Move/rename a file (auto-flushes route cache for pages)
- `cm64 delete <class/name>` — Delete from server

### Context
- `cm64 learn` — System prompt + skills index (no arg)
- `cm64 learn <skill>` — Read full skill docs
- `cm64 skills` — List available skills
- `cm64 buildme` — Read/update BUILDME.md

### Assets
- `cm64 upload <name> -f <file>` — Upload to S3
- `cm64 assets` — List assets

### Deploy
- `cm64 snapshot <name>` — Create snapshot
- `cm64 deploy <id|latest>` — Pin to production
- `cm64 history <class/name>` — Version history
- `cm64 restore <class/name> --version <id>` — Roll back

### Data
- `cm64 users` — App end-users
- `cm64 analytics` — Product analytics
- `cm64 debug [--function x] [--source function|component]` — Server-side function logs

### Setup (mostly first-time)
- `cm64 register` — Create account
- `cm64 login [token]` — Authenticate
- `cm64 projects` — List projects
- `cm64 create <name>` — Create project

### Advanced (remote-only escape hatches)
Once you've pulled, your local editor + grep replace these. They're hidden from `cm64 help` by default — see `cm64 help --advanced`:
`ls`, `read`, `write`, `write-many`, `edit`, `diff`, `search`, `glob`.

**Singular vs plural**: server class is always singular (`function/foo.js`, not `functions/foo.js`). The CLI silently normalizes typed plurals at the parser level — type whatever, it works.

## Flags

- `--json` — Structured JSON output
- `--force` — Skip conflict detection
- `-f <file>` — Read content from local file

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CM64_TOKEN` | Auth token (overrides config) |
| `CM64_ENDPOINT` | API endpoint (default: `https://build.cm64.io/api/cli`) |
| `CM64_PROJECT` | Active project ID (highest priority — overrides workspace file and global config) |

## Project Resolution

The active project is resolved in this order — first match wins:

1. **`CM64_PROJECT` env var** — per-shell override.
2. **`.cm64.workspace` file** in the cwd or any ancestor directory — per-directory pin. `cm64 pull` writes this automatically into the project root, so future commands inside that tree resolve to the right project regardless of what other terminals are doing.
3. **`~/.cm64/config.json`** — global, shared across all terminals on the machine.

`cm64 status` prints `Project source: env|workspace|global` so you can tell at a glance which one is active. `cm64 use` updates both the global config and any nearby `.cm64.workspace` file (so it's never silently ignored when you run it from inside a pinned directory).

## Claude Code Integration

Add to your Claude Code MCP config to use `cm64` commands directly:

```json
{
  "mcpServers": {
    "cm64": {
      "command": "cm64",
      "args": ["--mcp", "--token", "cm64_pat_abc123"]
    }
  }
}
```

Or use the CLI directly — Claude Code can run `cm64` commands via its shell tool.

## Generate a Token

Visit [https://build.cm64.io/settings/tokens](https://build.cm64.io/settings/tokens) to create a Personal Access Token.

## License

MIT
