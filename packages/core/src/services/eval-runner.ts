import { ChatService } from './chat-service.js';
import { EvalCaseLoader } from './eval-case-loader.js';
import { evaluateAssertions } from './eval-assertions.js';
import { EvalRepository } from './eval-repository.js';
import { ValidationError } from '@undrecreaitwins/shared';
import type { ChatResponse } from './chat-service.js';
import type { CreateEvalResultInput, EvalResultRow, EvalRunRow } from './eval-repository.js';
import type { EvalAssertionResult, EvalCase } from './eval-types.js';

type ChatCompleter = Pick<ChatService, 'complete'>;
type EvalRunStore = Pick<EvalRepository, 'createRun' | 'insertResults' | 'finishRun'>;
type EvalCaseSource = Pick<EvalCaseLoader, 'loadCases'>;

export type EvalRunnerOptions = {
  chatService?: ChatCompleter;
  repository?: EvalRunStore;
  caseLoader?: EvalCaseSource;
};

export type EvalRunOutput = {
  run: EvalRunRow;
  results: EvalResultRow[];
};

export class EvalRunner {
  private readonly chatService: ChatCompleter;
  private readonly repository: EvalRunStore;
  private readonly caseLoader: EvalCaseSource;

  constructor(options: EvalRunnerOptions = {}) {
    this.chatService = options.chatService ?? new ChatService();
    this.repository = options.repository ?? new EvalRepository();
    this.caseLoader = options.caseLoader ?? new EvalCaseLoader();
  }

  async run(tenantId: string, caseNames?: string[]): Promise<EvalRunOutput> {
    const cases = await this.caseLoader.loadCases(caseNames);
    if (cases.length === 0) {
      throw new ValidationError([{ field: 'case_names', message: 'No eval cases available to run' }]);
    }

    const run = await this.repository.createRun(tenantId, cases.length);
    const caseResults: CreateEvalResultInput[] = [];

    for (const evalCase of cases) {
      caseResults.push(await this.executeCase(tenantId, evalCase));
    }

    const insertedResults = await this.repository.insertResults(tenantId, run.id, caseResults);
    const passedCases = caseResults.filter((result) => result.passed).length;
    const finishedRun = await this.repository.finishRun(tenantId, run.id, passedCases);

    return {
      run: finishedRun,
      results: insertedResults,
    };
  }

  private async executeCase(tenantId: string, evalCase: EvalCase): Promise<CreateEvalResultInput> {
    let chatResponse: ChatResponse;
    try {
      chatResponse = await this.chatService.complete({
        tenantId,
        personaSlug: evalCase.personaSlug,
        messages: evalCase.messages,
        isTestThread: true,
        source: 'eval-harness',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Eval case execution failed';
      const assertionResults: EvalAssertionResult[] = [{
        type: 'execution',
        passed: false,
        message,
      }];
      return {
        caseName: evalCase.name,
        passed: false,
        response: '',
        assertionResults,
      };
    }

    const response = chatResponse.choices[0]?.message.content ?? '';
    const assertionResults = evaluateAssertions(response, evalCase.assertions);
    return {
      caseName: evalCase.name,
      passed: assertionResults.every((result) => result.passed),
      response,
      assertionResults,
    };
  }
}
