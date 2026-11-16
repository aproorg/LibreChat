import type { TModelSpec } from 'librechat-data-provider';
import { filterModelSpecsByAccess, sanitizeModelSpecs } from './index';
import { createAccess } from '~/access';

const spec = (name: string, extra: Partial<TModelSpec> = {}, endpoint = 'openAI'): TModelSpec =>
  ({ name, label: name, preset: { endpoint }, ...extra }) as TModelSpec;

const access = createAccess(
  {
    specs: new Map([['own', { users: ['a@x.is'] }]]),
    endpoints: new Map([['Mistral', { users: ['a@x.is'] }]]),
    mcpServers: new Map([['sindri', { users: ['a@x.is'] }]]),
  },
  { email: 'b@x.is', groups: new Set() },
);

describe('filterModelSpecsByAccess', () => {
  const list = [
    spec('open'),
    spec('own'),
    spec('viaEndpoint', {}, 'Mistral'),
    spec('viaMcp', { mcpServers: ['sindri'] }),
  ];

  it('drops specs by own rule, endpoint rule and mcpServers rule', () => {
    const result = filterModelSpecsByAccess({ list }, access);
    expect(result.list.map((s) => s.name)).toEqual(['open']);
  });

  it('keeps specs for a permitted caller', () => {
    const allowed = createAccess(
      {
        specs: new Map([['own', { users: ['a@x.is'] }]]),
        endpoints: new Map(),
        mcpServers: new Map(),
      },
      { email: 'a@x.is', groups: new Set() },
    );
    expect(filterModelSpecsByAccess({ list }, allowed).list).toHaveLength(4);
  });

  it('returns the same object for null access', () => {
    const specs = { list };
    expect(filterModelSpecsByAccess(specs, null)).toBe(specs);
  });

  it('strips allowedFor from sanitized specs', () => {
    const out = sanitizeModelSpecs({
      list: [spec('s', { allowedFor: { users: ['a@x.is'] } } as Partial<TModelSpec>)],
    });
    expect(out.list[0]).not.toHaveProperty('allowedFor');
  });
});
