export interface FeedbackMemory {
  id: string;
  tenantId: string;
  personaId: string;
  contextEmbedding: number[];
  lesson: string;
  status: 'pending' | 'active' | 'archived';
  operatorRole: string | null;
  weight: number;
  sourceConversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComposedPrompt {
  systemPrompt: string;
  layers: {
    persona: TokenInfo;
    feedback: TokenInfo;
    rag: TokenInfo;
  };
  retrievedMemories: FeedbackMemory[];
  totalTokens: number;
}

export interface TokenInfo {
  tokens: number;
  truncated: boolean;
  itemsIncluded: number;
}

export interface FeedbackRetrievalResult {
  memories: FeedbackMemory[];
  similarityScores: Array<{ memoryId: string; score: number }>;
  latencyMs: number;
}
