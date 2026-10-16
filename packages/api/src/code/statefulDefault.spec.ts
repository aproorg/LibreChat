import { isStatefulDefaultEligible } from './config';

type Environments = Parameters<typeof isStatefulDefaultEligible>[1];

const managed = {
  id: 'managed',
  name: 'Managed',
  type: 'managed',
  owner: 'deployment',
  baseURL: 'https://managed.example.com/v1',
} as const;
const attached = {
  id: 'attached',
  name: 'Attached',
  type: 'attached',
  owner: 'deployment',
  baseURL: 'https://bridge.example.com/v1',
  workerId: 'worker-1',
} as const;

describe('isStatefulDefaultEligible', () => {
  afterEach(() => {
    delete process.env.LIBRECHAT_CODE_DEFAULT_PROFILE;
  });

  it.each([undefined, '', 'default', 'bogus'])('is false when the setting is %p', (setting) => {
    if (setting != null) process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = setting;
    expect(isStatefulDefaultEligible({}, undefined)).toBe(false);
  });

  describe('with the setting stateful', () => {
    beforeEach(() => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';
    });

    it('is false without an agent', () => {
      expect(isStatefulDefaultEligible(null, undefined)).toBe(false);
      expect(isStatefulDefaultEligible(undefined, undefined)).toBe(false);
    });

    it('is true for an agent with no machine and no configured environments', () => {
      expect(isStatefulDefaultEligible({}, undefined)).toBe(true);
    });

    it('is true for a managed default or a managed id', () => {
      const environments: Environments = [{ ...managed, default: true }];
      expect(isStatefulDefaultEligible({}, environments)).toBe(true);
      expect(isStatefulDefaultEligible({ code_environment_id: 'managed' }, environments)).toBe(
        true,
      );
    });

    it('is false for an attached default or an attached id', () => {
      const environments: Environments = [{ ...attached, default: true }, managed];
      expect(isStatefulDefaultEligible({}, environments)).toBe(false);
      expect(isStatefulDefaultEligible({ code_environment_id: 'attached' }, environments)).toBe(
        false,
      );
    });

    it('is false for a code_environment_id that matches no configured environment', () => {
      expect(isStatefulDefaultEligible({ code_environment_id: 'gone' }, [managed])).toBe(false);
      expect(isStatefulDefaultEligible({ code_environment_id: 'gone' }, undefined)).toBe(false);
    });

    it('checks the normalized scope against the allowed list only when it is set', () => {
      expect(isStatefulDefaultEligible({}, undefined, undefined)).toBe(true);
      expect(isStatefulDefaultEligible({}, undefined, null)).toBe(true);
      expect(isStatefulDefaultEligible({}, undefined, ['user'])).toBe(true);
      expect(isStatefulDefaultEligible({}, undefined, ['conversation'])).toBe(false);
      expect(isStatefulDefaultEligible({}, undefined, [])).toBe(false);
      expect(
        isStatefulDefaultEligible({ stateful_code_environment: 'conversation' }, undefined, [
          'conversation',
        ]),
      ).toBe(true);
      expect(
        isStatefulDefaultEligible({ stateful_code_environment: 'conversation' }, undefined, [
          'user',
        ]),
      ).toBe(false);
    });
  });
});
