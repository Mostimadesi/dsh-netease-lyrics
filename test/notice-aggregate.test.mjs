// Contracts for lib/notice-aggregate.js — the host half's pure fold that turns
// globally observed session events into the workspace-notice wire state.
//
// Mirrors the settle semantics of @deepseek-ai/dsh-user-questions' projection
// (pending/TOOL_OUTCOME_UNKNOWN keep a question answerable, an answer batch or
// failure drops it) minus the timed-only gating, plus the round-ended notices
// (cleared by the next turn/start, retired by a TTL at serialization time).
import assert from 'node:assert/strict';
import {
	NOTICE_MAX_ITEMS, NOTICE_TURN_TTL_MS,
	ackNotices, applyNoticeEvent, basenameOf, createNoticeState, disposeSessionNotices,
	isRootSession, noticesForWire, sessionCwdOf, workspaceTitleFor,
} from '../lib/notice-aggregate.js';

const rootSession = (id = 's1', cwd = 'D:\\ws\\alpha') =>
	({ id, header: { cwd } });
const childSession = () =>
	({ id: 's2', header: { cwd: 'D:\\ws\\alpha', parentSession: 's1', delegationDepth: 1 } });
const askArgs = (text = '要继续吗？') => JSON.stringify({ questions: [{ id: 'q1', question: text }] });

// ---- session classification -------------------------------------------------
assert.equal(isRootSession(rootSession()), true, 'a plain session is a root session');
assert.equal(isRootSession(childSession()), false, 'subagent children are not root sessions');
assert.equal(isRootSession(null), false, 'null is not a session');
assert.equal(isRootSession({ id: 'x' }), false, 'a missing header is not root');
assert.equal(sessionCwdOf(rootSession()), 'D:\\ws\\alpha');
assert.equal(sessionCwdOf({ header: {} }), '', 'missing cwd reads as empty');
assert.equal(basenameOf('D:\\DeepSeek Harness\\workspace\\plugins_helper'), 'plugins_helper');
assert.equal(basenameOf('/home/user/music'), 'music');
assert.equal(basenameOf('D:\\'), 'D:');
assert.equal(basenameOf(''), '');

// ---- workspace title resolution ---------------------------------------------
{
	const registry = [
		{ title: '重命名过的工作区', path: 'D:\\ws\\alpha', sessionIds: ['s9'] },
		{ title: '别的', path: 'D:\\ws\\beta', sessionIds: [] },
	];
	assert.equal(workspaceTitleFor({ cwd: 'D:\\ws\\alpha', sessionId: 's1' }, registry), '重命名过的工作区',
		'the path match resolves the title');
	assert.equal(workspaceTitleFor({ cwd: 'D:\\WS\\ALPHA\\', sessionId: 's0' }, registry), '重命名过的工作区',
		'windows path spellings match case-insensitively');
	assert.equal(workspaceTitleFor({ cwd: 'D:\\ws\\alpha', sessionId: 's9' }, registry), '重命名过的工作区',
		'sessionIds membership is authoritative');
	assert.equal(workspaceTitleFor({ cwd: 'D:\\ws\\unknown', sessionId: 's1' }, registry), '',
		'no match reads as empty so the caller falls back to the basename');
	assert.equal(workspaceTitleFor({ cwd: 'D:\\ws\\alpha' }, null), '', 'a missing registry reads as empty');
}

// ---- approval asked / decided -----------------------------------------------
{
	const state = createNoticeState();
	const session = rootSession();
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/asked',
		data: { id: 'a1', toolName: 'pwsh', reason: 'run a command' } }, 1000), true);
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/asked',
		data: { id: 'a1', toolName: 'pwsh', reason: 'run a command' } }, 1001), false,
		'a repeated identical ask does not bump the state');
	assert.equal(state.sessions.get('s1').question.kind, 'approval');
	assert.equal(state.sessions.get('s1').question.toolName, 'pwsh');
	// A DIFFERENT approval id (a second ask without a decision) replaces the entry
	// rather than stacking — the pill shows one question per session.
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/asked',
		data: { id: 'a2', toolName: 'web_search' } }, 1002), true);
	// Deciding the OLD id does not clear the CURRENT question (and reports no
	// change — the visible state is identical).
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/decided',
		data: { id: 'a1', outcome: 'allowed-once' } }, 1003), false);
	assert.ok(state.sessions.get('s1').question, 'deciding a superseded id keeps the current question');
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/decided',
		data: { id: 'a2', outcome: 'rejected' } }, 1004), true);
	assert.equal(state.sessions.size, 0, 'the entry is pruned once it holds nothing');
	// The never-policy back-to-back pair nets to nothing at all.
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/asked', data: { id: 'a3' } }, 1005), true);
	assert.equal(applyNoticeEvent(state, session, { type: 'approval/decided',
		data: { id: 'a3', outcome: 'rejected' } }, 1006), true);
	assert.equal(noticesForWire(state, { now: 1006 }).items.length, 0,
		'asked + decided leaves no visible notice');
}

// ---- ask_user_question lifecycle ---------------------------------------------
{
	const state = createNoticeState();
	const session = rootSession();
	// Only ask_user_question calls with readable questions open a notice.
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'web_search', callId: 'x', arguments: '{}' } }, 1000), false);
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'c1', arguments: '{not json' } }, 1000), false,
		'unparseable arguments never look like a question');
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'c1', arguments: askArgs() } }, 1000), true);
	assert.equal(state.sessions.get('s1').question.preview, '要继续吗？');

	// A pending (timed-out, still answerable) result keeps the question.
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/result',
		data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"pending":true,"callId":"c1"}' }] } } }, 1100), true);
	assert.equal(state.sessions.get('s1').question.continued, true);
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/result',
		data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"pending":true,"callId":"c1"}' }] } } }, 1200), false,
		'a repeated pending result is idempotent');
	// The crash-repair synthetic outcome keeps it answerable too.
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/result',
		data: { message: { toolCallId: 'c1', content: [] }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } } }, 1300), false,
		'already-continued stays idempotent');
	// An answer batch settles it.
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/result',
		data: { message: { toolCallId: 'c1', content: [{ type: 'text',
			text: '{"answers":[{"id":"q1","selected":["继续"]}]}' }] } } }, 1400), true);
	assert.equal(state.sessions.size, 0, 'settled question prunes the entry');

	// A late reply for an unrelated call settles nothing.
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'c9', arguments: askArgs('确认？') } }, 2000), true);
	assert.equal(applyNoticeEvent(state, session, { type: 'user/message',
		data: { id: 'm1', source: { kind: 'user-question-reply', callId: 'other' }, content: [] } }, 2100), false);
	assert.ok(state.sessions.get('s1').question, 'an unrelated reply changes nothing');
	assert.equal(applyNoticeEvent(state, session, { type: 'user/message',
		data: { id: 'm2', source: { kind: 'user-question-reply', callId: 'c9' }, content: [] } }, 2200), true);
	assert.equal(state.sessions.size, 0, 'the steered reply settles the question');

	// A failed tool call also drops the question (it cannot be answered anymore).
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'c2', arguments: askArgs() } }, 3000), true);
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/result',
		data: { message: { toolCallId: 'c2', content: [], isError: true }, error: { code: 'ASK_ABORTED' } } }, 3100), true);
	assert.equal(state.sessions.size, 0);
}

// ---- the PTC dispatch variant (arguments arrive as an object) ---------------
{
	const state = createNoticeState();
	const session = rootSession();
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/ptc-dispatch',
		data: { name: 'ask_user_question', subCallId: 'p1', isError: false,
			arguments: { questions: [{ id: 'q1', question: '从子调度来的？' }] },
			content: [{ type: 'text', text: '{"pending":true}' }] } }, 1000), true);
	assert.equal(state.sessions.get('s1').question.key, 'p1');
	assert.equal(state.sessions.get('s1').question.preview, '从子调度来的？');
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/ptc-dispatch',
		data: { name: 'ask_user_question', subCallId: 'p2', isError: true,
			arguments: { questions: [] }, content: [{ type: 'text', text: '{"pending":true}' }] } }, 1100), false,
		'error dispatches are ignored');
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/ptc-dispatch',
		data: { name: 'ask_user_question', subCallId: 'p3', isError: false,
			arguments: { questions: [{ id: 'q1', question: 'x' }] }, content: [] } }, 1200), false,
		'non-pending content does not open a notice');
	// Settle via the shared tool/result path (keyed by the sub call id).
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/result',
		data: { message: { toolCallId: 'p1', content: [{ type: 'text', text: '{"answers":[]}' }] } } }, 1300), true);
	assert.equal(state.sessions.size, 0);
}

// ---- turn/end + turn/start ----------------------------------------------------
{
	const state = createNoticeState();
	const session = rootSession();
	assert.equal(applyNoticeEvent(state, session, { type: 'turn/end',
		data: { turn: 3, reason: { kind: 'completed' } } }, 1000), true);
	assert.equal(applyNoticeEvent(state, session, { type: 'turn/end',
		data: { turn: 3, reason: { kind: 'completed' } } }, 1100), false, 'duplicate turn/end is idempotent');
	assert.equal(applyNoticeEvent(state, session, { type: 'turn/end',
		data: { turn: 4, reason: null } }, 1200), true, 'a null reason still ends a round');
	assert.equal(state.sessions.get('s1').turnEnd.turn, 4);
	assert.equal(state.sessions.get('s1').turnEnd.outcome, '');
	assert.equal(applyNoticeEvent(state, session, { type: 'turn/start', data: { turn: 5 } }, 1300), true);
	assert.equal(state.sessions.size, 0, 'the next round retires the stale ending');
	assert.equal(applyNoticeEvent(state, session, { type: 'turn/end', data: {} }, 1400), false,
		'a malformed turn/end is ignored');
}

// ---- child sessions never generate notices -----------------------------------
{
	const state = createNoticeState();
	const child = childSession();
	assert.equal(applyNoticeEvent(state, child, { type: 'turn/end',
		data: { turn: 9, reason: { kind: 'completed' } } }, 1000), false);
	assert.equal(applyNoticeEvent(state, child, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'c1', arguments: askArgs() } }, 1000), false);
	assert.equal(applyNoticeEvent(state, child, { type: 'approval/asked',
		data: { id: 'a1', toolName: 'pwsh' } }, 1000), false);
	assert.equal(state.sessions.size, 0);
}

// ---- dispose + hostile inputs ---------------------------------------------------
{
	const state = createNoticeState();
	const session = rootSession();
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'c1', arguments: askArgs() } }, 1000), true);
	assert.equal(disposeSessionNotices(state, session), true);
	assert.equal(disposeSessionNotices(state, session), false, 'a second dispose is a no-op');
	assert.equal(disposeSessionNotices(state, null), false);
	assert.equal(applyNoticeEvent(null, session, { type: 'turn/end', data: { turn: 1 } }), false);
	assert.equal(applyNoticeEvent(state, null, { type: 'turn/end', data: { turn: 1 } }), false);
	assert.equal(applyNoticeEvent(state, session, null), false);
	assert.equal(applyNoticeEvent(state, session, { type: 'tool/call', data: null }), false);
}

// ---- noticesForWire: pruning, ordering, caps ----------------------------------
{
	const base = createNoticeState();
	const a = rootSession('sa', 'D:\\ws\\alpha');
	const b = rootSession('sb', 'D:\\ws\\beta');
	applyNoticeEvent(base, a, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, 1000);
	applyNoticeEvent(base, b, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'q1', arguments: askArgs() } }, 2000);
	applyNoticeEvent(base, a, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'q2', arguments: askArgs() } }, 3000);
	const wire = noticesForWire(base, {
		now: 4000,
		titleOf: (t) => (t.sessionId === 'sa' ? '甲' : '乙'),
	});
	assert.equal(wire.serial, 0, 'no prune happened yet, so the serial stays');
	assert.equal(wire.items.length, 2);
	assert.equal(wire.items[0].workspace, '甲', 'the newest question leads');
	assert.equal(wire.items[0].question.preview, '要继续吗？');
	assert.ok(wire.items[0].turnEnd, 'one item can carry both a question and a round ending');
	assert.equal(wire.items[1].workspace, '乙');
	assert.equal(wire.items[1].at, 2000);

	// The turn TTL retires old round endings (and bumps the serial for it).
	const stale = createNoticeState();
	applyNoticeEvent(stale, a, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, 1000);
	let out = noticesForWire(stale, { now: 1000 + NOTICE_TURN_TTL_MS });
	assert.equal(out.items.length, 1, 'exactly at the TTL the record is still kept');
	out = noticesForWire(stale, { now: 1000 + NOTICE_TURN_TTL_MS + 1 });
	assert.equal(out.items.length, 0, 'past the TTL the round ending is retired');
	assert.ok(out.serial > 0, 'the prune advanced the serial');
	assert.equal(stale.sessions.size, 0, 'the pruned entry is really gone');

	// A pending QUESTION has no TTL - only the live-session prune removes it.
	const question = createNoticeState();
	applyNoticeEvent(question, a, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'q1', arguments: askArgs() } }, 1000);
	out = noticesForWire(question, { now: 1000 + NOTICE_TURN_TTL_MS * 10 });
	assert.equal(out.items.length, 1, 'questions do not age out by TTL');
	out = noticesForWire(question, { now: 2000, liveSessionIds: new Set(['sb']) });
	assert.equal(out.items.length, 0, 'a session gone from the live store drops its notices');

	// The wire caps at NOTICE_MAX_ITEMS and the sort puts questions first.
	const many = createNoticeState();
	for (let i = 0; i < NOTICE_MAX_ITEMS + 5; i += 1) {
		const s = rootSession('s' + String(i));
		applyNoticeEvent(many, s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, i);
	}
	const onlyQuestion = rootSession('sz');
	applyNoticeEvent(many, onlyQuestion, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'qz', arguments: askArgs() } }, 5);
	out = noticesForWire(many, { now: 1000 });
	assert.equal(out.items.length, NOTICE_MAX_ITEMS);
	assert.equal(out.items[0].sessionId, 'sz', 'the actionable question outranks fresher round endings');
	assert.equal(out.items[1].sessionId, 's16', 'newest round ending first');

	// Hostile state shapes degrade to an empty wire, never a throw.
	assert.deepEqual(noticesForWire(null), { serial: 0, items: [] });
	assert.deepEqual(noticesForWire({ serial: 3, sessions: {} }), { serial: 0, items: [] });
}

// ---- ackNotices: viewing consumes round-endings, never questions ---------------
{
	// A question + a round ending on the same session: ack drops the ending,
	// keeps the question (answering is the conversation's job).
	const state = createNoticeState();
	const session = rootSession();
	applyNoticeEvent(state, session, { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'q1', arguments: askArgs() } }, 1000);
	applyNoticeEvent(state, session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, 1500);
	assert.equal(ackNotices(state, { now: 2000 }), true);
	let wire = noticesForWire(state, { now: 2100 });
	assert.equal(wire.items.length, 1);
	assert.ok(wire.items[0].question, 'the question survives the ack');
	assert.equal(wire.items[0].turnEnd, null, 'the round ending is consumed');

	// Only round endings: the ack empties the state entirely.
	const only = createNoticeState();
	applyNoticeEvent(only, rootSession('s9', 'D:\\ws\\gamma'), { type: 'turn/end',
		data: { turn: 4, reason: { kind: 'completed' } } }, 1000);
	assert.equal(ackNotices(only, { now: 1100 }), true);
	assert.equal(ackNotices(only, { now: 1200 }), false, 'a repeat ack is a no-op');
	assert.equal(noticesForWire(only, { now: 1300 }).items.length, 0);

	// An ack cannot erase notices that arrived AFTER the user looked: the
	// snapshot is re-computed first (a fresh question lands between the poll
	// the user saw and the ack reaching the host).
	const late = createNoticeState();
	const a = rootSession('sa', 'D:\\ws\\a');
	applyNoticeEvent(late, a, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, 1000);
	applyNoticeEvent(late, rootSession('sb', 'D:\\ws\\b'), { type: 'tool/call',
		data: { name: 'ask_user_question', callId: 'q2', arguments: askArgs('新问题') } }, 1100);
	assert.equal(ackNotices(late, { now: 1200 }), true);
	const lateWire = noticesForWire(late, { now: 1300 });
	assert.equal(lateWire.items.length, 1);
	assert.equal(lateWire.items[0].sessionId, 'sb', 'the newer question survives');

	// Hostile shapes degrade to no-ops.
	assert.equal(ackNotices(null), false);
	assert.equal(ackNotices({ serial: 1, sessions: {} }), false);
}

console.log('PASS: notice aggregation — root-session fold (approval / ask_user_question incl. PTC / turn end), settle semantics, dispose, TTL + live-session pruning, ordering and caps, ack keeps questions');
