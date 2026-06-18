# Metadata Contracts: Engine Funnel Richness

Response metadata structure returned by the Engine in the `metadata` field of the chat response.

## 1. Funnel Selection Metadata (`metadata.funnel`)

```typescript
{
  fragment_id: string;      // The UUID of the selected fragment
  delivery_mode: 'verbatim' | 'template' | 'llm';
  score: number;            // Match score (0-1.0)
  type: 'scripted' | 'steer' | 'abstain' | 'catch_all' | 'no_funnel';
  stage_transition?: {
    from: string;           // Stage ID
    to: string;             // Stage ID
    type: 'advance' | 'regression' | 'stay';
    blocked?: boolean;      // True if transition was blocked by a guard
    blocked_reason?: 'required_slots' | 'confirmation_pending' | 'anytime_active';
  };
}
```

## 2. Humanization Metadata (`metadata.humanization`)

Used by channel adapters to simulate human typing behavior. **Canonical shape** (review fix Codex-F1 + C-F5).

```typescript
{
  delay_ms: number;         // Clamped [500, 8000]. Total delay before sending first chunk
  typing_chunks: string[];  // Max 10 chunks, each ≤500 chars. Message split for typing animation
  backspace_simulation: {   // Directive — adapter decides which char to "typo" (review fix C-F5)
    enabled: boolean;       // Whether to simulate typos
    chance: number;         // 0.01 = 1% per message (not per character)
  };
}
```

## 3. Media Metadata (`metadata.media`)

```typescript
{
  url: string;              // URL of the image/file
  kind: 'image' | 'audio' | 'video' | 'file';
  mime?: string;
}[]
```

## 4. Extraction Signal (`metadata.extraction`)

```typescript
{
  slots_extracted: string[]; // List of slot names updated in this turn
  confidence: number;        // Extraction confidence score
}
```
