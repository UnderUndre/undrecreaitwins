# Quickstart: 006 MTProto Channel

This module provides the `TwinChannel` adapter for the Telegram MTProto protocol. It is designed to be instantiated by the Engine using session credentials managed by the Product layer.

## Installation

```bash
# Assuming the workspace is set up
npm install @ai-twins/channel-telegram-mtproto
```

## Basic Usage

```typescript
import { TwinChannel } from '@ai-twins/channel-telegram-mtproto';

// 1. Initialize the adapter with session credentials
const channel = new TwinChannel({
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  sessionString: process.env.USERBOT_SESSION_STRING, // Provided by Product layer
  allowedChats: ['@my_test_chat', -100123456789],
  typingIntervalMs: 4000
});

// 2. Listen for incoming messages
channel.onMessage(async (msg) => {
  console.log(`Received message from ${msg.senderId} in ${msg.chatId}: ${msg.text}`);
  
  // 3. Indicate typing while the Engine generates a response
  await channel.setTyping(msg.chatId, true);
  
  // Simulate LLM delay
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  await channel.setTyping(msg.chatId, false);
  
  // 4. Send response
  await channel.sendMessage(msg.chatId, 'Hello from Twin Engine!');
});

// 5. Connect to Telegram
await channel.connect();
```

## Rate Limiting

The adapter automatically handles `FloodWaitError` from Telegram by pausing outgoing requests for the specified duration and logging a warning. No additional configuration is required, but downstream Engine logic should expect potential delays in `sendMessage` resolution.
