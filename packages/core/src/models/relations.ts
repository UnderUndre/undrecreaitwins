import { relations } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { personas } from './personas.js';
import { conversations } from './conversations.js';
import { messages } from './messages.js';
import { channelInstances } from './channel-instances.js';
import { trainingJobs } from './training-jobs.js';
import { usageEvents } from './usage-events.js';
import { apiTokens } from './api-tokens.js';
import { funnelDefinitions, funnelVersions } from './funnels.js';
import { funnelStages } from './funnel-stages.js';
import { funnelFragments } from './funnel-fragments.js';
import { funnelSlots } from './funnel-slots.js';
import { conversationFunnelStates } from './conversation-funnel-states.js';

export const tenantsRelations = relations(tenants, ({ many }) => ({
  personas: many(personas),
  conversations: many(conversations),
  channelInstances: many(channelInstances),
  trainingJobs: many(trainingJobs),
  usageEvents: many(usageEvents),
  apiTokens: many(apiTokens),
  funnelDefinitions: many(funnelDefinitions),
}));

export const personasRelations = relations(personas, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [personas.tenantId],
    references: [tenants.id],
  }),
  conversations: many(conversations),
  trainingJobs: many(trainingJobs),
  funnelDefinition: one(funnelDefinitions, {
    fields: [personas.id],
    references: [funnelDefinitions.personaId],
  }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  persona: one(personas, {
    fields: [conversations.personaId],
    references: [personas.id],
  }),
  channel: one(channelInstances, {
    fields: [conversations.channelId],
    references: [channelInstances.id],
  }),
  messages: many(messages),
  funnelState: one(conversationFunnelStates),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const channelInstancesRelations = relations(channelInstances, ({ one }) => ({
  tenant: one(tenants, {
    fields: [channelInstances.tenantId],
    references: [tenants.id],
  }),
  persona: one(personas, {
    fields: [channelInstances.personaId],
    references: [personas.id],
  }),
}));

export const trainingJobsRelations = relations(trainingJobs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [trainingJobs.tenantId],
    references: [tenants.id],
  }),
  persona: one(personas, {
    fields: [trainingJobs.personaId],
    references: [personas.id],
  }),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [usageEvents.tenantId],
    references: [tenants.id],
  }),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  tenant: one(tenants, {
    fields: [apiTokens.tenantId],
    references: [tenants.id],
  }),
}));

export const funnelDefinitionsRelations = relations(funnelDefinitions, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [funnelDefinitions.tenantId],
    references: [tenants.id],
  }),
  persona: one(personas, {
    fields: [funnelDefinitions.personaId],
    references: [personas.id],
  }),
  versions: many(funnelVersions),
}));

export const funnelVersionsRelations = relations(funnelVersions, ({ one, many }) => ({
  definition: one(funnelDefinitions, {
    fields: [funnelVersions.definitionId],
    references: [funnelDefinitions.id],
  }),
  stages: many(funnelStages),
  fragments: many(funnelFragments),
  slots: many(funnelSlots),
  activeConversations: many(conversationFunnelStates),
}));

export const funnelStagesRelations = relations(funnelStages, ({ one, many }) => ({
  version: one(funnelVersions, {
    fields: [funnelStages.funnelVersionId],
    references: [funnelVersions.id],
  }),
  fragments: many(funnelFragments),
  slots: many(funnelSlots),
  nextStage: one(funnelStages, {
    fields: [funnelStages.nextStageId],
    references: [funnelStages.id],
    relationName: 'nextStage',
  }),
  exitStage: one(funnelStages, {
    fields: [funnelStages.exitStageId],
    references: [funnelStages.id],
    relationName: 'exitStage',
  }),
}));

export const funnelFragmentsRelations = relations(funnelFragments, ({ one }) => ({
  version: one(funnelVersions, {
    fields: [funnelFragments.funnelVersionId],
    references: [funnelVersions.id],
  }),
  stage: one(funnelStages, {
    fields: [funnelFragments.stageId],
    references: [funnelStages.id],
  }),
}));

export const funnelSlotsRelations = relations(funnelSlots, ({ one }) => ({
  version: one(funnelVersions, {
    fields: [funnelSlots.funnelVersionId],
    references: [funnelVersions.id],
  }),
  stage: one(funnelStages, {
    fields: [funnelSlots.stageId],
    references: [funnelStages.id],
  }),
}));

export const conversationFunnelStatesRelations = relations(conversationFunnelStates, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationFunnelStates.conversationId],
    references: [conversations.id],
  }),
  funnelVersion: one(funnelVersions, {
    fields: [conversationFunnelStates.funnelVersionId],
    references: [funnelVersions.id],
  }),
  currentStage: one(funnelStages, {
    fields: [conversationFunnelStates.currentStageId],
    references: [funnelStages.id],
  }),
}));
