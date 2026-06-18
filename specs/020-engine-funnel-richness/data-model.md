# Data Model: Engine Funnel Richness

Schema extensions for funnel entities and conversation state.

## 1. Funnel Fragments (`funnel_fragments`)

| Column | Type | Description |
|--------|------|-------------|
| `delivery_mode` | `text` | `'verbatim'`, `'template'`, `'llm'` (default) |
| `adaptive_intro` | `boolean` | Enable bridge generation (default: false) |
| `media_url` | `text` | Optional image/file to attach |
| `delivery_condition` | `jsonb` | Logic for conditional delivery |

## 2. Funnel Stages (`funnel_stages`)

| Column | Type | Description |
|--------|------|-------------|
| `required_slots` | `jsonb` | List of slot names that must be filled before advance |
| `requires_confirmation` | `boolean` | Gate transition behind confirmation prompt |
| `is_anytime` | `boolean` | Can be triggered from anywhere |

## 3. Funnel Slots (`funnel_slots`)

| Column | Type | Description |
|--------|------|-------------|
| `locked` | `boolean` | Prevent overwrite after first extraction |
| `enum_values` | `jsonb` | List of allowed values for extraction |

## 4. Conversation State (`conversation_funnel_states`)

| Column | Type | Description |
|--------|------|-------------|
| `return_stack` | `jsonb` | LIFO stack for Anytime stages (max 3 IDs) |

## 5. Conversations (`conversations`)

| Column | Type | Description |
|--------|------|-------------|
| `slots` | `jsonb` | Global structured memory extracted by LLM |

## Drizzle Schema Changes (Preview)

```typescript
// packages/core/src/models/funnel-fragments.ts
// deliveryModeEnum — follows existing pattern (fragmentTypeEnum, etc.)
export const deliveryModeEnum = pgEnum('delivery_mode', ['verbatim', 'template', 'llm']);

export const funnelFragments = pgTable('funnel_fragments', {
  // ... existing
  deliveryMode: deliveryModeEnum('delivery_mode').notNull().default('llm'),
  adaptiveIntro: boolean('adaptive_intro').notNull().default(false),
  mediaUrl: text('media_url'),
  deliveryCondition: jsonb('delivery_condition'),
});

// packages/core/src/models/funnel-stages.ts
export const funnelStages = pgTable('funnel_stages', {
  // ... existing
  requiredSlots: jsonb('required_slots').notNull().$type<string[]>().default([]),
  requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
  isAnytime: boolean('is_anytime').notNull().default(false),
});

// packages/core/src/models/funnel-slots.ts
export const funnelSlots = pgTable('funnel_slots', {
  // ... existing
  locked: boolean('locked').notNull().default(false),
  enumValues: jsonb('enum_values').$type<string[]>(),
});

// packages/core/src/models/conversation-funnel-states.ts
export const conversationFunnelStates = pgTable('conversation_funnel_states', {
  // ... existing
  returnStack: jsonb('return_stack').notNull().$type<string[]>().default([]),
});

// packages/core/src/models/conversations.ts
export const conversations = pgTable('conversations', {
  // ... existing
  slots: jsonb('slots').notNull().default({}),
});
```
