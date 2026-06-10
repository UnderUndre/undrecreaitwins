# Implementation Plan: Multi-Channel Gateway (Adapter Port)

**Branch**: `015-multi-channel-gateway` | **Date**: 2026-06-09 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/015-multi-channel-gateway/spec.md`

## ⚠️ Cross-repo note (read first)

Spec/plan artifacts **перенесены в `undrecreaitwins/specs/015-…`** (re-home выполнен 2026-06-09;
analyze/clarify прогнаны здесь). Implementation target — тот же
**twin-engine** repo: `C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins`
(TypeScript, pnpm, scope `@undrecreaitwins/*`). All `packages/channel-*`, `packages/core`,
`packages/shared` paths below are in **twin-engine**, not ai-twins. **Decision (2026-06-09,
user-approved): RE-HOME выполнен** — spec tree теперь в `undrecreaitwins/specs/015-…`
(Principle IX: implementation branch must live in the repo that holds the code). **ОСТАЁТСЯ
(F3)**: создать `015-multi-channel-gateway` planning-ветку в twin-engine перед `/speckit.implement`.
analyze/clarify прогнаны через `SPECIFY_FEATURE` на ветке `main` — это допустимо для read/clarify,
но implement обязан идти с feature-ветки.

## Summary

Расширить охват каналов твина с 2 (`telegram`, `whatsapp_evolution`) до Phase1+2 (~13, вкл. VK/Avito),
портируя протоколы Hermes (Python `gateway/platforms/*.py`) как **референс** в новые TS-пакеты
`@undrecreaitwins/channel-<platform>`. Архитектура **уже есть** и переиспользуется как есть:
контракт `ChannelAdapter` (`connect/disconnect/onIncoming/send/health`), `ChannelMessage`,
`ChannelTransport` (Redis streams `twin.stream.in`/`twin.stream.out`), `ChannelOrchestrator`
(INBOUND→`chatService.complete()`→OUTBOUND, дедуп), валидаторы 004 в `chat-service`. Каждый
адаптер = **свой процесс** (как `channel-telegram/index.ts --bot-token`), стампит
`tenant_id`/`persona_slug`, публикует INBOUND, консьюмит OUTBOUND по `channel_id`, шлёт.

**Подход = Option A (CL-A5)**: добавить канал = реализовать 5 методов контракта + стампинг +
publish, Hermes = справочник протокольных квирков. НЕ форк, НЕ VPS-per-client.

## Gate-0 Prerequisites (блокируют масштабирование, CL-A6/CL-A1)

Перед добавлением 13 каналов — загерметизировать то, что ломает премису «004 = sole gate»:
- **P0-1 (CL-A6)**: reengagement (`reengagement/delivery.ts:49`) шлёт в OUTBOUND мимо
  валидаторов. Bug-fix **в работе отдельным чипом** в twin-engine. **Блокер** — иначе каждый
  новый канал множит радиус невалидированного вывода. **Fallback (glm-F2)**: если чип не
  приземлится за N дней (дефолт 14) — stopgap OUTBOUND-interceptor в `channel-orchestrator.ts`
  пере-роутит reengagement-вывод через `validateResponse()` (трейд-офф: +латентность). 015 не
  висит бесконечно на внешней зависимости; окно задокументировать.
- **P0-2 (CL-A1/FR-004)**: креды каналов — plaintext в `channel_instances.config`. Зашифровать
  через существующий `KmsProvider` (`crypto.ts`) + ciphertext-колонка. Bug-fix **в работе чипом**.
- **P0-3 (CL-A7)**: streaming bypass — **N/A** (твин не стримит); guard: channel-OUTBOUND без стрима.

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20 (twin-engine, pnpm monorepo)
**Primary Dependencies**: ioredis (Redis Streams), drizzle (channel_instances), `KmsProvider`
(`core/services/llm-provider/crypto.ts`), grammy (telegram ref). Existing: `@undrecreaitwins/{core,shared,channel-telegram,channel-whatsapp,channel-telegram-mtproto}`.
**New per-channel deps (approval-gated, Standing Order 2)**: `discord.js` (Discord Gateway WS),
Slack — webhook (Events API + HMAC, raw HTTP / bolt HTTP-mode, НЕ Socket — CL-A13), Mattermost/DingTalk/Feishu/WeCom SDKs or thin HTTP clients,
`matrix-js-sdk`, `nodemailer`+IMAP (email), `twilio` (SMS), **VK** (`node-vk-bot-api` ИЛИ тонкий
HTTP-клиент для Long Poll/Callback + `messages.send`), **Avito** (тонкий HTTP-клиент `api.avito.ru`
+ OAuth Bearer; webhook V3). Confirm each name/version before install.
**Storage**: Postgres via drizzle (`channel_instances` + new ciphertext column); Redis (streams + dedup).
**Testing**: vitest (per-package unit + integration, как `channel-telegram/tests/integration`).
**Target Platform**: Linux; each adapter = standalone consumer process (scales like telegram).
**Project Type**: Backend service / monorepo packages (twin-engine).
**Performance/Constraints**: per-tenant isolation (zero cross-tenant); креды encrypted at-rest;
adapter fail → status 'error', не роняет движок; Redis Streams ack (no loss/dup on rebalance).
**Scale/Scope**: Phase1 = 7 каналов (+VK), Phase2 = 6 (+Avito); +contract extension (ChannelMessage attachments/
typing/reply-anchor) + ciphertext column + inbound-mode (bot/socket vs webhook).

## Constitution Check

| Принцип | Статус |
| --- | --- |
| **VI** Cross-AI Review Gate | ⏳ после tasks (analyze + ≥2 external) |
| **VII** Artifact Versioning | ✅ snapshot plan/tasks |
| **IX** Two-Phase branch | 🟡 **re-home выполнен** (spec tree в `undrecreaitwins/specs/015-…`). Остаётся (F3): завести `015-…` planning-ветку в twin-engine перед implement (сейчас `main`). |
| Governance §4 (complexity) | ✅ оправдано: переиспользуем существующий контракт/оркестратор; новые пакеты = тот же паттерн, что telegram |
| **DD-HX-001 / FR-003 sole gate** | ✅ **RESOLVED in code (verified 2026-06-09)**: `reengagement/delivery.ts:43` → `validateResponse()` ПЕРЕД `publish(OUTBOUND)` (:65); чистая реализация, не стопгэп (glm-F2, gem-F1). Чип `task_75466095` больше не блокирует 015. Остаётся regression-тест (T023). |

**Gate verdict: PASS с флагами** — gate-0 prerequisites (P0-1/P0-2) + ветка/репо (IX) +
per-channel dep approvals. Ни одного артефакт-дефекта.

## Project Structure (twin-engine paths)

```text
packages/shared/src/
├── types.ts            # FR-001: расширить ChannelType union + ChannelMessage (attachments/typing/reply-anchor)
└── constants.ts        # REDIS_STREAMS (есть)
packages/core/src/services/
├── channel-orchestrator.ts   # есть; extractChannelType() расширить; +runtime streaming-guard (glm-F9); +stopgap reengagement interceptor (glm-F2)
├── chat-service.ts           # валидаторы (P0-1 fix landing here / reengagement path)
├── webhook-signature.ts      # НОВЫЙ (glm-F3): shared HMAC-SHA256 + constant-time compare, порт из Hermes once; зовут webhook-адаптеры
├── channel-rate-limiter.ts   # НОВЫЙ (glm-F8): per-platform лимиты (msgs/sec, длина, media-size); адаптеры зовут перед send
├── channel-provisioning.ts   # НОВЫЙ (glm-F4): accept creds → encrypt (KmsProvider) → write channel_instances → adapter.connect(); engine-сторона канон-route 016 T013
└── llm-provider/crypto.ts    # KmsProvider — reuse для шифрования кред каналов (P0-2) + ротация (glm-F10)
packages/core/src/models/
└── channel-instances.ts      # P0-2: + credentialsCiphertext колонка (drizzle migration, review .sql)
packages/channel-discord/     # НОВЫЙ — ChannelAdapter (discord.js Gateway WS)
packages/channel-slack/       # НОВЫЙ — webhook (Events API + HMAC, один эндпоинт по team_id; CL-A13/glm-F18)
packages/channel-mattermost/  # НОВЫЙ
packages/channel-dingtalk/    # НОВЫЙ
packages/channel-feishu/      # НОВЫЙ (webhook + signature)
packages/channel-wecom/       # НОВЫЙ (webhook + signature)
packages/channel-vk/          # НОВЫЙ — VK Community Bot API (Long Poll 'bot' или Callback 'webhook'); CL-A8
# Phase 2:
packages/channel-matrix/, channel-email/, channel-sms/, channel-webhooks/, channel-homeassistant/
packages/channel-avito/       # НОВЫЙ — Avito Messenger (webhook V3 + OAuth Bearer, per-tenant business creds); CL-A9
# каждый: src/index.ts (process entry + creds), src/<platform>-adapter.ts (5 методов), tests/integration/
```

**Structure Decision**: один пакет на платформу (зеркалит `channel-telegram`), общий контракт
из `@undrecreaitwins/shared`. Inbound-режим объявляется адаптером (CL-A3/FR-008): bot/socket
(Discord/Slack — исходящее WS, без публичной URL) vs webhook (Feishu/WeCom — signature-verified).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected |
| --- | --- | --- |
| N новых пакетов `channel-*` | каждый канал — свой протокол + свой процесс (как telegram) | один мега-пакет = связывает релизы/деплой каналов, мешает per-channel масштаб |
| N новых per-channel deps | нативные SDK платформ (discord.js/bolt/matrix-js-sdk) | ручной протокол = реинвент + баги (Hermes = референс, не замена SDK) |
| Gate-0 prerequisite-фиксы | премиса «sole gate» сегодня ложна (CL-A6) | масштабировать поверх дыры = множить невалидированный вывод |

## Phase 0 — Research

[research.md](research.md): разрешённые unknowns (gate-0 статус, per-channel inbound-режимы,
attachment-модель, dedup/ack-семантика, Hermes-как-референс, новые deps).

## Phase 1 — Design & Contracts

- [data-model.md](data-model.md) — ChannelMessage-расширение, channel_instances + ciphertext, per-channel config.
- [contracts/](contracts/) — расширенный `ChannelAdapter`/`ChannelMessage` контракт + inbound-mode + INBOUND/OUTBOUND payload.
- [quickstart.md](quickstart.md) — сценарии (новый канал отвечает через гейт, tenant-isolation, media, webhook-signature).
- [architecture.md](../main/architecture.md) — добавить gateway-расширение + twin-engine ownership.

**Post-Design re-check**: gate PASS с теми же флагами (gate-0, ветка/репо IX, dep approvals).
