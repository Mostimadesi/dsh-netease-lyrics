import assert from 'node:assert/strict';
import { createLyricRetry } from '../lib/lyric-retry.js';

// Fake clock: schedule/cancel record callbacks; fire(ms) runs everything due.
function makeClock() {
	let now = 0;
	const timers = [];
	return {
		now: () => now,
		fire(ms) {
			now += ms;
			for (let i = timers.length - 1; i >= 0; i -= 1) {
				if (timers[i].at <= now) {
					const t = timers.splice(i, 1)[0];
					t.fn();
				}
			}
		},
		schedule: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
		cancel: (handle) => { const i = timers.indexOf(handle); if (i >= 0) timers.splice(i, 1); },
		pending: () => timers.length,
	};
}

// 1. A miss schedules a retry after the delay; invalidate runs before the attempt.
{
	const clock = makeClock();
	const events = [];
	let invalidated = null;
	const r = createLyricRetry({
		delayMs: 15000, maxAutoRetries: 2,
		schedule: clock.schedule, cancel: clock.cancel,
		invalidate: (fp) => { invalidated = fp; },
		onAttempt: (a) => events.push(['attempt', a.attempt, a.fingerprint]),
	});
	r.note('fp1', 'unmatched');
	assert.equal(clock.pending(), 1, 'one retry scheduled after a miss');
	clock.fire(14999);
	assert.equal(events.length, 0, 'not fired before the delay');
	clock.fire(1);
	assert.equal(events.length, 1, 'fired after the delay');
	assert.equal(events[0][1], 1, 'attempt 1');
	assert.equal(invalidated, 'fp1', 'negative cache dropped before the retry');
}

// 2. Budget: exactly maxAutoRetries attempts per track, then pinned.
{
	const clock = makeClock();
	const events = [];
	const r = createLyricRetry({ delayMs: 10000, maxAutoRetries: 2, schedule: clock.schedule, cancel: clock.cancel, onAttempt: (a) => events.push(a.attempt) });
	r.note('fp1', 'error');
	clock.fire(10000); events[0] === 1 || assert.fail('first attempt');
	r.note('fp1', 'error');
	clock.fire(10000);
	assert.equal(events.length, 2, 'two attempts consumed');
	assert.equal(events[1], 2, 'second attempt is attempt 2');
	r.note('fp1', 'unmatched'); // third outcome: budget exhausted
	assert.equal(clock.pending(), 0, 'no third retry after the budget');
	clock.fire(30000);
	assert.equal(events.length, 2, 'still two attempts');
	assert.deepEqual(r.describe(), { delayMs: 10000, maxAutoRetries: 2, attempts: 2, pending: false, pendingAttempt: 0 }, 'describe pins the spent budget');
}

// 3. matched cancels the pending retry and resets the budget.
{
	const clock = makeClock();
	const events = [];
	const r = createLyricRetry({ delayMs: 10000, maxAutoRetries: 3, schedule: clock.schedule, cancel: clock.cancel, onAttempt: (a) => events.push(a.attempt) });
	r.note('fp1', 'unmatched');
	r.note('fp1', 'matched');
	assert.equal(clock.pending(), 0, 'pending retry cancelled on match');
	clock.fire(30000);
	assert.equal(events.length, 0, 'nothing fired after a match');
	// budget restored: a later miss can retry again
	r.note('fp1', 'error');
	assert.equal(clock.pending(), 1, 'budget restored after a match');
}

// 4. reset() (new track / manual rematch) cancels pending and restores budget.
{
	const clock = makeClock();
	const events = [];
	const r = createLyricRetry({ delayMs: 10000, maxAutoRetries: 2, schedule: clock.schedule, cancel: clock.cancel, onAttempt: (a) => events.push(a.attempt) });
	r.note('fp1', 'unmatched');
	r.note('fp1', 'unmatched');
	clock.fire(10000);
	assert.equal(events.length, 1, 'attempt 1 done');
	r.reset();
	assert.equal(clock.pending(), 0, 'pending cancelled by reset');
	r.note('fp2', 'unmatched');
	assert.equal(clock.pending(), 1, 'new track starts a fresh schedule');
	clock.fire(10000);
	assert.equal(events.length, 2);
	assert.equal(events[1], 1, 'attempt counter restarted by reset');
}

// 5. A retry scheduled for an old fingerprint fires onAttempt; the HOST decides
//    whether that fingerprint is still current (index.js re-checks). A pending
//    retry for a superseded track is not duplicated for the new one.
{
	const clock = makeClock();
	const events = [];
	const r = createLyricRetry({ delayMs: 10000, maxAutoRetries: 2, schedule: clock.schedule, cancel: clock.cancel, onAttempt: (a) => events.push(a.fingerprint) });
	r.note('old', 'unmatched');
	r.reset(); // host resets on the new fingerprint (observeLyrics)
	r.note('new', 'unmatched');
	clock.fire(10000);
	assert.deepEqual(events, ['new'], 'only the new track was retried');
}

// 6. maxAutoRetries = 0 disables auto-retry entirely.
{
	const clock = makeClock();
	const r = createLyricRetry({ delayMs: 10000, maxAutoRetries: 0, schedule: clock.schedule, cancel: clock.cancel, onAttempt: () => assert.fail('no attempts expected') });
	r.note('fp1', 'unmatched');
	assert.equal(clock.pending(), 0, 'no timer scheduled when disabled');
	clock.fire(60000);
	assert.deepEqual(r.describe(), { delayMs: 10000, maxAutoRetries: 0, attempts: 0, pending: false, pendingAttempt: 0 });
}

// 7. Config clamps: delay 5s..60s, retries 0..5, non-finite falls back.
{
	const clamped = createLyricRetry({ delayMs: 1000, maxAutoRetries: 99, schedule: () => {}, cancel: () => {} });
	assert.equal(clamped.describe().delayMs, 5000, 'delay lower-clamped to 5s');
	assert.equal(clamped.describe().maxAutoRetries, 5, 'retries upper-clamped to 5');
	const loose = createLyricRetry({ delayMs: Number.NaN, maxAutoRetries: Number.NaN, schedule: () => {}, cancel: () => {} });
	assert.equal(loose.describe().delayMs, 15000, 'NaN delay falls back to 15s');
	assert.equal(loose.describe().maxAutoRetries, 2, 'NaN retries falls back to 2');
}

// 8. dispose() cancels pending and zeroes state.
{
	const clock = makeClock();
	const r = createLyricRetry({ delayMs: 10000, maxAutoRetries: 2, schedule: clock.schedule, cancel: clock.cancel, onAttempt: () => assert.fail('no attempts after dispose') });
	r.note('fp1', 'unmatched');
	r.dispose();
	assert.equal(clock.pending(), 0, 'pending cancelled by dispose');
	clock.fire(60000);
	assert.deepEqual(r.describe().attempts, 0, 'attempts zeroed');
}

console.log('PASS: 8 lyric-retry scenarios — schedule/budget/pin, match-cancel, reset-per-track, host-side fingerprint guard, disabled mode, config clamps, dispose.');
