import { MAX_SUBAGENTS, EModelEndpoint, ErrorTypes } from 'librechat-data-provider';
import {
  agentCreateSchema,
  agentUpdateSchema,
  validateAgentModel,
  agentSubagentsSchema,
} from './validation';

describe('agentSubagentsSchema', () => {
  it('accepts enabled:true with a list within the cap', () => {
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      allowSelf: false,
      agent_ids: ['agent_1', 'agent_2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts the feature-off shape (enabled:false, no agents)', () => {
    const result = agentSubagentsSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('rejects agent_ids longer than MAX_SUBAGENTS', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: oversized,
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly MAX_SUBAGENTS entries', () => {
    const atCap = Array.from({ length: MAX_SUBAGENTS }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: atCap,
    });
    expect(result.success).toBe(true);
  });
});

describe('agentCreateSchema with subagents', () => {
  const base = {
    provider: 'openAI',
    model: 'gpt-4o-mini',
    tools: [],
  };

  it('passes with subagents omitted', () => {
    const result = agentCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('passes with a valid subagents config', () => {
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when subagents.agent_ids exceeds the cap', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: { enabled: true, agent_ids: oversized },
    });
    expect(result.success).toBe(false);
  });
});

describe('agentUpdateSchema with subagents', () => {
  it('accepts a partial update with only the disabled flag set', () => {
    const result = agentUpdateSchema.safeParse({
      subagents: { enabled: false, allowSelf: true, agent_ids: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects oversized agent_ids on update', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 3 }, (_, i) => `agent_${i}`);
    const result = agentUpdateSchema.safeParse({
      subagents: { enabled: true, agent_ids: oversized },
    });
    expect(result.success).toBe(false);
  });
});

describe('validateAgentModel', () => {
  const res = {} as never;
  const agent = { id: 'agent-1', model: 'claude-opus-5', provider: 'Claude' } as never;

  const req = (filter: boolean) =>
    ({
      config: {
        endpoints: {
          [EModelEndpoint.custom]: [
            { name: 'Claude', models: { default: ['claude-opus-5'], fetch: true, filter } },
          ],
        },
      },
    }) as never;

  it('logs a violation when the endpoint serves models, but not the one asked for', async () => {
    const logViolation = jest.fn().mockResolvedValue(undefined);

    const result = await validateAgentModel({
      req: req(true),
      res,
      agent,
      modelsConfig: { Claude: ['claude-sonnet-5'] },
      logViolation,
    });

    expect(logViolation).toHaveBeenCalledTimes(1);
    expect(result.isValid).toBe(false);
  });

  /* A dead gateway empties a filtered list. Banning the agent's owner for that
     is the failure this guard exists to prevent. */
  it('does not log a violation when a filter-managed endpoint has nothing to serve', async () => {
    const logViolation = jest.fn().mockResolvedValue(undefined);

    const result = await validateAgentModel({
      req: req(true),
      res,
      agent,
      modelsConfig: { Claude: [] },
      logViolation,
    });

    expect(logViolation).not.toHaveBeenCalled();
    expect(result.isValid).toBe(false);
    expect(result.error?.message).toContain(ErrorTypes.ENDPOINT_MODELS_NOT_LOADED);
  });

  it('still logs a violation for an empty endpoint that does not filter', async () => {
    const logViolation = jest.fn().mockResolvedValue(undefined);

    await validateAgentModel({
      req: req(false),
      res,
      agent,
      modelsConfig: { Claude: [] },
      logViolation,
    });

    expect(logViolation).toHaveBeenCalledTimes(1);
  });
});
