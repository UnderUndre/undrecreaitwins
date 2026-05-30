# Спецификация 007: Voice Runtime

## 1. Описание
Голосовой рантайм для цифровых двойников, обеспечивающий потоковое распознавание (STT) и синтез (TTS) речи с минимальной задержкой.

## 2. Отказ от Voximplant в пользу LiveKit
Согласно аудиту легаси, перенос старого кода (56KB SIP логики Voximplant) нецелесообразен.
Новый стандарт: **LiveKit Agents** (WebRTC). Это cloud-agnostic решение, идеально подходящее для AI-агентов.

## 3. Компоненты
*   **LiveKit Worker:** Процесс на стороне Engine, подключающийся к LiveKit серверу.
*   **STT (Speech-to-Text):** Интеграция с Deepgram или Whisper (streaming API).
*   **TTS (Text-to-Speech):** ElevenLabs, OpenAI TTS или PlayHT (streaming API).
*   **VAD (Voice Activity Detection):** Встроено в LiveKit (Silero VAD) для определения конца реплики пользователя.

## 4. Задачи
1. Настроить LiveKit Server (или Cloud).
2. Написать WebRTC воркер на TypeScript (или Python).
3. Связать потоковый текст из LLM (Engine) с TTS генератором для отправки аудио-чанков в LiveKit room.
