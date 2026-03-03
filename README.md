# @cm64/cli

Stateless command-line tool for [CM64 Studio](https://build.cm64.io). Build, manage, and deploy web applications from your terminal or AI agent.

## Install

```bash
npm install -g @cm64/cli
```

## Quick Start

```bash
# 1. Login with your Personal Access Token
cm64 login cm64_pat_abc123

# 2. List your projects
cm64 projects

# 3. Set active project
cm64 use 69a5b1234567890abcdef12

# 4. Start building
cm64 ls                              # List all files
cm64 read component/Header           # Read a file
cm64 write component/Header -f ./Header.jsx  # Write from local file
cm64 snapshot "v1.0"                  # Create snapshot
cm64 deploy latest                    # Deploy to production
```

## How It Works

Each command is a single HTTP POST to `/api/cli`. No sessions, no persistent connections, no MCP protocol overhead. Token and project ID stored locally in `~/.cm64/config.json`.

## For AI Models

See [SKILL.md](./SKILL.md) for comprehensive AI model documentation.

## Commands

### Setup
- `cm64 login [token]` — Authenticate
- `cm64 projects` — List projects
- `cm64 use <id>` — Set active project
- `cm64 create <name>` — Create project
- `cm64 status` — Quick one-liner status
- `cm64 info` — Full project metadata

### Files
- `cm64 ls` — List files
- `cm64 read <class/name>` — Read file
- `cm64 write <class/name>` — Write file
- `cm64 edit <class/name>` — Find-and-replace
- `cm64 diff <class/name>` — Compare cached vs remote
- `cm64 delete <class/name>` — Delete file

### Search
- `cm64 search <pattern>` — Grep across files
- `cm64 glob <pattern>` — Glob file paths

### Deploy
- `cm64 snapshot <name>` — Create snapshot
- `cm64 deploy <id|latest>` — Pin to production

### Data
- `cm64 users` — App end-users
- `cm64 analytics` — Product analytics
- `cm64 debug` — Execution logs

## Flags

- `--json` — Structured JSON output
- `--force` — Skip conflict detection
- `-f <file>` — Read content from local file

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CM64_TOKEN` | Auth token (overrides config) |
| `CM64_ENDPOINT` | API endpoint (default: `https://build.cm64.io/api/cli`) |
| `CM64_PROJECT` | Active project ID (overrides config) |

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
