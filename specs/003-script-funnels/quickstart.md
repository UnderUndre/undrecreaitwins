# Quickstart: Script Funnels

## 1. Ingest a Funnel

```bash
curl -X POST http://localhost:3000/v1/funnels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "X-Tenant-ID: your-tenant-id" \
  -d '{
    "name": "Lead Qualification",
    "persona_id": "your-persona-id",
    "stages": [
      {
        "name": "Greeting",
        "order": 0,
        "objective": "Say hello and ask for interest",
        "fragments": [
          {
            "type": "normal",
            "content": "Привет! Хотите узнать больше о нашем продукте?",
            "triggers": {
              "phrases": ["привет", "здравствуйте", "интересно"]
            }
          }
        ]
      }
    ]
  }'
```

## 2. Start a Conversation

Chat with the persona as usual. If your message matches a fragment, the assistant will use the scripted reply immediately.

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "X-Tenant-ID: your-tenant-id" \
  -d '{
    "model": "your-persona-slug",
    "messages": [
      { "role": "user", "content": "Привет, расскажите подробнее" }
    ]
  }'
```

## 3. Verify Selection

Check selection diagnostics in the response or logs.

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Привет! Хотите узнать больше о нашем продукте?"
      }
    }
  ],
  "metadata": {
    "funnel_selection": {
      "fragment_id": "...",
      "score": 0.95,
      "type": "scripted"
    }
  }
}
```
