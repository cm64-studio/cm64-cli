---
name: cm64
description: Build and deploy web apps with CM64 Studio CLI — pull, edit, push, deploy. Use when working with cm64 commands or CM64 Studio projects.
argument-hint: "[command or question]"
---

# CM64 CLI — Agent Reference

Use this when working with CM64 Studio projects via the `cm64` CLI.

## Quick Start

```bash
cm64 register                # Create account (first time)
cm64 login                   # Login with email + code
cm64 projects                # List projects
cm64 use <project_id|domain> # Set active project
cm64 pull                    # Pull all files locally
cm64 push                    # Push changes back
```

## Rules

1. **File classes are SINGULAR**: `page`, `component`, `function`, `setting`, `database`, `asset` — never plural
2. **`cm64 use` persists** — set once, stays active. Don't repeat unless switching projects
3. **Read before write** — `cm64 read` caches the file hash, `cm64 write` uses it for conflict detection
4. **Load context first** — always run `cm64 load` + `cm64 skills` + `cm64 learn <skill>` before building
5. **Pipe-friendly** — stdout = results, stderr = status. Use `--json` for structured output. Stdin auto-detected for piping content

## Workflow

### Git-like (recommended)

```bash
cm64 use myapp.cm64.site          # Set project
cm64 load                          # Load system prompt context
cm64 skills                        # List available skills
cm64 learn <skill_name>            # Read skill docs before building
cm64 pull                          # Pull files into ./domain/ folder
# ... edit files locally ...
cm64 push                          # Push changes
cm64 snapshot "v1.0 - Feature X"   # Snapshot
cm64 deploy latest                 # Deploy
```

### Direct read/write

```bash
cm64 read component/Header
cm64 write component/Header --content '...'
cm64 edit page/home --old '"title": "Old"' --new '"title": "New"'
```

## All Commands

### Setup
| Command | Description |
|---------|-------------|
| `cm64 register` | Create account (email + challenge) |
| `cm64 login` | Login with email + code, or `cm64 login <token>` |
| `cm64 projects [--query x]` | List projects (searches name and domain) |
| `cm64 use <id\|domain>` | Set active project (persists to config) |
| `cm64 create <name>` | Create project (`--domain`, `--template`, `--description`) |
| `cm64 status` | One-liner: name, domain, snapshot, file count |
| `cm64 info` | Full project metadata |

### Files
| Command | Description |
|---------|-------------|
| `cm64 ls [--class component]` | List files, optionally by class |
| `cm64 read <class/name>` | Read file (caches hash for conflict detection) |
| `cm64 write <class/name>` | Write file (`--content`, `-f file`, or stdin) |
| `cm64 write-many` | Bulk write (JSON array from stdin) |
| `cm64 edit <class/name>` | Find-replace (`--old "x" --new "y"`) |
| `cm64 diff <class/name>` | Compare cached vs remote |
| `cm64 delete <class/name>` | Delete a file |
| `cm64 rename <from> <to>` | Rename/move file |

### Git-like Sync
| Command | Description |
|---------|-------------|
| `cm64 pull` | Pull all project files into `./domain/` folder |
| `cm64 push` | Push local changes to server |
| `cm64 sync` | Bidirectional sync (pull remote + push local) |
| `cm64 pull component/Hero` | Pull single file |
| `cm64 push component/Hero.jsx` | Push single file |
| `cm64 pull ./component/` | Pull all components |
| `cm64 push ./` | Push all local files |

### Search
| Command | Description |
|---------|-------------|
| `cm64 search <pattern>` | Grep across files (`--class`, `--limit`) |
| `cm64 glob <pattern>` | Glob file paths |

### Assets
| Command | Description |
|---------|-------------|
| `cm64 upload <name> -f <file>` | Upload asset (`--folder`, `--mime`) |
| `cm64 assets [--folder x]` | List assets with URLs |

### Deploy
| Command | Description |
|---------|-------------|
| `cm64 snapshot <name>` | Create named snapshot (`--description`) |
| `cm64 deploy <id\|latest>` | Pin snapshot to production (`--domain`) |
| `cm64 history <class/name>` | File version history |
| `cm64 restore <class/name>` | Restore version (`--version <id>`) |

### Project Context
| Command | Description |
|---------|-------------|
| `cm64 load` | System prompt (interpolated). `--raw` for uninterpolated |
| `cm64 skills` | List skills. `cm64 skills <name>` for details |
| `cm64 learn [skill]` | Read full skill documentation |
| `cm64 buildme` | Read BUILDME.md. `--set "content"` to update, `--append` |

### Data
| Command | Description |
|---------|-------------|
| `cm64 users [--search x]` | App end-users (`--role`, `--status`, `--page`, `--limit`) |
| `cm64 analytics [--days 7]` | Analytics (`--event`) |
| `cm64 debug [--pattern x]` | Logs (`--level`, `--limit`, `--since`) |

## File Classes

| Class | Extension | Description |
|-------|-----------|-------------|
| `page` | .json | Page definitions (layout, components, data binding) |
| `component` | .jsx | React components |
| `function` | .js | Server-side API endpoints and logic |
| `setting` | .json | Configuration files |
| `database` | .json | MongoDB schema definitions |
| `asset` | various | Static files (images, fonts, CSS, etc.) |

**Note**: All static files (CSS, images, fonts) go through `asset`. Use `cm64 upload` for these.

## Conflict Detection

1. `cm64 read` caches the file hash to `~/.cm64/cache/<project_id>/`
2. `cm64 write` / `cm64 push` auto-sends cached hash as `base_hash`
3. Server rejects if file changed remotely since last read
4. `cm64 diff <path>` to see what changed
5. `--force` / `-F` to skip conflict detection

## Project Creation

```bash
cm64 create "My App" --domain myapp --description "E-commerce with cart and checkout" --template existing.cm64.site
```

- `--domain` custom subdomain (myapp.cm64.site)
- `--template` clones files from existing project
- `--description` stored in project context — be specific, AI uses it

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CM64_TOKEN` | Override auth token |
| `CM64_ENDPOINT` | Override API endpoint |
| `CM64_PROJECT` | Override active project ID |

Config: `~/.cm64/config.json`
