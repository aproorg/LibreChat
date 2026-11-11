import assert from 'node:assert/strict';
import { test } from 'node:test';
import lighthouse from './lighthouse/database.cjs';

const { lighthouseDatabaseEnv } = lighthouse;

test('with no URI the lane keeps its in-memory database and added latency', () => {
  for (const uri of [undefined, '']) {
    assert.deepEqual(lighthouseDatabaseEnv(uri), {
      E2E_USE_MEMORY_MONGO: 'true',
      E2E_LATENCY_MONGO_DELAY_MS: '250',
    });
  }
});

test('with a URI the lane uses that database and adds no latency', () => {
  assert.deepEqual(lighthouseDatabaseEnv('mongodb://clone/test'), {
    E2E_USE_MEMORY_MONGO: 'false',
    MONGO_URI: 'mongodb://clone/test',
  });
});
