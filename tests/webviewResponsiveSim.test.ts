/**
 * Responsive / layout simulation tests: the webview must render commits with
 * every kind of git reference display (branch, remote, tag, stash, checked-out
 * head), and must react to window resizes at different view widths without
 * losing content or leaving overlay elements (dialogs / dropdown menus) behind
 * that would occlude the table.
 */
/**
 * @jest-environment jsdom
 */
import * as fs from 'fs';
import * as path from 'path';

declare const document: any;
declare const window: any;
declare const Event: any;
declare const MessageEvent: any;

const REPO = '/path/to/repo';

const hash = (c: string) => c.padEnd(40, '0').substring(0, 40);

// A small branching history:   D (head) ─ C ─ B1 ─ A   and   B2 ─ A
// D carries many ref kinds; B2 is a plain parallel branch commit (widens the graph).
const A = { hash: hash('a'), parents: [], heads: [], tags: [], remotes: [], stash: null, author: 'Ada', email: 'ada@example.com', date: 1751000000, message: 'root commit' };
const B1 = { hash: hash('b1'), parents: [A.hash], heads: [], tags: [], remotes: [], stash: null, author: 'Ada', email: 'ada@example.com', date: 1752000000, message: 'work on main line' };
const B2 = { hash: hash('b2'), parents: [A.hash], heads: [], tags: [], remotes: [], stash: null, author: 'Bob', email: 'bob@example.com', date: 1752500000, message: 'parallel topic' };
const C = { hash: hash('c'), parents: [B1.hash], heads: [], tags: [], remotes: [], stash: null, author: 'Ada', email: 'ada@example.com', date: 1753000000, message: 'continue main line' };
const D = {
	hash: hash('d'), parents: [C.hash],
	heads: ['develop', 'feature/x'],
	tags: [{ name: 'v2.0.0', annotated: true }, { name: 'origin/v1.9.0', annotated: false }],
	remotes: [{ name: 'origin/feature/x', remote: 'origin' }, { name: 'origin/release/1.0', remote: 'origin' }],
	stash: null, author: 'Ada', email: 'ada@example.com', date: 1754000000, message: 'merge point with refs'
};
const STASH_COMMIT = {
	hash: hash('s'), parents: [D.hash], heads: [], tags: [], remotes: [],
	stash: { selector: 'stash@{0}', baseHash: D.hash, untrackedFilesHash: null },
	author: 'Ada', email: 'ada@example.com', date: 1755000000, message: 'WIP on develop'
};

function makeState() {
	return {
		avatar: null,
		config: {
			commitOrdering: 'date',
			commitDetailsView: { autoCenter: true, fileTreeCompactFolders: true, fileViewType: 'File Tree', location: 'Inline' },
			contextMenuActionsVisibility: {},
			customBranchGlobPatterns: [], customEmojiShortcodeMappings: [], customPullRequestProviders: [],
			dateFormat: { type: 'relative', short: true, iso: false, string: '' },
			defaultColumnVisibility: { date: true, author: true, commit: true, signature: false },
			dialogDefaults: {}, enhancedAccessibility: false,
			fetchAndPrune: false, fetchAndPruneTags: false, fetchAvatars: false,
			gerrit: {
				enabled: true, remote: 'origin', fetchMode: 'latest', fetchLimit: 10, patchsets: 'latest', autoFetch: false,
				showChangeRefs: true, includeChangeCommits: true, showReviewProgress: true,
				showMetaCommits: 'collapsed', statusFilter: { new: true, merged: false, abandoned: false, wip: false },
				showPushButton: true, showControlsBar: true
			},
			graph: { colours: ['#0085d9'], style: 'rounded', issueLinking: {}, grid: { x: 10, y: 24, offsetX: 8, offsetY: 8, expandY: 8 } },
			initialLoadCommits: 500, keybindings: {}, loadMoreCommits: 100, loadMoreCommitsAutomatically: true,
			markdown: false, mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }, onRepoLoad: { showCheckedOutBranch: null, showSpecificBranches: [] }, pullRequests: { enabled: false }, referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
			showCommitBodyInline: false, stickyHeader: true, tabIconColourTheme: 'colour'
		},
		lastActiveRepo: REPO,
		loadViewTo: null,
		repos: { [REPO]: {
			cdvDivider: 50, cdvHeight: 50, columnWidths: null, commitOrdering: 'default', fileViewType: null, hideRemotes: [],
			includeCommitsMentionedByReflogs: null, issueLinkingConfig: {}, lastImportAt: 0, name: 'repo',
			onlyFollowFirstParent: null, onRepoLoadShowCheckedOutBranch: null, onRepoLoadShowSpecificBranches: null,
			pullRequestConfig: null, showRemoteBranches: false, showRemoteBranchesV2: null, showStashes: null,
			showTags: null, workspaceFolderIndex: null
		} },
		loadRepoInfoRefreshId: 1,
		loadCommitsRefreshId: 1
	};
}

const sentMessages: any[] = [];
let webviewState: any;

const VIEW_HTML = '<div id="view" tabindex="-1">' +
	'<div id="controls"><span id="repoControl"><div id="repoDropdown" class="dropdown"></div></span>' +
	'<span id="branchControl"><div id="branchDropdown" class="dropdown"></div></span>' +
	'<span id="authorControl"><div id="authorDropdown" class="dropdown"></div></span>' +
	'<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox"></label>' +
	'<div id="currentBtn"></div><div id="findBtn"></div><div id="terminalBtn"></div><div id="settingsBtn"></div><div id="fetchBtn"></div><div id="refreshBtn"></div></div>' +
	'<div id="gerritControls"><span class="gerritRowLabel">Gerrit:</span>' +
		'<span id="gerritFilterControl"></span><div id="gerritAmendBtn"></div><div id="gerritSubmitBtn"></div><div id="gerritClearRefsBtn"></div></div>' +
	'<div id="content"><div id="commitGraph"></div><div id="commitTable"></div></div>' +
	'<div id="footer"></div></div>';

// Mutable window size used by the window.outerWidth/outerHeight getters (so tests can simulate resizes)
const winSize = { w: 1024, h: 768 };

// jsdom shares one window across the tests of this file: record every listener the bundle
// registers on the persistent nodes (window / document / body) and remove them at the start of
// each loadWebview() call, so the bundle instances of earlier tests no longer respond to
// dispatched messages or events (in production, resetting the webview HTML tears the old page down).
const recordedListeners: { target: any, type: string, cb: any }[] = [];
for (const target of [window, document, document.body]) {
	const origAddEventListener = target.addEventListener.bind(target);
	target.addEventListener = (type: any, cb: any, ...rest: any[]) => {
		recordedListeners.push({ target: target, type: type, cb: cb });
		return origAddEventListener(type, cb, ...rest);
	};
}
function removeStaleListeners() {
	for (const listener of recordedListeners.splice(0)) listener.target.removeEventListener(listener.type, listener.cb);
}

function loadWebview() {
	removeStaleListeners();
	document.body.innerHTML = VIEW_HTML;
	Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => winSize.w });
	Object.defineProperty(window, 'outerHeight', { configurable: true, get: () => winSize.h });
	// The resize handler coalesces bursts of resize events with requestAnimationFrame: run the
	// frames synchronously so the assertions below can be made immediately after the dispatch
	window.requestAnimationFrame = (cb: any) => { cb(); return 0; };
	window.cancelAnimationFrame = () => undefined;
	(globalThis as any).acquireVsCodeApi = () => ({
		postMessage: (msg: any) => { sentMessages.push(msg); return undefined; },
		getState: () => webviewState,
		setState: (state: any) => { webviewState = state; }
	});
	const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'out.min.js'), 'utf8');
	// eslint-disable-next-line no-eval
	eval('var initialState = ' + JSON.stringify(makeState()) + ', globalState = ' + JSON.stringify({ avatars: {} }) + ', workspaceState = ' + JSON.stringify({}) + ';\n' + script);
	window.dispatchEvent(new Event('load'));
}

function respondToRepoInfo() {
	const repoInfoMsg = sentMessages.filter((m) => m.command === 'loadRepoInfo').pop();
	expect(repoInfoMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadRepoInfo', refreshId: repoInfoMsg.refreshId, error: null,
		branches: ['develop'], head: 'develop', remotes: ['origin'], stashes: [], isRepo: true
	} }));
}

function respondToLoadCommits(commits: any[], head: string = D.hash) {
	const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(loadMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: head, tags: [],
		moreAvailable: false, onlyFollowFirstParent: false, gerritStates: [], commits: commits
	} }));
}

/** Simulate the width of the #view element (jsdom has no layout engine). */
function setViewClientWidth(px: number) {
	Object.defineProperty(document.getElementById('view'), 'clientWidth', { configurable: true, get: () => px });
}

function resizeWindow(w: number, h = winSize.h) {
	winSize.w = w;
	winSize.h = h;
	window.dispatchEvent(new Event('resize'));
}

describe('Webview responsive simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;
		winSize.w = 1024;
		winSize.h = 768;

		(window as any).Element.prototype.scroll = () => undefined;
		loadWebview();
	});

	test('renders every kind of git reference display on the commit table', () => {
		respondToRepoInfo();
		respondToLoadCommits([STASH_COMMIT, D, C, B2, B1, A]);

		// All six commits (incl. the stash entry) render as rows
		expect(document.querySelectorAll('tr.commit').length).toBe(6);

		// The stash commit renders a stash ref chip showing the stash index only ("{0}", not "stash@{0}")
		const stashRef = document.querySelector('.gitRef.stash');
		expect(stashRef).not.toBeNull();
		expect(stashRef.dataset.name).toBe('stash@{0}');
		expect(stashRef.textContent).toContain('{0}');
		expect(stashRef.textContent).not.toContain('stash@');

		// The checked-out branch gets the active head chip and the commit-head dot
		const activeHead = document.querySelector('.gitRef.head.active');
		expect(activeHead).not.toBeNull();
		expect(activeHead.dataset.name).toBe('develop');
		expect(document.querySelector('.commitHeadDot')).not.toBeNull();

		// A second, non-active local branch is rendered as a plain head chip
		const featureHead = document.querySelector('.gitRef.head[data-name="feature/x"]:not(.active)');
		expect(featureHead).not.toBeNull();

		// origin/feature/x is combined into the feature/x head chip (combineLocalAndRemoteBranchLabels)
		const combinedRemote = featureHead.querySelector('.gitRefHeadRemote[data-remote="origin"]');
		expect(combinedRemote).not.toBeNull();
		expect(combinedRemote.dataset.fullref).toBe('origin/feature/x');

		// A remote ref with no matching local branch stays standalone
		const standaloneRemote = document.querySelector('.gitRef.remote[data-name="origin/release/1.0"]');
		expect(standaloneRemote).not.toBeNull();
		expect(standaloneRemote.dataset.remote).toBe('origin');

		// Annotated vs lightweight tags, and a tag combined with its remote-tracking copy
		const annotatedTag = document.querySelector('.gitRef.tag[data-name="v2.0.0"]');
		expect(annotatedTag.dataset.tagtype).toBe('annotated');
		const remoteTag = document.querySelector('.gitRef.tag[data-name="v1.9.0"]');
		expect(remoteTag.dataset.tagtype).toBe('lightweight');
		expect(remoteTag.querySelector('.gitRefHeadRemote[data-remote="origin"][data-fullref="origin/tags/v1.9.0"]')).not.toBeNull();
	});

	test('a burst of resize events is coalesced into a single animation frame', () => {
		respondToRepoInfo();
		respondToLoadCommits([STASH_COMMIT, D, C, B2, B1, A]);

		// Queue animation frames instead of running them synchronously, and count cancels
		let frames: any[] = [], cancelled = 0, rafId = 0;
		window.requestAnimationFrame = (cb: any) => { frames.push(cb); return ++rafId; };
		window.cancelAnimationFrame = () => { cancelled++; };

		const graphGroupBefore = document.querySelector('#commitGraph svg g');
		setViewClientWidth(900);
		window.dispatchEvent(new Event('resize'));
		window.dispatchEvent(new Event('resize'));
		window.dispatchEvent(new Event('resize'));

		// The later events superseded the earlier ones' pending frames (coalescing; other
		// rAF consumers in the webview may cancel additional frames of their own)
		expect(cancelled).toBeGreaterThanOrEqual(2);
		// Nothing has been re-rendered yet: the frames are still pending
		expect(document.querySelector('#commitGraph svg g')).toBe(graphGroupBefore);

		// Flushing the pending frames applies the resize (rendering a fresh graph group)
		const flush = frames.splice(0);
		for (const cb of flush) cb();
		expect(document.querySelector('#commitGraph svg g')).not.toBe(graphGroupBefore);
		expect(document.querySelectorAll('tr.commit').length).toBe(6);
	});

	test('resize with an unchanged window size re-renders without disturbing the table', () => {
		respondToRepoInfo();
		respondToLoadCommits([STASH_COMMIT, D, C, B2, B1, A]);
		const table = document.getElementById('commitTable');
		const rowsBefore = document.querySelectorAll('tr.commit').length;
		const classBefore = table.className;

		// The webview receives resize events while its outer size is unchanged (e.g. zoom changes)
		expect(() => {
			setViewClientWidth(900);
			window.dispatchEvent(new Event('resize'));
		}).not.toThrow();

		// The commit rows and layout mode must survive the re-render
		expect(document.querySelectorAll('tr.commit').length).toBe(rowsBefore);
		expect(table.className).toBe(classBefore);
		expect(table.className).toContain('autoLayout');
	});

	test('narrowing the window limits the graph width, widening it removes the limit', () => {
		respondToRepoInfo();
		respondToLoadCommits([D, C, B2, B1, A]);
		const table = document.getElementById('commitTable');
		expect(table.className).toContain('autoLayout'); // jsdom has no layout: clientWidth is 0 at first render

		// 1. Shrink the view to a very narrow width: the graph column must be capped at ~1/3 of the view
		//    (this history has a graph content width of ~26px, so the cap only bites below ~78px)
		setViewClientWidth(60);
		resizeWindow(80);
		expect(table.className).toContain('limitGraphWidth');
		expect(table.style.getPropertyValue('--limitGraphWidth')).toBe(Math.round(60 / 3) + 'px');

		// The commit rows are all still rendered (nothing is collapsed or lost at narrow width)
		expect(document.querySelectorAll('tr.commit').length).toBe(5);
		expect(document.querySelector('.gitRef.head.active')).not.toBeNull();

		// 2. Widen the view: the cap is removed and the auto layout restored
		setViewClientWidth(4000);
		resizeWindow(4096);
		expect(table.className).toBe('autoLayout');
		expect(table.style.getPropertyValue('--limitGraphWidth')).toBe('');

		// 3. Shrink again to a mid width: the cap is re-applied relative to the new width
		setViewClientWidth(66);
		resizeWindow(86);
		expect(table.className).toContain('limitGraphWidth');
		expect(table.style.getPropertyValue('--limitGraphWidth')).toBe('22px');
	});

	test('resizes at several widths never leave overlay elements that could occlude the table', () => {
		respondToRepoInfo();
		respondToLoadCommits([STASH_COMMIT, D, C, B2, B1, A]);

		const widths = [220, 480, 900, 1440, 2560];
		for (const w of widths) {
			setViewClientWidth(w);
			resizeWindow(w + 24);

			// The toolbar, Gerrit controls row and footer stay present and in order at every width
			expect(document.getElementById('controls')).not.toBeNull();
			expect(document.getElementById('gerritControls')).not.toBeNull();
			expect(document.getElementById('footer')).not.toBeNull();

			// All commits and their ref chips remain rendered and non-hidden
			expect(document.querySelectorAll('tr.commit').length).toBe(6);
			for (const chip of Array.from<any>(document.querySelectorAll('.gitRef'))) {
				expect(chip.classList.contains('hidden')).toBe(false);
				expect(chip.textContent.length).toBeGreaterThan(0);
			}

			// No dialog is left open, and no dropdown menu is attached over the table content
			expect(document.querySelector('.dialog')).toBeNull();
			for (const menu of Array.from<any>(document.querySelectorAll('.dropdownMenu'))) {
				expect(menu.closest('#content')).toBeNull(); // menus live inside the controls bar, never over the commit table
			}
		}
	});
});
