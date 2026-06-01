export type FollowupAttemptStatus = 
  | 'scheduled' 
  | 'processing' 
  | 'sent' 
  | 'failed' 
  | 'opted_out' 
  | 'expired';

export interface FollowupRule {
  id: string;
  tenantId: string;
  triggerStaleMinutes: number;
  conditions: Record<string, any>;
  backoff: number[];
  maxAttempts: number;
  minIntervalMinutes: number;
  template: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowupAttempt {
  id: string;
  conversationId: string;
  ruleId: string;
  tenantId: string;
  status: FollowupAttemptStatus;
  scheduledAt: Date;
  sentAt?: Date;
  claimedAt?: Date;
  failureReason?: string;
  idempotencyKey: string; // convId:ruleId:cycleIndex
  createdAt: Date;
  updatedAt: Date;
}

export interface ReengagementConversationFields {
  needsReengagement: boolean;
  lastReengagementAt?: Date;
  reengagementCount: number;
  optedOut: boolean;
}
