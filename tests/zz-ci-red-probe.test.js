// Deliberately failing test to prove CI turns red. Reverted in the next commit.
import { it } from 'node:test';
import assert from 'node:assert/strict';
it('ci red probe', () => { assert.equal(1, 2); });
