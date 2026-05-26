# Redis Streams — Channel Transport Events

All inter-service communication between channel adapters, the core engine,
and training workers uses Redis Streams with consumer groups. This replaces
fire-and-forget pub/sub with durable, at-least-once message delivery.

**Redis configuration:**

- Stream keys: `twin.stream.in`, `twin.stream.out`
- Consumer groups: auto-created per stream
- Serializer: JSON
- All timestamps are ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`)
- ACK: Manual ACK after successful processing
- Redelivery: Pending entries claimed after 30s visibility timeout

---

## Stream: `twin.stream.in`

**Description:** Inbound messages published by channel adapters when a user
sends a message on an external platform. Consumed by core orchestrator
via consumer group.

### Payload Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message_id` | string | yes | UUID v4 |
| `channel_id` | string | yes | Channel instance UUID |
| `conversation_id` | string | no | Existing conversation UUID (null = new) |
| `external_user_id` | string | yes | User ID on the external platform |
| `content` | string | yes | Message text |
| `metadata` | object | no | Platform-specific metadata |
| `timestamp` | string | yes | ISO 8601 datetime |

### Example

```json
{
  "message_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "channel_id": "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
  "conversation_id": null,
  "external_user_id": "428951736",
  "content": "Hello, I need help with my order.",
  "metadata": {"telegram_chat_id": -1001234567890, "first_name": "Alice"},
  "timestamp": "2026-05-23T14:30:00.123Z"
}
```

---

## Stream: `twin.stream.out`

**Description:** Outbound responses published by the core engine after
processing an inbound message. Consumed by channel adapters via consumer group.

### Payload Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message_id` | string | yes | UUID v4 |
| `reply_to` | string | yes | Inbound message_id being replied to |
| `channel_id` | string | yes | Channel instance UUID |
| `conversation_id` | string | yes | Conversation UUID |
| `external_user_id` | string | yes | Recipient user ID |
| `content` | string | yes | Response text |
| `metadata` | object | no | Platform-specific delivery metadata |
| `usage` | object | no | Token usage from the LLM call |
| `timestamp` | string | yes | ISO 8601 datetime |

### Example

```json
{
  "message_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "reply_to": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "channel_id": "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
  "conversation_id": "11223344-5566-7788-99aa-bbccddeeff00",
  "external_user_id": "428951736",
  "content": "Hi Alice! I'd be happy to help with your order.",
  "metadata": {},
  "usage": {"prompt_tokens": 142, "completion_tokens": 23, "total_tokens": 165},
  "timestamp": "2026-05-23T14:30:02.456Z"
}
```

---

## Stream: `twin.stream.health`

**Description:** Health status changes published by channel adapters.

### Payload Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel_id` | string | yes | Channel instance UUID |
| `channel_type` | string | yes | Platform type |
| `status` | string | yes | active, degraded, disconnected, error |
| `error` | string | no | Error message |
| `uptime_seconds` | number | no | Seconds since connected |
| `timestamp` | string | yes | ISO 8601 datetime |

---

## Stream: `twin.stream.training`

**Description:** Progress updates published by training workers.

### Payload Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `job_id` | string | yes | Training job UUID |
| `persona_id` | string | yes | Persona being trained |
| `tenant_id` | string | yes | Owning tenant |
| `status` | string | yes | queued, running, completed, failed |
| `progress` | number | no | Percentage 0–100 |
| `stage` | string | no | Current stage description |
| `error` | string | no | Error message if failed |
| `timestamp` | string | yes | ISO 8601 datetime |

---

## General Notes

1. **Consumer groups**: Each consumer group gets its own copy of messages. Use `XREADGROUP GROUP <group> <consumer>` to consume.
2. **ACK**: Call `XACK` after successful processing. Unacknowledged messages are redelivered after visibility timeout.
3. **Connection resilience**: All publishers/consumers must handle Redis reconnection.
4. **Message size**: Keep payloads under 512 KB.
5. **Naming convention**: Stream keys follow `twin.stream.<domain>`.
6. **Retention**: Streams use `MAXLEN ~ 10000` for approximate trimming.
