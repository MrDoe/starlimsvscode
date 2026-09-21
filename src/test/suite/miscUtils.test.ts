import * as assert from 'assert';
import { clampValueToEncodedBudget } from '../../utilities/miscUtils';

const encodedLength = (value: string) =>
  new URLSearchParams([['Reason', value]]).toString().length - 'Reason='.length;

suite('miscUtils', () => {
  test('clampValueToEncodedBudget keeps values within the budget unchanged', () => {
    const value = 'BMBH-IT short check-in reason';

    assert.strictEqual(clampValueToEncodedBudget(value, 100, encodedLength), value);
  });

  test('clampValueToEncodedBudget truncates values that exceed the encoded budget', () => {
    const value = '# Check-in \u00e4\u00f6\u00fc **details** ' + 'x'.repeat(500);
    const budget = 200;

    const clamped = clampValueToEncodedBudget(value, budget, encodedLength);

    assert.ok(clamped.length < value.length);
    assert.ok(encodedLength(clamped) <= budget);
    assert.ok(value.startsWith(clamped));
  });

  test('clampValueToEncodedBudget returns an empty string when nothing fits', () => {
    assert.strictEqual(clampValueToEncodedBudget('some reason', 0, encodedLength), '');
    assert.strictEqual(clampValueToEncodedBudget('some reason', -10, encodedLength), '');
  });
});
