export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamDelta {
  role?: 'assistant';
  content?: string;
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage?: StreamUsage;
}
