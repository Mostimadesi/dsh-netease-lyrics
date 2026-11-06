/**
 * dsh-netease-lyrics — workspace notice aggregation (host half).
 *
 * Pure functions, no I/O. The host half observes the process-wide session
 * event stream (`session/event`, dispatched globally) and folds the events of
 * every ROOT session (a user-facing conversation area; subagent/child agents
 * carry `header.parentSession` and are skipped) into a small notice state:
 *
 *   - `approval/asked` / `approval/decided`      → "xx 会话区有提问"（待确认）
 *   - `tool/call` name=ask_user_question (+ the
 *     `tool/ptc-dispatch` variant) and their
 *     `tool/result` / `user/message` reply       → "xx 会话区有提问"（待回答）
 *   - `turn/end`                                  → "xx 会话区第 x 轮对话结束"
 *     (cleared again by the next `turn/start`, and by a TTL at serialization
 *      time so a stale "round ended" cannot linger forever)
 *
 * The settle semantics mirror @deepseek-ai/dsh-user-questions' projection
 * fold: a pending result (or a TOOL_OUTCOME_UNKNOWN error) keeps the question
 * answerable ("continued"), an answer batch or a failure drops it. Unlike
 * that fold we do NOT gate on the "timed" request-header flag: a blocking
 * ask_user_question pauses the whole turn and is exactly as worth notifying
 * about. `approval/asked` + `approval/decided` land back-to-back under the
 * `never` policy (rejected), so a poll between the two appends would at worst
 * flash for one cycle that resolves itself.
 *
 * Serialization (`noticesForWire`) prunes entries whose session is gone from
 * the live store and turn-end records past their TTL, then projects the rest
 * to a compact wire shape consumed by the browser half via state.json.
 */

export const NOTICE_TURN_TTL_MS = 10 * 60 * 1000;
export const NOTICE_MAX_ITEMS = 12;

// @deepseek-ai/dsh-session's synthetic result code, spelled out so this
// module stays dependency-free.
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only sessions that are user-facing conversation areas generate notices.
 *  Subagent / workflow child sessions carry `header.parentSession` and are
 *  background machinery the user never talks to directly. */
export function isRootSession(session) {
	if (!isRecord(session) || !isRecord(session.header)) return false;
	return session.header.parentSession === undefined;
}

/** The session's creation `cwd` (validated absolute path), or ''. */
export function sessionCwdOf(session) {
	const header = isRecord(session) ? session.header : null;
	const cwd = isRecord(header) ? header.cwd : undefined;
	return typeof cwd === 'string' && cwd !== '' ? cwd : '';
}

/** Final path segment of a directory, for both Windows and POSIX spellings. */
export function basenameOf(cwd) {
	if (typeof cwd !== 'string' || cwd === '') return '';
	const parts = cwd.replace(/\\/g, '/').split('/').filter((part) => part !== '');
	return parts.length > 0 ? parts[parts.length - 1] : '';
}

function samePath(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
	const strip = (value) => value.replace(/[\\/]+$/, '');
	if (strip(a) === strip(b)) return true;
	// Windows directory spellings are case-insensitive; the registry stores a
	// realpath while the session header keeps the cwd it was created with.
	return strip(a).toLowerCase() === strip(b).toLowerCase();
}

/** Resolve the workspace display title for `{ cwd, sessionId }`.
 *  `workspaces` is the workspace registry's synchronous `list()` projection
 *  (or null when the service is unavailable): membership by sessionIds wins
 *  over a path match, because attachSession validated the cwd fact when the
 *  id was first accounted. Returns '' when nothing matched — the caller falls
 *  back to the directory basename. */
export function workspaceTitleFor(target, workspaces) {
	const cwd = isRecord(target) && typeof target.cwd === 'string' ? target.cwd : '';
	const sessionId = isRecord(target) && typeof target.sessionId === 'string' ? target.sessionId : '';
	const list = Array.isArray(workspaces) ? workspaces : null;
	if (list) {
		for (const workspace of list) {
			if (!isRecord(workspace) || typeof workspace.title !== 'string' || workspace.title === '') continue;
			const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
			if (sessionId !== '' && ids.includes(sessionId)) return workspace.title;
		}
		for (const workspace of list) {
			if (!isRecord(workspace) || typeof workspace.title !== 'string' || workspace.title === '') continue;
			if (samePath(String(workspace.path || ''), cwd)) return workspace.title;
		}
	}
	return '';
}

/** The `pending: true` tool-result marker that keeps a timed question
 *  answerable across turns (same contract as the user-questions fold). */
function isPendingContent(content) {
	if (!Array.isArray(content)) return false;
	const block = content.find((item) => isRecord(item) && item.type === 'text');
	if (!isRecord(block) || typeof block.text !== 'string') return false;
	try {
		const parsed = JSON.parse(block.text);
		return isRecord(parsed) && parsed.pending === true;
	} catch {
		return false;
	}
}

/** First human-readable question text out of `ask_user_question` arguments.
 *  Returns null for unreadable/empty batches — an unparseable call never
 *  looked like a question to the official fold either. */
function questionPreviewOf(argumentsText) {
	let parsed;
	try {
		parsed = JSON.parse(argumentsText);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
	for (const question of parsed.questions) {
		if (isRecord(question) && typeof question.question === 'string' && question.question.trim() !== '') {
			return question.question.trim().slice(0, 160);
		}
	}
	return null;
}

/** Aggregated notice state: `{ serial, sessions: Map<id, entry> }` where
 *  entry is `{ cwd, question, turnEnd }`. `serial` is bumped by the CALLER
 *  whenever an apply/dispose reports a change, so the client can key
 *  transitions on it. */
export function createNoticeState() {
	return { serial: 0, sessions: new Map() };
}

function ensureEntry(state, session) {
	let entry = state.sessions.get(session.id);
	if (!isRecord(entry)) {
		entry = { cwd: sessionCwdOf(session), question: null, turnEnd: null };
		state.sessions.set(session.id, entry);
	}
	return entry;
}

/** Drop an entry that holds nothing. Always reports a change. */
function pruneEntry(state, sessionId, entry) {
	if (entry.question !== null || entry.turnEnd !== null) return true;
	state.sessions.delete(sessionId);
	return true;
}

/** Fold one observed session event. Returns true when the wire-visible state
 *  changed (the caller bumps `state.serial`). Everything is defensive: events
 *  come from a live event bus, and a malformed payload must never throw the
 *  observer (per-listener containment would swallow it, but then the notice
 *  would silently never appear either). */
export function applyNoticeEvent(state, session, event, now = Date.now()) {
	if (!isRecord(state) || !(state.sessions instanceof Map)) return false;
	if (!isRootSession(session) || !isRecord(event)) return false;
	if (typeof session.id !== 'string' || session.id === '') return false;
	const stamp = Number.isFinite(now) ? now : Date.now();
	const id = session.id;
	const data = isRecord(event.data) ? event.data : null;

	switch (event.type) {
		case 'approval/asked': {
			if (!data || typeof data.id !== 'string' || data.id === '') return false;
			const toolName = typeof data.toolName === 'string' ? data.toolName.slice(0, 80) : '';
			const preview = typeof data.reason === 'string' ? data.reason.slice(0, 160) : '';
			const entry = ensureEntry(state, session);
			if (isRecord(entry.question) && entry.question.kind === 'approval' && entry.question.key === data.id
				&& entry.question.toolName === toolName && entry.question.preview === preview) return false;
			entry.question = { kind: 'approval', key: data.id, toolName, preview, at: stamp };
			return true;
		}
		case 'approval/decided': {
			if (!data || typeof data.id !== 'string') return false;
			const entry = state.sessions.get(id);
			if (!isRecord(entry) || !isRecord(entry.question)) return false;
			if (entry.question.kind !== 'approval' || entry.question.key !== data.id) return false;
			entry.question = null;
			return pruneEntry(state, id, entry);
		}
		case 'tool/call': {
			if (!data || data.name !== 'ask_user_question') return false;
			if (typeof data.callId !== 'string' || data.callId === '') return false;
			if (typeof data.arguments !== 'string') return false;
			const preview = questionPreviewOf(data.arguments);
			if (preview === null) return false;
			const entry = ensureEntry(state, session);
			if (isRecord(entry.question) && entry.question.kind === 'user-question' && entry.question.key === data.callId
				&& entry.question.preview === preview) return false;
			entry.question = { kind: 'user-question', key: data.callId, toolName: '', preview, at: stamp };
			return true;
		}
		case 'tool/ptc-dispatch': {
			if (!data || data.name !== 'ask_user_question' || data.isError === true) return false;
			if (typeof data.subCallId !== 'string' || data.subCallId === '') return false;
			if (!isPendingContent(data.content)) return false;
			const preview = isRecord(data.arguments) ? questionPreviewOf(JSON.stringify(data.arguments)) : null;
			if (preview === null) return false;
			const entry = ensureEntry(state, session);
			if (isRecord(entry.question) && entry.question.kind === 'user-question' && entry.question.key === data.subCallId
				&& entry.question.preview === preview) return false;
			entry.question = { kind: 'user-question', key: data.subCallId, toolName: '', preview, at: stamp };
			return true;
		}
		case 'tool/result': {
			if (!data || !isRecord(data.message)) return false;
			if (typeof data.message.toolCallId !== 'string' || data.message.toolCallId === '') return false;
			const entry = state.sessions.get(id);
			if (!isRecord(entry) || !isRecord(entry.question)) return false;
			if (entry.question.kind !== 'user-question' || entry.question.key !== data.message.toolCallId) return false;
			// Pending (timed out unattended, or unknown outcome after a crash)
			// keeps the question answerable; an answer batch or a failure ends it.
			const pending = isPendingContent(data.message.content)
				|| (isRecord(data.error) && data.error.code === TOOL_OUTCOME_UNKNOWN);
			if (pending) {
				if (entry.question.continued === true) return false;
				entry.question = { ...entry.question, continued: true };
				return true;
			}
			entry.question = null;
			return pruneEntry(state, id, entry);
		}
		case 'user/message': {
			if (!data) return false;
			const source = isRecord(data.source) ? data.source : null;
			if (!source || source.kind !== 'user-question-reply' || typeof source.callId !== 'string') return false;
			const entry = state.sessions.get(id);
			if (!isRecord(entry) || !isRecord(entry.question)) return false;
			if (entry.question.kind !== 'user-question' || entry.question.key !== source.callId) return false;
			entry.question = null;
			return pruneEntry(state, id, entry);
		}
		case 'turn/end': {
			if (!data || !Number.isFinite(Number(data.turn))) return false;
			const turn = Math.max(1, Math.round(Number(data.turn)));
			const outcome = isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : '';
			const entry = ensureEntry(state, session);
			if (isRecord(entry.turnEnd) && entry.turnEnd.turn === turn && entry.turnEnd.outcome === outcome) return false;
			entry.turnEnd = { turn, outcome, at: stamp };
			return true;
		}
		case 'turn/start': {
			// The next round starting makes a previous "round x ended" stale.
			const entry = state.sessions.get(id);
			if (!isRecord(entry) || !isRecord(entry.turnEnd)) return false;
			entry.turnEnd = null;
			return pruneEntry(state, id, entry);
		}
		default:
			return false;
	}
}

/** Forget a session entirely (`session/disposed`). Returns true when an entry
 *  was actually dropped. */
export function disposeSessionNotices(state, session) {
	if (!isRecord(state) || !(state.sessions instanceof Map)) return false;
	if (!isRecord(session) || typeof session.id !== 'string') return false;
	return state.sessions.delete(session.id);
}

/** Project the state to the wire shape, pruning as we go: entries whose
 *  session left the live store disappear, turn-end records older than the TTL
 *  drop, and empty entries are deleted. Pruning mutations bump `state.serial`
 *  so the client sees the change. `options`:
 *   - now: clock in ms (default Date.now())
 *   - turnTtlMs: turn-end retention (default NOTICE_TURN_TTL_MS)
 *   - liveSessionIds: Set of live session ids, or null to skip that prune
 *   - maxItems: wire cap (default NOTICE_MAX_ITEMS, hard cap 64)
 *   - titleOf({ sessionId, cwd }): workspace display title resolver */
export function noticesForWire(state, options = {}) {
	if (!isRecord(state) || !(state.sessions instanceof Map)) return { serial: 0, items: [] };
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const turnTtlMs = Number.isFinite(options.turnTtlMs) && options.turnTtlMs > 0 ? options.turnTtlMs : NOTICE_TURN_TTL_MS;
	const liveSessionIds = options.liveSessionIds instanceof Set ? options.liveSessionIds : null;
	const maxItems = Number.isFinite(options.maxItems) && options.maxItems > 0
		? Math.min(64, Math.round(options.maxItems)) : NOTICE_MAX_ITEMS;
	const titleOf = typeof options.titleOf === 'function' ? options.titleOf : null;

	let mutated = false;
	for (const [id, entry] of state.sessions) {
		if (!isRecord(entry)) {
			state.sessions.delete(id);
			mutated = true;
			continue;
		}
		if (liveSessionIds !== null && !liveSessionIds.has(id)) {
			state.sessions.delete(id);
			mutated = true;
			continue;
		}
		if (isRecord(entry.turnEnd) && Number(entry.turnEnd.at) < now - turnTtlMs) {
			entry.turnEnd = null;
			mutated = true;
		}
		if (entry.question === null && entry.turnEnd === null) {
			state.sessions.delete(id);
			mutated = true;
		}
	}
	if (mutated) state.serial += 1;

	const items = [];
	for (const [id, entry] of state.sessions) {
		if (entry.question === null && entry.turnEnd === null) continue;
		const question = isRecord(entry.question) ? { ...entry.question } : null;
		const turnEnd = isRecord(entry.turnEnd) ? { ...entry.turnEnd } : null;
		const at = question
			? Math.max(Number(question.at) || 0, turnEnd ? Number(turnEnd.at) || 0 : 0)
			: Number(turnEnd && turnEnd.at) || 0;
		items.push({
			sessionId: id,
			workspace: titleOf ? String(titleOf({ sessionId: id, cwd: entry.cwd }) || '') : '',
			question,
			turnEnd,
			at,
		});
	}
	// Actionable questions outrank informational round-endings; newest first.
	items.sort((a, b) => {
		const questionGap = (b.question ? 1 : 0) - (a.question ? 1 : 0);
		if (questionGap !== 0) return questionGap;
		return b.at - a.at;
	});
	return { serial: Number(state.serial) || 0, items: items.slice(0, maxItems) };
}

/** Acknowledge the wire-visible notices: drop every entry the last
 *  `noticesForWire` projection reported (a fresh snapshot is computed first so
 *  an ack can never erase notices that arrived after the user looked). A live
 *  question stays put — answering it is the agent conversation's job, and an
 *  ack must not swallow it back into silence. Returns true when anything was
 *  dropped. */
export function ackNotices(state, options = {}) {
	if (!isRecord(state) || !(state.sessions instanceof Map)) return false;
	const seen = noticesForWire(state, {
		now: Number.isFinite(options.now) ? options.now : Date.now(),
		liveSessionIds: options.liveSessionIds instanceof Set ? options.liveSessionIds : null,
		titleOf: typeof options.titleOf === 'function' ? options.titleOf : null,
	});
	let dropped = false;
	for (const item of seen.items) {
		if (!isRecord(item) || typeof item.sessionId !== 'string') continue;
		const entry = state.sessions.get(item.sessionId);
		if (!isRecord(entry)) continue;
		// Questions stay (answering them is the conversation's job), but a round
		// ending riding the same session is still consumed.
		const hadQuestion = item.question !== null && item.question !== undefined;
		if (item.turnEnd !== null && item.turnEnd !== undefined) entry.turnEnd = null;
		if (!hadQuestion && entry.question === null && entry.turnEnd === null) {
			state.sessions.delete(item.sessionId);
		}
		if (!hadQuestion || item.turnEnd !== null || item.turnEnd !== undefined) dropped = true;
	}
	if (dropped) state.serial += 1;
	return dropped;
}
