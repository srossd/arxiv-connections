import test from 'node:test';
import assert from 'node:assert/strict';
import { mailingDayOf } from '../src/puzzle.js';

test('a mailing is dated by the day arXiv labelled it, in Eastern time', () => {
  assert.equal(mailingDayOf('Fri, 14 Aug 2026 00:00:00 -0400'), '2026-08-14');
  assert.equal(mailingDayOf('Thu, 13 Aug 2026 00:00:00 -0400'), '2026-08-13');
  // Winter, when the offset is -0500.
  assert.equal(mailingDayOf('Mon, 12 Jan 2026 00:00:00 -0500'), '2026-01-12');
  assert.equal(mailingDayOf('nonsense'), null);
  assert.equal(mailingDayOf(undefined), null);
});

test('the header date never runs ahead of the puzzle day', () => {
  const announcedDay = (mailingDay, day) => (mailingDay && mailingDay < day ? mailingDay : day);
  // Weekend: papers really were announced on Friday.
  assert.equal(announcedDay('2026-08-14', '2026-08-15'), '2026-08-14');
  // Midnight-to-2am: the feed is already dated tomorrow, the puzzle is not.
  assert.equal(announcedDay('2026-08-14', '2026-08-13'), '2026-08-13');
  assert.equal(announcedDay('2026-08-14', '2026-08-14'), '2026-08-14');
  assert.equal(announcedDay(null, '2026-08-14'), '2026-08-14');
});
