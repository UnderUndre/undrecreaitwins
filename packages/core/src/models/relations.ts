import { relations } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { personas } from './personas.js';
import { conversations } from './conversations.js';
import { messages } from './messages.js';
import { channelInstances } from './channel-instances.js';
import { trainingJobs } from './training-jobs.js';
import { usageEvents } from './usage-events.js';
import { apiTokens } from './api-tokens.js';

export const tenantsRelations = relations(tenants, ({ many }) => ({
  personas: many(personas),
  conversations: many(conversations),
  channelInstances: many(channelInstances),
  trainingJobs: many(trainingJobs),
  usageEvents: many(usageEvents),
  apiTokens: many(apiTokens),
}));

export const personasRelations = relations(personas, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [personas.tenantId],
    references: [tenants.id],
  }),
  conversations: many(conversations),
  trainingJobs: many(trainingJobs),
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
