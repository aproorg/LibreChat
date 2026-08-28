import { getModelDisplayName } from './endpoints';

describe('getModelDisplayName', () => {
  it('returns the configured label', () => {
    expect(getModelDisplayName({ 'model-id': 'Model Label' }, 'model-id')).toBe('Model Label');
  });

  it('falls back to the model id for an empty label', () => {
    expect(getModelDisplayName({ 'model-id': '' }, 'model-id')).toBe('model-id');
  });

  it('returns undefined without a model id', () => {
    expect(getModelDisplayName({ 'model-id': 'Model Label' }, undefined)).toBeUndefined();
  });
});
