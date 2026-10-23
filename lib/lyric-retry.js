/**
 * dsh-netease-lyrics — first-round lyric-miss auto-retry.
 *
 * The lyric pipeline resolves once per track fingerprint. A miss can be
 * transient: QQ Music's SMTC session may reach us seconds before the online
 * catalog settles, a search can hiccup, and the 10-minute negative cache then
 * pins the miss in place — today only a manual rematch recovers.
 *
 * This controller schedules automatic retries for `unmatched` / `error`
 * verdicts: after `delayMs` it drops the negative cache for that fingerprint
 * and asks the host to resolve again, up to `maxAutoRetries` times per track.
 * `reset()` (new track / manual rematch) cancels any pending retry and
 * restores the full attempt budget; `dispose()` cancels for teardown.
 *
 * Everything time-based is injected, so unit tests drive it without real
 * timers; the host unrefs its timers so a pending retry never holds the
 * process open.
 */

export function createLyricRetry({
	delayMs = 15000,
	maxAutoRetries = 2,
	schedule = (fn, ms) => setTimeout(fn, ms),
	cancel = (handle) => clearTimeout(handle),
	invalidate = () => {},
	onAttempt = () => {},
	trace = () => {},
} = {}) {
	const delay = Number.isFinite(delayMs) ? Math.min(60000, Math.max(5000, Math.round(delayMs))) : 15000;
	const max = Number.isFinite(maxAutoRetries) ? Math.min(5, Math.max(0, Math.round(maxAutoRetries))) : 2;

	let pending = null; // { handle, fingerprint, attempt, at }
	let attempts = 0;

	function clearPending() {
		if (pending === null) return;
		try { cancel(pending.handle); } catch {}
		pending = null;
	}

	/**
	 * Report a resolve outcome for a fingerprint. `matched` (or any other
	 * non-miss) cancels the pending retry and resets the budget; a miss
	 * schedules the next retry while attempts remain.
	 */
	function note(fingerprint, status) {
		if (status !== 'unmatched' && status !== 'error') {
			clearPending();
			attempts = 0;
			return;
		}
		if (max <= 0 || attempts >= max) {
			if (pending !== null && pending.fingerprint === fingerprint) clearPending();
			return;
		}
		clearPending();
		attempts += 1;
		const attempt = attempts;
		const handle = schedule(() => {
			pending = null;
			// The track may have moved on while we waited; the host's
			// onAttempt re-checks the live fingerprint itself.
			try { invalidate(fingerprint); } catch {}
			trace('auto-retry attempt ' + attempt + '/' + max + ' for fp=' + fingerprint);
			onAttempt({ attempt, fingerprint });
		}, delay);
		pending = { handle, fingerprint, attempt };
	}

	/** New track or manual rematch: cancel and restore the full budget. */
	function reset() {
		clearPending();
		attempts = 0;
	}

	function dispose() {
		clearPending();
		attempts = 0;
	}

	function describe() {
		return {
			delayMs: delay,
			maxAutoRetries: max,
			attempts,
			pending: pending !== null,
			pendingAttempt: pending === null ? 0 : pending.attempt,
		};
	}

	return { note, reset, dispose, describe };
}
