/**
 * End-to-end webview simulation: Gerrit filter chips must trigger a loadCommits
 * request carrying the updated status filter, and the commit table must re-render
 * when the extension responds (badges appear/disappear).
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

const COMMIT_MERGED = { hash: 'e83bd8dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', parents: [], heads: [], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1755000000, message: 'merged change commit' };
const COMMIT_PLAIN = { hash: '65698d2cccccccccccccccccccccccccccccccc', parents: [], heads: ['develop'], tags: [], remotes: [{ name: 'origin/develop', remote: 'origin' }], stash: null, author: 'Dev', email: 'dev@example.com', date: 1754000000, message: 'plain commit' };

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
let webviewState: any; // simulates the state storage behind VSCODE_API.getState/setState

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

describe('Webview Gerrit chip simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;

		(window as any).Element.prototype.scroll = () => undefined;
		loadWebview();
	});

	test('clicking a chip re-renders the badges locally, and only graph-affecting chips reload', async () => {
		// 1. Extension responds to the initial loadRepoInfo
		const repoInfoMsg = sentMessages.find((m) => m.command === 'loadRepoInfo');
		expect(repoInfoMsg).toBeDefined();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadRepoInfo', refreshId: repoInfoMsg.refreshId, error: null,
			branches: ['develop'], head: 'develop', remotes: ['origin'], stashes: [], isRepo: true
		} }));

		// 2. Extension responds to the initial loadCommits: ALL cached Gerrit states are served (the
		// webview applies the status filter locally); the default filter hides the merged change
		const loadMsg1 = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(loadMsg1).toBeDefined();
		expect(loadMsg1.gerritStatusFilter).toEqual({ new: true, merged: false, abandoned: false, wip: false });
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: loadMsg1.refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false,
			gerritStates: [{
				change: 41456, patchset: 1, codeReview: 2, verified: 1, status: 'merged', wip: false,
				headHash: COMMIT_MERGED.hash,
				events: [{ type: 'merged', patchset: 1, timestamp: 1755000000, raw: 'Change has been successfully merged' }],
				url: null
			}],
			commits: [{ ...COMMIT_MERGED, remotes: [{ name: 'origin/changes/56/41456/1', remote: 'origin' }] }, COMMIT_PLAIN]
		} }));
		expect(document.querySelectorAll('tr.commit').length).toBe(2);
		expect(document.querySelector('.gitRef.gerrit')).toBeNull(); // merged is filtered out locally

		// 3. Click the "Merged" chip: the badge must appear IMMEDIATELY (local re-render, no request)
		const mergedChip: any = Array.from(document.querySelectorAll('.gerritFilterChip')).find((c: any) => c.dataset.status === 'merged');
		expect(mergedChip.classList.contains('active')).toBe(false);
		const messagesBefore = sentMessages.filter((m) => m.command === 'loadCommits').length;
		mergedChip.click();
		expect(mergedChip.classList.contains('active')).toBe(true);
		const badge = document.querySelector('.gitRef.gerrit');
		expect(badge).not.toBeNull();
		expect(badge.textContent).toContain('#41456/1');
		expect(badge.textContent).toContain('CR+2');
		const changeRefChip = document.querySelector('.gitRef.remote[data-name="origin/changes/56/41456/1"]');
		expect(changeRefChip).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 150)); // the debounce must not fire for "merged"
		expect(sentMessages.filter((m) => m.command === 'loadCommits').length).toBe(messagesBefore);

		// 4. Clicking the "Abandoned" chip changes the injected change refs: a loadCommits request
		// must be sent after the debounce, carrying the updated filter
		const abandonedChip: any = Array.from(document.querySelectorAll('.gerritFilterChip')).find((c: any) => c.dataset.status === 'abandoned');
		abandonedChip.click();
		await new Promise((resolve) => setTimeout(resolve, 150));
		const loadMsg2 = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(loadMsg2.gerritStatusFilter).toEqual({ new: true, merged: true, abandoned: true, wip: false });
		expect(loadMsg2.gerritForceRefresh).toBe(false); // served from the Gerrit cache

		// 5. Clicking the meta chip expands in-table meta rows (no request)
		expect(document.querySelector('.gg-meta-chip')).not.toBeNull();
		(document.querySelector('.gg-meta-chip') as any).click();
		expect(document.querySelectorAll('tr.gg-meta-row').length).toBe(1);
		expect(document.querySelector('tr.gg-meta-row').textContent).toContain('merged');
		(document.querySelector('.gg-meta-chip') as any).click();
		expect(document.querySelectorAll('tr.gg-meta-row').length).toBe(0);
	});

	test('the review dialog shows the expandable full NoteDb record of each event', () => {
		// 1. Load commits with a merged change whose events carry the full NoteDb records (rawFull);
		// enable the "Merged" chip first so the badge passes the locally applied status filter
		respondToRepoInfo();
		const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false,
			gerritStates: [{
				change: 41456, patchset: 1, codeReview: 2, verified: 1, status: 'merged', wip: false,
				headHash: COMMIT_MERGED.hash,
				events: [
					{ type: 'merged', patchset: 1, timestamp: 1755000000, raw: 'Change has been successfully merged', rawFull: 'Change has been successfully merged\n\nPatch-set: 1\nCommit: e83bd8db\nStatus: merged\nSubmitted-with: OK\n' },
					{ type: 'created', patchset: 1, timestamp: 1754900000, raw: 'Create change' } // legacy event without rawFull
				],
				url: null
			}],
			commits: [COMMIT_MERGED, COMMIT_PLAIN]
		} }));
		(Array.from(document.querySelectorAll('.gerritFilterChip')).find((c: any) => c.dataset.status === 'merged') as any).click();

		// 2. Clicking the Gerrit badge opens the review dialog with one row per event (newest first)
		(document.querySelector('.gitRef.gerrit') as any).click();
		const events = document.querySelectorAll('.gg-event');
		expect(events.length).toBe(2);
		expect(document.body.textContent).toContain('Gerrit Change #41456');

		// 3. The newest event has a detail block, hidden until its row is clicked
		const mergedEvent: any = events[0];
		expect(mergedEvent.querySelector('.gg-event-detail')).not.toBeNull();
		expect(mergedEvent.classList.contains('expanded')).toBe(false);
		mergedEvent.click();
		expect(mergedEvent.classList.contains('expanded')).toBe(true);
		expect(mergedEvent.querySelector('.gg-event-detail').textContent).toContain('Patch-set: 1');
		expect(mergedEvent.querySelector('.gg-event-detail').textContent).toContain('Status: merged');
		mergedEvent.click();
		expect(mergedEvent.classList.contains('expanded')).toBe(false);

		// 4. Legacy events (persisted before rawFull existed) render no detail block and never expand
		const createdEvent: any = events[1];
		expect(createdEvent.querySelector('.gg-event-detail')).toBeNull();
		createdEvent.click();
		expect(createdEvent.classList.contains('expanded')).toBe(false);
	});

	test('the chip selection is restored when the webview is reloaded (e.g. switching away from the panel and back)', async () => {
		// 1. Initial load (all cached states are served; the merged change is hidden by the filter)
		respondToRepoInfo();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: sentMessages.filter((m) => m.command === 'loadCommits').pop().refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false,
			gerritStates: [{
				change: 41456, patchset: 1, codeReview: 2, verified: 1, status: 'merged', wip: false,
				headHash: COMMIT_MERGED.hash, events: [], url: null
			}],
			commits: [COMMIT_MERGED, COMMIT_PLAIN]
		} }));
		expect(document.querySelector('.gitRef.gerrit')).toBeNull();

		// 2. Click the "Merged" chip: the badge appears instantly (local re-render, no reload)
		const mergedChip: any = Array.from(document.querySelectorAll('.gerritFilterChip')).find((c: any) => c.dataset.status === 'merged');
		mergedChip.click();
		expect(document.querySelector('.gitRef.gerrit')).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 150)); // no debounced request must fire

		// 3. The selection must have been persisted to the webview state
		expect(webviewState.gerritStatusFilter).toEqual({ new: true, merged: true, abandoned: false, wip: false });

		// 4. Simulate the webview being reloaded (the panel was hidden and re-shown)
		loadWebview();

		// 5. The chip must still be selected. The commit list (and with it the Gerrit badges) is
		// NOT restored directly - the lightweight persisted state triggers a reload instead, so the
		// badges return with the first loadCommits response of the reloaded view
		const restoredChip: any = Array.from(document.querySelectorAll('.gerritFilterChip')).find((c: any) => c.dataset.status === 'merged');
		expect(restoredChip.classList.contains('active')).toBe(true);
		expect(document.querySelector('.gitRef.gerrit')).toBeNull();

		// 6. The initial load of the reloaded view must carry the restored filter (served from the Gerrit cache)
		respondToRepoInfo();
		const reloadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(reloadMsg.gerritStatusFilter).toEqual({ new: true, merged: true, abandoned: false, wip: false });
		expect(reloadMsg.gerritForceRefresh).toBe(false);

		// 7. Once the reloaded view receives its commits, the badges are rendered again
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: reloadMsg.refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false,
			gerritStates: [{
				change: 41456, patchset: 1, codeReview: 2, verified: 1, status: 'merged', wip: false,
				headHash: COMMIT_MERGED.hash, events: [], url: null
			}],
			commits: [COMMIT_MERGED, COMMIT_PLAIN]
		} }));
		expect(document.querySelector('.gitRef.gerrit')).not.toBeNull();
	});

	test('meta rows expanded by the toggle appear newest → oldest, matching the review dialog', () => {
		respondToRepoInfo();
		const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false,
			gerritStates: [{
				change: 41456, patchset: 1, codeReview: 2, verified: 0, status: 'new', wip: false,
				headHash: COMMIT_MERGED.hash,
				events: [
					{ type: 'merged', patchset: 1, timestamp: 1755000000, raw: 'Newest event' },
					{ type: 'commented', patchset: 1, timestamp: 1754900000, raw: 'Middle event' },
					{ type: 'created', patchset: 1, timestamp: 1754800000, raw: 'Oldest event' }
				],
				url: null
			}],
			commits: [COMMIT_MERGED, COMMIT_PLAIN]
		} }));

		// Toggle open: the meta rows must appear in the same order as state.events (newest first)
		expect(document.querySelectorAll('tr.gg-meta-row').length).toBe(0);
		(document.querySelector('.gg-meta-chip') as any).click();
		const rows = Array.from(document.querySelectorAll('tr.gg-meta-row')).map((r: any) => r.textContent);
		expect(rows.length).toBe(3);
		expect(rows[0]).toContain('Newest event');
		expect(rows[1]).toContain('Middle event');
		expect(rows[2]).toContain('Oldest event');

		// The review dialog must show the events in the same order
		(document.querySelector('.gitRef.gerrit') as any).click();
		const dialogEvents = Array.from(document.querySelectorAll('.gg-event-text')).map((e: any) => e.textContent);
		expect(dialogEvents.length).toBe(3);
		expect(dialogEvents[0]).toContain('Newest event');
		expect(dialogEvents[1]).toContain('Middle event');
		expect(dialogEvents[2]).toContain('Oldest event');
	});

	test('toggling the meta chip open and closed re-renders without sending a request', () => {
		respondToRepoInfo();
		const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false,
			gerritStates: [{
				change: 41456, patchset: 1, codeReview: 2, verified: 0, status: 'new', wip: false,
				headHash: COMMIT_MERGED.hash,
				events: [{ type: 'created', patchset: 1, timestamp: 1754800000, raw: 'Create change' }],
				url: null
			}],
			commits: [COMMIT_MERGED, COMMIT_PLAIN]
		} }));
		const requestsBefore = sentMessages.length;

		const getChip = (): any => document.querySelector('.gg-meta-chip');
		expect(getChip().classList.contains('expanded')).toBe(false);
		getChip().click();
		// The toggle re-renders the table, so the chip element must be re-queried afterwards
		expect(getChip().classList.contains('expanded')).toBe(true);
		expect(document.querySelectorAll('tr.gg-meta-row').length).toBe(1);
		getChip().click();
		expect(getChip().classList.contains('expanded')).toBe(false);
		expect(document.querySelectorAll('tr.gg-meta-row').length).toBe(0);
		expect(sentMessages.length).toBe(requestsBefore); // purely client-side toggle
	});

	test('clicking Refresh forces a Gerrit re-fetch, while normal loads use the cache', () => {
		// 1. Initial load must not force a Gerrit re-fetch
		respondToRepoInfo();
		const loadMsg1 = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(loadMsg1.gerritForceRefresh).toBe(false);
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: loadMsg1.refreshId, error: null, head: 'develop', tags: [],
			moreAvailable: false, onlyFollowFirstParent: false, gerritStates: [], commits: [COMMIT_PLAIN]
		} }));

		// 2. Clicking the Refresh button must set gerritForceRefresh on the next loadCommits request
		document.getElementById('refreshBtn')!.click();
		respondToRepoInfo();
		const loadMsg2 = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(loadMsg2.gerritForceRefresh).toBe(true);
	});
});
