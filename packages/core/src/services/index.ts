import { EmbeddingService } from './embedding-service.js';
import { DocumentService } from './document-service.js';
import { AnnotationService } from './annotation-service.js';
import { LangfuseService } from './langfuse-service.js';
import { GroundingEngine } from './grounding/GroundingEngine.js';

// Singleton instances for the core engine
export const embeddingService = new EmbeddingService();
export const documentService = new DocumentService();
export const annotationService = new AnnotationService(embeddingService);
export const langfuseService = new LangfuseService();
export const groundingEngine = new GroundingEngine(embeddingService, documentService);

/**
 * Central engine service registry.
 * Injected into components as 'engine.*'.
 */
export const engine = {
  grounding: groundingEngine,
  annotations: annotationService,
  langfuse: langfuseService,
};

// Re-export services
export * from './chat-service.js';
export * from './persona-repository.js';
export * from './channel-repository.js';
export * from './usage-service.js';
export * from './llm-client.js';
export * from './embedding-service.js';
export * from './document-service.js';
export * from './annotation-service.js';
export * from './langfuse-service.js';
export * from './eval-types.js';
export * from './eval-case-loader.js';
export * from './eval-assertions.js';
export * from './eval-repository.js';
export * from './eval-runner.js';
export * from './grounding/GroundingEngine.js';
