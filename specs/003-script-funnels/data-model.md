# Data Model: Script Funnels

## 1. Funnel Definitions Table (`funnel_definitions`)

Stable identity for a funnel across versions. Never changes shape on publish.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Stable funnel identity |
| `tenant_id` | UUID | FK → tenants, NOT NULL | Owner tenant |
| `persona_id` | UUID | FK → personas, NOT NULL | Associated persona (1:1 per FR-024) |
| `name` | String | NOT NULL | Human-readable name |
| `deleted_at` | Timestamp | NULL | Soft-delete marker (FR-023); non-null = archived |
| `created_at` | Timestamp | NOT NULL | |
| `updated_at` | Timestamp | NOT NULL | |

**Indexes**: `(tenant_id)`, `(persona_id)`, `(tenant_id, persona_id)` unique.

## 2. Funnel Versions Table (`funnel_versions`)

Immutable snapshot of a funnel at a specific version. Child tables (stages, fragments, slots) reference this table. Rows are **never mutated** after creation — each publish creates a new row.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique version identifier |
| `definition_id` | UUID | FK → funnel_definitions, NOT NULL | Parent funnel identity |
| `version_number` | INTEGER | NOT NULL | Monotonic per definition (1, 2, 3…) |
| `config` | JSONB | NOT NULL | Scoring weights, thresholds, behaviors (see Config Schema) |
| `is_active` | Boolean | NOT NULL, DEFAULT false | Current published version for new conversations |
| `created_at` | Timestamp | NOT NULL | |

**Unique constraint**: `(definition_id, version_number)`.
**Unique Index**: `(definition_id)` filtered on `is_active = true` (enforces at most one active version per funnel).

### Config Schema

```json
{
  "relevance_threshold": 0.5,
  "off_script_behavior": "steer",
  "catch_all_fragment_id": null,
  "stuck_threshold": 3,
  "stuck_action": "yield_generation",
  "scoring_weights": {
    "exact_match": 10,
    "stemmed_match": 7,
    "synonym_match": 5,
    "stage_boost": 3,
    "next_stage_bonus": 1.5,
    "objection_boost": 2
  }
}
```

## 3. Stages Table (`funnel_stages`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `funnel_version_id` | UUID | FK → funnel_versions, NOT NULL | Parent version |
| `name` | String | NOT NULL | Stage name |
| `order` | Integer | NOT NULL | Sequence in funnel |
| `objective` | Text | | Human-readable goal of this stage |
| `resolution_criteria` | JSONB | NOT NULL | Machine-readable trigger for stage advancement (FR-025) |
| `next_stage_id` | UUID | FK → funnel_stages | Natural successor |
| `stuck_action` | String | | Per-stage override of funnel-level `stuck_action` (FR-009) |
| `exit_stage_id` | UUID | FK → funnel_stages | Target stage for `exit_stage` stuck action; required when `stuck_action = exit_stage` |

### Resolution Criteria Schema

```json
// Option A: advance when a specific fragment is selected
{ "type": "fragment_selected", "fragment_id": "uuid" }

// Option B: advance when a specific slot is filled
{ "type": "slot_filled", "slot_name": "user_budget" }

// Option C: advance when all stage-scoped slots are filled
{ "type": "all_slots_filled" }
```

## 4. Fragments Table (`funnel_fragments`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `funnel_version_id` | UUID | FK → funnel_versions, NOT NULL | Denormalized FK for direct querying (avoids join through stages) |
| `stage_id` | UUID | FK → funnel_stages, NOT NULL | Associated stage |
| `type` | Enum | `normal`, `objection` | Fragment type |
| `content` | Text | NOT NULL | The scripted reply text |
| `triggers` | JSONB | NOT NULL | Phrases, keywords, synonyms (see Trigger Limits) |
| `score_weight` | Float | DEFAULT 1.0 | Base weight for scorer |

### Trigger Limits (enforced at ingestion via Zod — FR-017)

- `phrases`: max 50 items, each max 500 characters
- `synonyms`: max 100 groups, each group max 20 entries

## 5. Slots Table (`funnel_slots`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `funnel_version_id` | UUID | FK → funnel_versions, NOT NULL | Parent version |
| `stage_id` | UUID | FK → funnel_stages, NULL | Optional stage-scoping (NULL = global to funnel) |
| `name` | String | NOT NULL | Slot name (e.g. `user_budget`) |
| `description` | Text | | Context for LLM verification |
| `validation_rules` | JSONB | | Regex or range checks |

## 6. Conversation Funnel State Table (`conversation_funnel_states`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `conversation_id` | UUID | PK, FK → conversations | Parent conversation |
| `funnel_version_id` | UUID | FK → funnel_versions, NOT NULL | Pinned funnel version (immutable snapshot — FR-016) |
| `current_stage_id` | UUID | FK → funnel_stages | Current stage |
| `consecutive_stuck_count` | Integer | DEFAULT 0 | Counter for safety-net; reset to 0 on stage advancement (FR-009) |
| `captured_slots` | JSONB | | `{ slot_name: { value: any, verified: boolean, captured_at: "ISO8601" } }` |
| `version` | BIGINT | DEFAULT 0 | Optimistic locking for CAS updates (slot + stage transitions) |
| `updated_at` | Timestamp | | |

### CAS Retry Policy (research.md §3)

Both stage transitions and slot updates share the `version` column for compare-and-set:

- **Max retries**: 3 (immediate retry, no backoff — PG round-trip is fast enough)
- **On exhaustion (slot updates)**: log warning, skip update — slot remains unfilled/stale
- **On exhaustion (stage transitions)**: fail the turn with retriable error
