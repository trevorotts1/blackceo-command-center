import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { needsPlanningAnswer } from '../../src/lib/board/planning-chip';

describe('needsPlanningAnswer', () => {
  it('true while a planning session is open and unfinished', () => {
    assert.equal(needsPlanningAnswer({ planning_session_key: 'k', planning_complete: 0 }), true);
    assert.equal(needsPlanningAnswer({ planning_session_key: 'k' }), true);
  });
  it('false with no session, when complete, or when a spec is locked', () => {
    assert.equal(needsPlanningAnswer({}), false);
    assert.equal(needsPlanningAnswer({ planning_session_key: null }), false);
    assert.equal(needsPlanningAnswer({ planning_session_key: 'k', planning_complete: 1 }), false);
    assert.equal(needsPlanningAnswer({ planning_session_key: 'k', planning_spec: '{}' }), false);
  });
});
