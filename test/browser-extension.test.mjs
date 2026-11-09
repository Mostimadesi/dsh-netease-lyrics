// The browser-extension content script, driven in a vm with fake DOM/chrome.
// Guards the paused-video fix (2026-11-09): the heartbeat must keep reaching
// the host even when the payload is unchanged — a deduped heartbeat let the
// 10s freshness window lapse during a pause, the bvid association was dropped
// mid-watch and the plugin fell back to the music search chain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../browser-extension/content.js', import.meta.url), 'utf8');

const sent = [];
const intervals = [];
const listeners = new Map();
const video = { currentTime: 12.5, duration: 213, paused: false, ended: false };
const document = {
	title: '测试视频_哔哩哔哩_bilibili',
	addEventListener(type, fn) { listeners.set(type, fn); },
	querySelector(selector) { return selector === 'video' ? video : null; },
};
const chrome = { runtime: { sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); } } };
const location = { pathname: '/video/BV1GJ411x7h7' };
vm.runInNewContext(src, {
	location, document, chrome, console,
	setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
}, { filename: 'content.js' });

assert.equal(intervals.length, 2, 'content.js installs exactly a heartbeat and a nav check');
const heartbeat = intervals.find((row) => row.ms === 5000);
const navCheck = intervals.find((row) => row.ms === 1000);
assert.ok(heartbeat, 'the 5s heartbeat exists');
assert.ok(navCheck, 'the 1s SPA/bvid check exists');

// 1. heartbeats report the current video (and keep reporting when nothing changed)
heartbeat.fn();
assert.equal(sent.length, 1, 'first heartbeat reports');
assert.equal(sent[0].type, 'bili-session', 'message type');
assert.equal(sent[0].report.bvid, 'BV1GJ411x7h7', 'bvid from the URL');
assert.equal(sent[0].report.title, '测试视频_哔哩哔哩_bilibili', 'page title');
assert.equal(sent[0].report.positionSec, 12.5, 'video currentTime');
assert.equal(sent[0].report.durationSec, 213, 'video duration');
assert.equal(sent[0].report.playing, true, 'playing flag');
heartbeat.fn();
heartbeat.fn();
assert.equal(sent.length, 3, 'an unchanged payload keeps reporting (the pause fix)');

// 2. a paused video still reports (playing:false) — this is what keeps the
// bvid association alive while the user is paused
video.paused = true;
heartbeat.fn();
assert.equal(sent.length, 4, 'a paused heartbeat still reports');
assert.equal(sent.at(-1).report.playing, false, 'paused is reported as playing:false');
video.paused = false;

// 3. playback events report immediately
assert.ok(listeners.has('play') && listeners.has('pause') && listeners.has('seeked') && listeners.has('ended'),
	'the four playback events are bound');
const before = sent.length;
video.currentTime = 20;
listeners.get('seeked')();
assert.equal(sent.length, before + 1, 'a seek reports at once');
assert.equal(sent.at(-1).report.positionSec, 20, 'the seek position is reported');

// 4. the nav check reports the first bvid it learns, then only on changes
navCheck.fn();
const afterPrime = sent.length;
assert.equal(sent.at(-1).report.bvid, 'BV1GJ411x7h7', 'the nav check primes on the current bvid');
navCheck.fn();
assert.equal(sent.length, afterPrime, 'an unchanged bvid does not re-report');
location.pathname = '/video/BV15T4y1276S';
navCheck.fn();
assert.equal(sent.length, afterPrime + 1, 'a new bvid reports immediately');
assert.equal(sent.at(-1).report.bvid, 'BV15T4y1276S', 'the new bvid is reported');

// 5. leaving video pages (bangumi/ep, no BV id) stops reporting
location.pathname = '/bangumi/play/ep123456';
navCheck.fn();
assert.equal(sent.length, afterPrime + 1, 'a page without a BV id reports nothing');
location.pathname = '/video/BV1GJ411x7h7';
navCheck.fn();
assert.equal(sent.length, afterPrime + 2, 'coming back to a video reports again');

// 6. scope discipline: the content script never talks to bilibili itself
assert.ok(!/\bfetch\s*\(/.test(src), 'the content script performs no fetch');
assert.ok(!/api\.bilibili\.com/.test(src), 'the content script never calls the bilibili API');
assert.ok(!/document\.cookie/.test(src) && !/chrome\.cookies/.test(src), 'the content script reads no cookies');
assert.ok(!/localStorage/.test(src), 'no page storage is touched');

console.log('PASS: browser-extension content script — bvid extraction, pause-safe heartbeats, event/nav reporting, no page-side credentials.');
