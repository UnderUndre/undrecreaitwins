# Quickstart: Engine Funnel Richness

This guide shows how to use the new funnel features in your definitions.

## 1. Verbatim Critical Phrases

To ensure a price or return policy is never altered by LLM:

```json
{
  "id": "price-fragment",
  "deliveryMode": "verbatim",
  "content": "Стоимость подписки составляет 990 рублей в месяц."
}
```

## 2. Using Variables in Templates

Use `{{slot_name}}` to inject captured data without an LLM call:

```json
{
  "id": "greeting-fragment",
  "deliveryMode": "template",
  "content": "Здравствуйте, {{customer_name}}! Вы выбрали пакет {{selected_plan}}."
}
```

## 3. Adaptive Intro

Enable `adaptiveIntro` to let the bot generate a smooth transition bridge:

```json
{
  "id": "shipping-fragment",
  "deliveryMode": "llm",
  "adaptiveIntro": true,
  "content": "Объясни условия доставки: 3-5 дней по РФ, бесплатно от 5000р."
}
```
*Resulting message: "Так, по поводу доставки... Обычно мы доставляем за 3-5 дней по всей России, а при заказе от 5000 рублей это будет бесплатно."*

## 4. Anytime Stages (e.g., FAQ)

Mark a stage as `isAnytime: true` to make it accessible from anywhere:

```json
{
  "id": "faq-stage",
  "name": "FAQ",
  "isAnytime": true,
  "fragments": [
    { "triggers": { "phrases": ["какие гарантии", "где вы находитесь"] }, "content": "..." }
  ]
}
```

## 5. Required Slots Guard

Prevent advancing to the "Payment" stage until the "Email" slot is filled:

```json
{
  "id": "order-details-stage",
  "requiredSlots": ["customer_email"],
  "nextStageId": "payment-stage"
}
```

## 6. Pacing & Media

The Engine automatically calculates `delay_ms`. You can also attach media:

```json
{
  "id": "product-demo",
  "mediaUrl": "https://cdn.example.com/demo.png",
  "content": "Посмотрите на этот график..."
}
```
