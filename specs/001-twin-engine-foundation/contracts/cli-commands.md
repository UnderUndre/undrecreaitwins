# Twin CLI — Command Reference

The `twin` CLI is the primary command-line interface for managing personas,
conversations, training jobs, and channel instances in the Twin Engine platform.

**Global flags:**

| Flag | Short | Description |
|------|-------|-------------|
| `--tenant-id` | `-t` | Tenant ID (or set `TWIN_TENANT_ID`) |
| `--api-url` | `-u` | API base URL (default: `http://localhost:8090`) |
| `--output` | `-o` | Output format: `json`, `table`, `yaml` (default: `table`) |
| `--quiet` | `-q` | Suppress non-essential output |
| `--help` | `-h` | Show help |
| `--version` | `-v` | Show CLI version |

---

## `twin persona`

Manage personas.

### `twin persona list`

List all personas for the current tenant.

| Flag | Short | Description |
|------|-------|-------------|
| `--limit` | `-l` | Max results (default: 20) |
| `--offset` | | Skip N results |

### `twin persona create`

Create a new persona.

| Flag | Short | Description |
|------|-------|-------------|
| `--name` | `-n` | Persona name (required) |
| `--slug` | `-s` | URL-safe slug (required) |
| `--system-prompt` | `-p` | System prompt text (required) |
| `--traits` | | JSON string for traits |
| `--model` | `-m` | Default model |
| `--provider` | | LLM provider |
| `--temperature` | | Default temperature |

### `twin persona get`

Get persona details.

**Arguments:** `id` (required) — Persona ID or slug

### `twin persona update`

Update an existing persona.

**Arguments:** `id` (required) — Persona ID or slug

### `twin persona delete`

Delete a persona.

**Arguments:** `id` (required) — Persona ID or slug

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Skip confirmation |

### `twin persona import`

Import personas from a YAML or JSON file.

**Arguments:** `file` (required) — Path to persona definition file

| Flag | Short | Description |
|------|-------|-------------|
| `--dry-run` | | Validate without creating |

---

## `twin conversation`

Manage conversations.

### `twin conversation list`

| Flag | Short | Description |
|------|-------|-------------|
| `--limit` | `-l` | Max results (default: 20) |
| `--offset` | | Skip N results |
| `--persona-id` | `-p` | Filter by persona ID or slug |

### `twin conversation get`

**Arguments:** `id` (required) — Conversation ID

| Flag | Short | Description |
|------|-------|-------------|
| `--limit` | `-l` | Max messages (default: 50) |

### `twin conversation export`

**Arguments:** `id` (required) — Conversation ID

| Flag | Short | Description |
|------|-------|-------------|
| `--format` | `-f` | Export format: `json`, `markdown`, `txt` (default: `json`) |
| `--output` | `-o` | Output file path (default: stdout) |

---

## `twin train`

Manage training jobs.

### `twin train start`

**Arguments:** `file` (required) — Path to training data file

| Flag | Short | Description |
|------|-------|-------------|
| `--persona` | `-p` | Persona ID or slug (required) |
| `--name` | `-n` | Job name |

### `twin train status`

**Arguments:** `id` (required) — Training job ID

| Flag | Short | Description |
|------|-------|-------------|
| `--watch` | `-w` | Watch status until job completes |

### `twin train cancel`

**Arguments:** `id` (required) — Training job ID

---

## `twin channel`

Manage channel instances.

### `twin channel list`

| Flag | Short | Description |
|------|-------|-------------|
| `--limit` | `-l` | Max results (default: 20) |

### `twin channel create`

| Flag | Short | Description |
|------|-------|-------------|
| `--persona` | `-p` | Persona ID or slug (required) |
| `--type` | `-t` | Channel type (required): telegram, whatsapp_evolution |
| `--bot-token` | | Bot token |
| `--config` | `-c` | JSON string with additional config |

### `twin channel start`

**Arguments:** `id` (required) — Channel instance ID

### `twin channel stop`

**Arguments:** `id` (required) — Channel instance ID

### `twin channel restart`

**Arguments:** `id` (required) — Channel instance ID

### `twin channel delete`

**Arguments:** `id` (required) — Channel instance ID

---

## `twin health`

Check the health of the Twin Engine API.

## `twin version`

Print CLI version.

---

## Exit Code Summary

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 404 | Resource not found |
| 409 | Conflict |
