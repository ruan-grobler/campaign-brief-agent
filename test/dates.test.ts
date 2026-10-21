import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedReason, isIsoDate, shiftWorkingDays } from '../src/dates.ts';

const closed = new Map([
  ['2026-11-26', 'US Thanksgiving'],
  ['2026-11-27', 'Thanksgiving Friday'],
]);

test('counts working days back over Thanksgiving and a weekend', () => {
  const { date, skipped } = shiftWorkingDays('2026-12-01', -5, closed);
  assert.equal(date, '2026-11-20');
  assert.deepEqual(skipped, ['2026-11-27 (Thanksgiving Friday)', '2026-11-26 (US Thanksgiving)']);
});

test('zero working days moves a closed day to the next working day', () => {
  assert.equal(shiftWorkingDays('2026-11-26', 0, closed).date, '2026-11-30');
});

test('names weekends and closed days', () => {
  assert.equal(closedReason('2026-11-28', closed), 'weekend');
  assert.equal(closedReason('2026-11-26', closed), 'US Thanksgiving');
  assert.equal(closedReason('2026-11-30', closed), undefined);
});

test('rejects dates that do not exist', () => {
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('1 Dec 2026'), false);
  assert.equal(isIsoDate('2026-12-01'), true);
});
