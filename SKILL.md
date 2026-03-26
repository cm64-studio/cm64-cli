# CM64 CLI — AI Model Reference

This is the primary reference for AI models (Claude, GPT, etc.) using the `cm64` CLI to build and manage CM64 Studio projects.

## Quick Start

```bash
cm64 register                # Create account (first time)
cm64 login                   # Login with email + code (interactive)
cm64 login <token>           # Or login with an existing PAT token
cm64 projects                # List available projects
cm64 use <project_id|domain> # Set active project by ID or domain
cm64 pull                    # Pull all files into ./domain/ folder
cm64 ls                      # List all files
cm64 read component/Header   # Read a file
cm64 write component/Header --content '...'  # Write a file
cm64 push                    # Push local changes to server
cm64 status                  # Quick one-liner context check
```

## Critical Rules

### 1. File classes are SINGULAR
Always use singular form: `page`, `component`, `function`, `css`, `setting`, `database`, `asset`

NEVER use plural: ~~pages~~, ~~components~~, ~~functions~~, ~~settings~~

```bash
cm64 read component/Header    # correct
cm64 read components/Header   # auto-corrected to singular, but avoid
```

### 2. `cm64 use` persists
Set once, stays active across all commands. Saved to `~/.cm64/config.json`.
Do NOT call `cm64 use` again unless switching to a different project.

### 3. Read before write
`cm64 read` caches the file hash locally. `cm64 write` auto-detects conflicts using the cached hash.

```bash
cm64 read component/Header     # Caches hash
# ... make changes ...
cm64 write component/Header --content '...'   # Auto-sends cached hash for conflict check
```

### 4. Use `cm64 diff` before writing
Check if a collaborator changed the file since you last read it:

```bash
cm64 diff component/Header
```

### 5. `cm64 status` for quick context
Faster than `cm64 info`. One line:
```
myapp (69a5...) | app.cm64.site | snapshot: v3 (production) | 24 files
```

### 6. `cm64 deploy latest` to deploy
```bash
cm64 snapshot "v1.0 - Login feature"   # Create snapshot
cm64 deploy latest                      # Pin latest snapshot to production
```

### 7. Pipe-friendly
```bash
cm64 read page/home | jq .                     # Parse JSON output
echo '{"title":"test"}' | cm64 write page/test  # Pipe content via stdin
cm64 read component/Header --json               # Structured JSON output
```

## All Commands

### Setup & Navigation
| Command | Description |
|---------|-------------|
| `cm64 register` | Create account with email + challenge (also: `signup`, `reg`) |
| `cm64 login` | Login with email + verification code (or `cm64 login <token>`) |
| `cm64 projects [--query x]` | List projects (also searches by domain when query contains a dot) |
| `cm64 use <project_id\|domain>` | Set active project by ID or domain (persists) |
| `cm64 create <name>` | Create new project (`--domain`, `--template`, `--description`) |
| `cm64 status` | One-liner: name, domain, snapshot, file count |
| `cm64 info` | Full project metadata, file counts, domains |

### File Operations
| Command | Description |
|---------|-------------|
| `cm64 ls [--class component]` | List files, optionally filtered by class |
| `cm64 read <class/name>` | Read file content (auto-caches hash) |
| `cm64 write <class/name>` | Write file (--content, -f file, or stdin) |
| `cm64 write-many` | Bulk write files (JSON array from stdin) |
| `cm64 edit <class/name> --old "x" --new "y"` | Find-and-replace edit |
| `cm64 diff <class/name>` | Compare local cached vs remote version |
| `cm64 delete <class/name>` | Delete a file |
| `cm64 rename <class/name> <class/new-name>` | Rename or move a file (also: `mv`, `move`) |

### Search
| Command | Description |
|---------|-------------|
| `cm64 search <pattern> [--class function]` | Regex search across file contents |
| `cm64 glob <pattern>` | Glob pattern match on file paths |

### Deploy
| Command | Description |
|---------|-------------|
| `cm64 snapshot <name>` | Create a named snapshot |
| `cm64 deploy <snapshot_id\|latest>` | Pin snapshot to production |
| `cm64 history <class/name>` | View file version history |

### Project
| Command | Description |
|---------|-------------|
| `cm64 buildme` | Read BUILDME.md |
| `cm64 buildme --set "content"` | Update BUILDME.md |
| `cm64 learn [skill_name]` | Load skill documentation |

### Data
| Command | Description |
|---------|-------------|
| `cm64 users [--search x]` | App end-user management |
| `cm64 analytics [--days 7]` | Product analytics |
| `cm64 debug [--pattern x]` | Execution logs |

## File Classes

| Class | Type | Description |
|-------|------|-------------|
| `page` | JSON | Page definitions (layout, components, data binding) |
| `component` | JSX | React components |
| `function` | JSX | Server-side API endpoints and logic |
| `css` | CSS | Stylesheets |
| `setting` | JSON | Configuration files |
| `database` | JSON | MongoDB schema definitions |
| `asset` | various | Static files (images, fonts) |

## Workflow Example (git-like)

```bash
# 1. Set up — use domain or project ID
cm64 use myapp.cm64.site

# 2. Pull all files locally (creates ./myapp.cm64.site/ folder)
cm64 pull

# 3. Load context — always check skills before building
cm64 load
cm64 skills
cm64 learn <skill_name>

# 4. Work on files locally
#    Edit components in ./myapp.cm64.site/component/
#    Edit pages in ./myapp.cm64.site/page/

# 5. Push changes back
cm64 push

# 6. Deploy
cm64 snapshot "v1.0 - New header"
cm64 deploy latest
```

### Alternative: Direct read/write workflow

```bash
cm64 read page/home
cm64 write component/Header --content '...'
cm64 edit page/home --old '"title": "Old"' --new '"title": "New"'
```

## Conflict Detection

The CLI automatically tracks file hashes for conflict detection:

1. `cm64 read` saves the file's hash to `~/.cm64/cache/<project_id>/`
2. `cm64 write` automatically sends the cached hash as `base_hash`
3. If the file changed remotely since the last read, the server returns a conflict error
4. Use `--force` to skip conflict detection

```bash
cm64 read component/Header         # hash cached: abc123
# ... collaborator edits Header ...
cm64 write component/Header ...    # ERROR: conflict detected
cm64 diff component/Header         # See what changed
cm64 read component/Header         # Get latest version
cm64 write component/Header ...    # Now write succeeds
```

## Output Modes

- **Default**: Human-readable text to stdout, status/errors to stderr
- **`--json`**: Structured JSON to stdout (for piping/parsing)
- **Pipe detection**: Content from stdin is auto-detected

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CM64_TOKEN` | Override authentication token |
| `CM64_ENDPOINT` | Override API endpoint |
| `CM64_PROJECT` | Override active project ID |

## Config File

Location: `~/.cm64/config.json`

```json
{
  "endpoint": "https://build.cm64.io/api/cli",
  "token": "cm64_pat_...",
  "project_id": "69a5b...",
  "project_name": "My App",
  "project_domain": "myapp.cm64.site"
}
```
