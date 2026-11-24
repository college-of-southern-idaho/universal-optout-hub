import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPrometheus, type Metric } from '../src/services/metrics.js';

test('renders a single gauge with HELP and TYPE headers', () => {
  const out = renderPrometheus([
    { name: 'consenthub_up', help: 'up', type: 'gauge', value: 1 },
  ]);
  assert.equal(out,
    '# HELP consenthub_up up\n' +
    '# TYPE consenthub_up gauge\n' +
    'consenthub_up 1\n');
});

test('emits HELP/TYPE once per name and groups labeled series', () => {
  const metrics: Metric[] = [
    { name: 'checks', help: 'decisions', type: 'gauge', value: 5, labels: { decision: 'allow' } },
    { name: 'checks', help: 'decisions', type: 'gauge', value: 2, labels: { decision: 'suppress' } },
  ];
  const out = renderPrometheus(metrics);
  assert.equal(out,
    '# HELP checks decisions\n' +
    '# TYPE checks gauge\n' +
    'checks{decision="allow"} 5\n' +
    'checks{decision="suppress"} 2\n');
  // The header appears exactly once.
  assert.equal(out.match(/# HELP checks/g)?.length, 1);
});

test('escapes label values and help text', () => {
  const out = renderPrometheus([
    { name: 'm', help: 'line1\nline2\\x', type: 'gauge', value: 1, labels: { k: 'a"b\\c' } },
  ]);
  assert.ok(out.includes('# HELP m line1\\nline2\\\\x'));
  assert.ok(out.includes('m{k="a\\"b\\\\c"} 1'));
});

test('omits the brace block when there are no labels', () => {
  const out = renderPrometheus([{ name: 'm', help: 'h', type: 'counter', value: 3, labels: {} }]);
  assert.ok(out.includes('\nm 3\n'));
  assert.ok(!out.includes('m{}'));
});

test('empty input yields just a newline', () => {
  assert.equal(renderPrometheus([]), '\n');
});
