/**
 * Deferred "Uncommitted Changes" follow-up simulation tests: the extension answers a loadCommits
 * request immediately WITHOUT the uncommitted row (its `git status` can be slow on large working
 * trees), then sends a follow-up loadCommits response with the SAME refresh id that prepends the
 * synthetic row. The webview must still apply that follow-up after the refresh was finalised,
 * and must keep applying the staged Gerrit responses of the cold-cache pipeline (which also
 * arrive after the first non-pending response finalised the refresh).
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
const UNCOMMITTED = '*';

const hash = (c: string) => c.padEnd(40, '0').substring(0, 40);

function makeCommit(n: number, extraHeads: string[] = []) {
	return {
		hash: hash(n.toString(16)), parents: n > 0 ? [hash((n - 1).toString(16))] : [], heads: extraHeads, tags: [], remotes: [],
		stash: null, author: 'Dev', email: 'dev@example.com', date: 1750000000 + n, message: 'commit ' + n
	};
}

// A linear history of 3 commits (2 = newest/head), listed newest-first as the webview expects
const COMMITS = [makeCommit(2, ['main']), makeCommit(1), makeCommit(0)];
const HEAD_HASH = COMMITS[0].hash;

// The synthetic row the extension prepends in the deferred follow-up (see
// GitGraphView.sendUncommittedChangesFollowUp)
const UNCOMMITTED_ROW = {
	hash: UNCOMMITTED, parents: [HEAD_HASH], heads: [], tags: [], remotes: [], stash: null,
	author: '*', email: '', date: 1750000042, message: 'Uncommitted Changes (3)'
};

function makeState() {
	return {
		avatar: null,
		config: {
			commitOrdering: 'date',
			commitDetailsView: { autoCenter: true, fileTreeCompactFolders: true, fileViewType: 'File Tree', location: 'Inline' },
			contextMenuActionsVisibility: {}, customBranchGlobPatterns: [], customEmojiShortcodeMappings: [], customPullRequestProviders: [],
			dateFormat: { type: 'relative', short: true, iso: false, string: '' },
			defaultColumnVisibility: { date: true, author: true, commit: true, signature: false },
			dialogDefaults: {}, enhancedAccessibility: false,
			fetchAndPrune: false, fetchAndPruneTags: false, fetchAvatars: false,
			gerrit: {
				enabled: false, remote: 'origin', fetchMode: 'latest', fetchLimit: 10, patchsets: 'latest', autoFetch: false,
				showChangeRefs: true, includeChangeCommits: true, showReviewProgress: true,
				showMetaCommits: 'collapsed', statusFilter: { new: true, merged: false, abandoned: false, wip: false },
				showPushButton: true
			},
			graph: { colours: ['#0085d9'], style: 'rounded', issueLinking: {}, grid: { x: 10, y: 24, offsetX: 8, offsetY: 8, expandY: 8 } },
			initialLoadCommits: 6, keybindings: {}, loadMoreCommits: 3, loadMoreCommitsAutomatically: false,
			markdown: false, mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }, onRepoLoad: { showCheckedOutBranch: null, showSpecificBranches: [] }, referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
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
	(window as any).Element.prototype.scroll = () => undefined;
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
		branches: ['main'], head: 'main', remotes: [], stashes: [], isRepo: true
	} }));
}

function lastLoadCommitsRequestId() {
	const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(loadMsg).toBeDefined();
	return loadMsg.refreshId;
}

function respondLoadCommits(refreshId: number, commits: any[], gerritPending: boolean = false, uncommittedPending: boolean = false) {
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: refreshId, error: null, head: HEAD_HASH, tags: [],
		moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritPending: gerritPending,
		uncommittedPending: uncommittedPending, gerritStates: null, commits: commits
	} }));
}

describe('Webview deferred uncommitted-changes follow-up simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;
		loadWebview();
	});

	test('the follow-up response prepending the Uncommitted Changes row is applied (same refresh id)', () => {
		respondToRepoInfo();
		const refreshId = lastLoadCommitsRequestId();

		// Initial (deferred) response: the graph renders immediately, without the uncommitted row
		respondLoadCommits(refreshId, COMMITS);
		expect(document.querySelectorAll('tr.commit').length).toBe(3);
		expect(document.getElementById('uncommittedChanges')).toBeNull();

		// Follow-up response (same refresh id): the uncommitted row must be prepended
		respondLoadCommits(refreshId, [UNCOMMITTED_ROW, ...COMMITS]);
		expect(document.querySelectorAll('tr.commit').length).toBe(4);
		const row = document.getElementById('uncommittedChanges');
		expect(row).not.toBeNull();
		expect(row.dataset.id).toBe('0');
		expect(row.textContent).toContain('Uncommitted Changes (3)');
	});

	test('a follow-up response with an outdated refresh id is ignored', () => {
		respondToRepoInfo();
		const refreshId = lastLoadCommitsRequestId();

		respondLoadCommits(refreshId, COMMITS);
		// A newer load request superseded this one (its id was incremented): the stale follow-up must be dropped
		respondLoadCommits(refreshId + 1, [UNCOMMITTED_ROW, ...COMMITS]);

		expect(document.querySelectorAll('tr.commit').length).toBe(3);
		expect(document.getElementById('uncommittedChanges')).toBeNull();
	});

	test('a deferred refresh keeps the rendered uncommitted row; the follow-up only updates its count', () => {
		respondToRepoInfo();
		const refreshId = lastLoadCommitsRequestId();

		// Initial load: deferred initial response, then the follow-up prepends the row (3 files)
		respondLoadCommits(refreshId, COMMITS, false, true);
		respondLoadCommits(refreshId, [UNCOMMITTED_ROW, ...COMMITS]);
		expect(document.getElementById('uncommittedChanges')).not.toBeNull();
		expect(document.getElementById('uncommittedChanges').textContent).toContain('Uncommitted Changes (3)');

		// Auto-refresh (e.g. the repo file watcher): the deferred initial response (marked
		// uncommittedPending) must NOT remove the rendered row - it stays with its stale count
		// until the follow-up updates it
		window.dispatchEvent(new MessageEvent('message', { data: { command: 'refresh' } }));
		respondToRepoInfo();
		const newRefreshId = lastLoadCommitsRequestId();
		expect(newRefreshId).toBeGreaterThan(refreshId);
		respondLoadCommits(newRefreshId, COMMITS, false, true);
		const row = document.getElementById('uncommittedChanges');
		expect(row).not.toBeNull();
		expect(row.textContent).toContain('Uncommitted Changes (3)');

		// Follow-up with a new count: only the number in the row is updated
		respondLoadCommits(newRefreshId, [{ ...UNCOMMITTED_ROW, message: 'Uncommitted Changes (5)' }, ...COMMITS]);
		const updatedRow = document.getElementById('uncommittedChanges');
		expect(updatedRow).not.toBeNull();
		expect(updatedRow.textContent).toContain('Uncommitted Changes (5)');

		// Next auto-refresh with a clean working tree (count 0): the follow-up drops the row
		window.dispatchEvent(new MessageEvent('message', { data: { command: 'refresh' } }));
		respondToRepoInfo();
		const cleanRefreshId = lastLoadCommitsRequestId();
		respondLoadCommits(cleanRefreshId, COMMITS, false, true);
		respondLoadCommits(cleanRefreshId, COMMITS);
		expect(document.getElementById('uncommittedChanges')).toBeNull();
	});

	test('the staged Gerrit responses after the first non-pending response are still applied', () => {
		respondToRepoInfo();
		const refreshId = lastLoadCommitsRequestId();

		// Cold-cache load: the initial response is marked gerritPending (the refresh stays in progress)
		respondLoadCommits(refreshId, COMMITS, true);
		expect(document.querySelectorAll('tr.commit').length).toBe(3);

		// Stage 1 (meta): non-pending, finalises the refresh
		respondLoadCommits(refreshId, COMMITS);
		expect(document.querySelectorAll('tr.commit').length).toBe(3);

		// Stage 2 (branches): the commit list is updated with the Gerrit change commits
		const changeCommit = { ...makeCommit(3), message: 'Gerrit change 100' };
		respondLoadCommits(refreshId, [changeCommit, ...COMMITS]);
		expect(document.querySelectorAll('tr.commit').length).toBe(4);
		expect(document.querySelector('tr.commit[data-id="0"]').textContent).toContain('Gerrit change 100');
	});
});
