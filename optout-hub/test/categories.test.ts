import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setCategoriesForTest, cascades, isProtectedCategory, isKnownCategory,
  isAssignableCategory, assignableCategories, listCategories, matrixView,
} from '../src/services/categories.js';

// Seed the default legally-grounded set + matrix (mirrors migration 016).
function seedDefaults() {
  _setCategoriesForTest(
    [
      { key: 'marketing', label: 'Marketing', protected: false, sort_order: 10, archived: false },
      { key: 'transactional', label: 'Transactional', protected: false, sort_order: 20, archived: false },
      { key: 'emergency', label: 'Emergency', protected: true, sort_order: 30, archived: false },
    ],
    [
      ['marketing', 'marketing'],
      ['transactional', 'transactional'],
      ['transactional', 'marketing'],
    ],
  );
}

test('cascades follows the matrix', () => {
  seedDefaults();
  assert.equal(cascades('marketing', 'marketing'), true);
  assert.equal(cascades('marketing', 'transactional'), false);   // marketing STOP does NOT hit transactional
  assert.equal(cascades('transactional', 'transactional'), true);
  assert.equal(cascades('transactional', 'marketing'), true);    // transactional cascades up
});

test('a protected category is never a cascade target, even if a row exists', () => {
  // Force an (illegal) row targeting the protected category.
  _setCategoriesForTest(
    [
      { key: 'marketing', label: 'Marketing', protected: false, sort_order: 10, archived: false },
      { key: 'emergency', label: 'Emergency', protected: true, sort_order: 30, archived: false },
    ],
    [['marketing', 'emergency']],   // matrix says cascade, but emergency is protected
  );
  assert.equal(isProtectedCategory('emergency'), true);
  assert.equal(cascades('marketing', 'emergency'), false);       // protection overrides the matrix
});

test('unknown categories: not known, not protected, never cascade', () => {
  seedDefaults();
  assert.equal(isKnownCategory('nope'), false);
  assert.equal(isProtectedCategory('nope'), false);
  assert.equal(cascades('nope', 'marketing'), false);
  assert.equal(cascades('marketing', 'nope'), false);
});

test('an archived category is known but not assignable, and still cascades for existing services', () => {
  _setCategoriesForTest(
    [
      { key: 'marketing', label: 'Marketing', protected: false, sort_order: 10, archived: false },
      { key: 'legacy', label: 'Legacy', protected: false, sort_order: 40, archived: true },
    ],
    [['legacy', 'marketing'], ['legacy', 'legacy']],
  );
  assert.equal(isKnownCategory('legacy'), true);
  assert.equal(isAssignableCategory('legacy'), false);        // can't assign to new services
  assert.equal(isAssignableCategory('marketing'), true);
  assert.deepEqual(assignableCategories().map((c) => c.key), ['marketing']);   // dropdown excludes archived
  // the engine still honors an archived source category for services already on it
  assert.equal(cascades('legacy', 'marketing'), true);
});

test('listCategories sorts by sort_order and matrixView locks protected targets', () => {
  seedDefaults();
  assert.deepEqual(listCategories().map((c) => c.key), ['marketing', 'transactional', 'emergency']);
  const view = matrixView();
  assert.equal(view.categories.length, 3);
  // every cell whose target is emergency is locked and never enabled
  const emerCells = view.cells.filter((c) => c.target === 'emergency');
  assert.ok(emerCells.length > 0);
  assert.ok(emerCells.every((c) => c.locked && !c.enabled));
  // the transactional→marketing cell is enabled
  assert.equal(view.cells.find((c) => c.source === 'transactional' && c.target === 'marketing')?.enabled, true);
});
