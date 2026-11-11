import { SearchError } from '@librechat/data-schemas';
import { safeFailure, safeFailureCode } from './failure';

describe('safeFailure', () => {
  it('names a driver failure by class, code and code name, never by message', () => {
    const error = Object.assign(new Error('SENTINEL text of the query'), {
      name: 'MongoServerError',
      code: 303,
      codeName: 'CommandNotSupported',
    });

    expect(safeFailure(error)).toEqual({
      type: 'Error',
      name: 'MongoServerError',
      code: 303,
      codeName: 'CommandNotSupported',
    });
    expect(JSON.stringify(safeFailure(error))).not.toContain('SENTINEL');
    expect(safeFailureCode(error)).toBe('MongoServerError:303');
  });

  it('tells a code bug from a network error', () => {
    expect(safeFailure(new TypeError('x is not a function'))).toEqual({
      type: 'Error',
      name: 'TypeError',
    });
    expect(safeFailure(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toEqual({
      type: 'Error',
      code: 'ECONNRESET',
    });
    expect(safeFailure(new SearchError('search_busy'))).toMatchObject({ code: 'search_busy' });
  });

  it('drops a name, code or code name that is not a short identifier', () => {
    const error = Object.assign(new Error('boom'), {
      name: 'Bad name with words',
      code: 'the user typed this, with spaces',
      codeName: 'has spaces too',
    });

    expect(safeFailure(error)).toEqual({ type: 'Error' });
    expect(safeFailureCode(error)).toBe('Error');
  });

  it('survives values that are not errors, and a property that throws', () => {
    const hostile = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('no');
      },
    });

    expect(safeFailure(undefined)).toEqual({ type: 'UnknownError' });
    expect(safeFailure('text')).toEqual({ type: 'UnknownError' });
    expect(safeFailure(hostile)).toEqual({ type: 'UnknownError' });
  });
});
