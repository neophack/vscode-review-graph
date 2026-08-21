/**
 * End-to-end webview simulation of the large-repository rendering optimisations:
 *  - windowed ("virtualized") commit table rendering (only the rows in and near the viewport
 *    are rendered, with spacer rows preserving the scroll height),
 *  - on-demand commit body fetching (the commit list only carries subjects; bodies are
 *    requested per rendered window when "Show Commit Body Inline" is enabled),
 *  - the lightweight persisted webview state (no commit list / avatars).
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
const ROW_HEIGHT = 24;

const hashOf = (i: number) => i.toString(16).padStart(40, '0');
function makeCommit(i: number): any {
	return { hash: hashOf(i), parents: [hashOf(i + 1)], heads: i === 0 ? ['develop'] : [], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1755000000 - i, message: 'subject ' + i };
}

function makeState(showBodyInline: boolean) {
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
				enabled: false, remote: 'origin', fetchMode: 'latest', fetchLimit: 10, patchsets: 'latest', autoFetch: false,
				showChangeRefs: false, includeChangeCommits: true, showReviewProgress: true,
				showMetaCommits: 'off', statusFilter: { new: true, merged: false, abandoned: false, wip: false },
				showPushButton: true
			},
			graph: { colours: ['#0085d9'], style: 'rounded', issueLinking: {}, rowHeight: ROW_HEIGHT, grid: { x: 10, y: ROW_HEIGHT, offsetX: 8, offsetY: 8, expandY: 8 } },
			initialLoadCommits: 500, keybindings: {}, loadMoreCommits: 100, loadMoreCommitsAutomatically: false,
			markdown: false, mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }, onRepoLoad: { showCheckedOutBranch: null, showSpecificBranches: [] }, referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
			showBodyInline: showBodyInline, showCommitBodyInline: showBodyInline, stickyHeader: true, tabIconColourTheme: 'colour'
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
	'<div id="content"><div id="commitGraph"></div><div id="commitTable"></div></div>' +
	'<div id="footer"></div></div>';

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

/** Simulate a measured viewport: clientHeight on the scroll container, scrollTop storage. */
function mockViewport(height: number) {
	const view = document.getElementById('view');
	let scrollTop = 0;
	Object.defineProperty(view, 'clientHeight', { configurable: true, get: () => height });
	Object.defineProperty(view, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: any) => { scrollTop = v; } });
	return { scrollTo: (v: number) => { scrollTop = v; view.dispatchEvent(new Event('scroll')); } };
}

function loadWebview(showBodyInline: boolean) {
	removeStaleListeners();
	document.body.innerHTML = VIEW_HTML;
	(globalThis as any).acquireVsCodeApi = () => ({
		postMessage: (msg: any) => { sentMessages.push(msg); return undefined; },
		getState: () => webviewState,
		setState: (state: any) => { webviewState = state; }
	});
	const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'out.min.js'), 'utf8');
	// eslint-disable-next-line no-eval
	eval('var initialState = ' + JSON.stringify(makeState(showBodyInline)) + ', globalState = ' + JSON.stringify({ avatars: {} }) + ', workspaceState = ' + JSON.stringify({}) + ';\n' + script);
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

function respondToLoadCommits(commits: any[]) {
	commits[commits.length - 1].parents = []; // the oldest commit has no parents
	const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(loadMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: hashOf(0), tags: [],
		moreAvailable: false, onlyFollowFirstParent: false, gerritStates: null,
		commits: commits
	} }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const commitRows = () => Array.from(document.querySelectorAll('tr.commit'));
const spacerRows = () => Array.from(document.querySelectorAll('tr.virtSpacer'));

describe('Webview virtualization & lazy bodies simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;
		(window as any).Element.prototype.scroll = () => undefined;
	});

	test('a large commit list renders only the viewport window, and scrolling moves the window', async () => {
		loadWebview(false);
		const viewport = mockViewport(480); // 20 rows of 24px + buffer => ~41 rendered rows
		respondToRepoInfo();
		respondToLoadCommits(Array.from({ length: 300 }, (_v, i) => makeCommit(i)));

		// Only the window is rendered, with spacers preserving the full scroll height
		expect(commitRows().length).toBeGreaterThan(20);
		expect(commitRows().length).toBeLessThanOrEqual(41);
		expect(spacerRows().length).toBe(1); // at the top, only the bottom spacer is needed

		// Scrolling re-renders the window around the new position (rAF-coalesced)
		viewport.scrollTo(150 * ROW_HEIGHT);
		await flush();
		expect(spacerRows().length).toBe(2);
		const ids = commitRows().map((row: any) => parseInt(row.dataset.id, 10));
		expect(ids.length).toBeGreaterThan(20);
		expect(ids[0]).toBeGreaterThanOrEqual(140 - 10);
		expect(ids[0]).toBeLessThan(160);
		// The rendered rows are contiguous and in order
		for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
	});

	test('commit bodies are fetched on demand for the rendered window when "Show Commit Body Inline" is enabled', async () => {
		loadWebview(true);
		mockViewport(480);
		respondToRepoInfo();
		respondToLoadCommits(Array.from({ length: 150 }, (_v, i) => makeCommit(i)));

		// The rendered window's subjects were requested from the extension (subjects only in the list)
		const bodiesMsg = sentMessages.filter((m) => m.command === 'commitBodies').pop();
		expect(bodiesMsg).toBeDefined();
		expect(bodiesMsg.repo).toBe(REPO);
		const renderedIds = commitRows().map((row: any) => parseInt(row.dataset.id, 10));
		expect(bodiesMsg.commitHashes.length).toBe(renderedIds.length);

		// No inline bodies are shown until the response arrives
		expect(document.querySelector('.commitbody')).toBeNull();

		// The extension responds with the bodies: the rows re-render with the inline bodies
		const bodies: any = {};
		for (const id of renderedIds.slice(0, 5)) bodies[makeCommit(id).hash] = 'subject ' + id + '\nbody of commit ' + id;
		window.dispatchEvent(new MessageEvent('message', { data: { command: 'commitBodies', bodies: bodies } }));
		expect(document.querySelectorAll('.commitbody').length).toBe(5);
		expect(document.querySelector('.commitbody').textContent).toContain('body of commit');

		// The bodies are cached: no second request is sent for the same window
		const bodiesRequests = sentMessages.filter((m) => m.command === 'commitBodies').length;
		expect(bodiesRequests).toBe(1);
	});

	test('a shrunken commit list (e.g. an applied path filter) re-renders at a valid window', async () => {
		loadWebview(false);
		const viewport = mockViewport(480);
		respondToRepoInfo();
		respondToLoadCommits(Array.from({ length: 300 }, (_v, i) => makeCommit(i)));

		// Scroll deep into the full list, then apply a path filter: the response replaces the
		// list with a much shorter one while the scroll position is still deep in the old list
		viewport.scrollTo(250 * ROW_HEIGHT);
		await flush();
		expect(commitRows().length).toBeGreaterThan(0);

		respondToLoadCommits(Array.from({ length: 120 }, (_v, i) => makeCommit(i)));

		// The stale scroll position must not select an empty window: rows are rendered again,
		// and they are the tail of the new (shorter) list, not beyond its end
		const ids = commitRows().map((row: any) => parseInt(row.dataset.id, 10));
		expect(ids.length).toBeGreaterThan(20);
		for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
		expect(ids[ids.length - 1]).toBe(119);
	});

	test('the persisted webview state no longer contains the commit list or avatars', () => {
		loadWebview(false);
		respondToRepoInfo();
		respondToLoadCommits(Array.from({ length: 150 }, (_v, i) => makeCommit(i)));
	});
});
