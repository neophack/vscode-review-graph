/**
 * End-to-end webview simulation of the Commit / Branch Pin feature:
 * - the PINNED row renders a chip for each pinned branch and commit,
 * - pinned commits show a 📌 badge in the commit table,
 * - clicking a commit chip jumps to the commit (scroll),
 * - clicking the ✕ of a chip unpins it (a setRepoState message is sent and the UI re-renders).
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
const PINNED_HASH = 'e83bd8dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_HASH = '65698d2cccccccccccccccccccccccccccccccc';

const COMMIT_PINNED = { hash: PINNED_HASH, parents: [], heads: [], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1755000000, message: 'Fix camera crash' };
const COMMIT_OTHER = { hash: OTHER_HASH, parents: [], heads: ['main'], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1754000000, message: 'plain commit' };

function makeState(pinnedCommits: any[] = [], pinnedBranches: string[] = []) {
	return {
		avatar: null,
		config: {
			commitOrdering: 'date',
			commitDetailsView: { autoCenter: true, fileViewCompactFolders: true, fileViewType: 'File Tree', location: 'Inline' },
			contextMenuActionsVisibility: {},
			customBranchGlobPatterns: [], customEmojiShortcodeMappings: [], customPullRequestProviders: [],
			dateFormat: { type: 'relative', short: true, iso: false, string: '' },
			defaultColumnVisibility: { date: true, author: true, commit: true, signature: false },
			dialogDefaults: {}, enhancedAccessibility: false,
			fetchAndPrune: false, fetchAndPruneTags: false, fetchAvatars: false,
			gerrit: {
				enabled: false, remote: 'origin', fetchMode: 'latest', fetchLimit: 10, patchsets: 'latest', autoFetch: false,
				showChangeRefs: false, includeChangeCommits: false, showReviewProgress: false,
				showMetaCommits: 'off', statusFilter: { new: true, merged: false, abandoned: false, wip: false },
				showPushButton: false
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
			pinnedBranches: pinnedBranches, pinnedCommits: pinnedCommits,
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
	'<div id="pinnedControls" style="display:none"><span class="unselectable pinnedRowLabel">Pinned:</span></div>' +
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

function loadWebview(state: any) {
	removeStaleListeners();
	document.body.innerHTML = VIEW_HTML;
	(globalThis as any).acquireVsCodeApi = () => ({
		postMessage: (msg: any) => { sentMessages.push(msg); return undefined; },
		getState: () => webviewState,
		setState: (s: any) => { webviewState = s; }
	});
	const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'out.min.js'), 'utf8');
	// eslint-disable-next-line no-eval
	eval('var initialState = ' + JSON.stringify(state) + ', globalState = ' + JSON.stringify({ avatars: {} }) + ', workspaceState = ' + JSON.stringify({}) + ';\n' + script);
	window.dispatchEvent(new Event('load'));
}

function respondToInitialLoad(commits: any[]) {
	const repoInfoMsg = sentMessages.find((m) => m.command === 'loadRepoInfo');
	expect(repoInfoMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadRepoInfo', refreshId: repoInfoMsg.refreshId, error: null,
		branches: ['main', 'release/2.0'], head: 'main', remotes: ['origin'], stashes: [], isRepo: true
	} }));

	const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(loadMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: 'main', tags: [],
		moreAvailable: false, onlyFollowFirstParent: false, gerritStates: [], commits: commits
	} }));
}

describe('Webview pin simulation', () => {
	let scrollCalls: number[];

	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;
		scrollCalls = [];
		(window as any).Element.prototype.scroll = function () { scrollCalls.push(this.id); return undefined; };
	});

	test('the PINNED row lists pinned branches and commits, and pinned commits carry a 📌 badge', () => {
		loadWebview(makeState([{ hash: PINNED_HASH, summary: 'Fix camera crash' }], ['release/2.0']));
		respondToInitialLoad([COMMIT_PINNED, COMMIT_OTHER]);

		const pinnedControls = document.getElementById('pinnedControls');
		expect(pinnedControls.style.display).toBe('block');

		const chips: any[] = Array.from(pinnedControls.querySelectorAll('.pinnedChip'));
		expect(chips.length).toBe(2);
		expect(chips[0].dataset.type).toBe('branch');
		expect(chips[0].dataset.value).toBe('release/2.0');
		expect(chips[1].dataset.type).toBe('commit');
		expect(chips[1].textContent).toContain(PINNED_HASH.substring(0, 7));
		expect(chips[1].textContent).toContain('Fix camera crash');

		// The pinned commit row shows the badge, the other doesn't
		const badges = Array.from(document.querySelectorAll('tr.commit .pinnedBadge'));
		expect(badges.length).toBe(1);
		const pinnedRow = Array.from(document.querySelectorAll('tr.commit')).find((row: any) => row.dataset.id === '0') as any;
		expect(pinnedRow.querySelector('.pinnedBadge')).not.toBeNull();
	});

	test('the PINNED row stays hidden when nothing is pinned', () => {
		loadWebview(makeState());
		respondToInitialLoad([COMMIT_OTHER]);
		expect(document.getElementById('pinnedControls').style.display).toBe('none');
	});

	test('a pinned commit summary longer than 30 characters is truncated with an ellipsis', () => {
		const longSummary = 'This is a very long commit summary that should be truncated';
		loadWebview(makeState([{ hash: PINNED_HASH, summary: longSummary }]));
		respondToInitialLoad([COMMIT_PINNED, COMMIT_OTHER]);

		const chip = Array.from(document.querySelectorAll('.pinnedChip')).find((c: any) => c.dataset.type === 'commit') as any;
		expect(chip.textContent).toContain(longSummary.substring(0, 30) + '…');
		expect(chip.textContent).not.toContain(longSummary.substring(30));
	});

	test('clicking a pinned commit chip scrolls the view to the commit', () => {
		loadWebview(makeState([{ hash: PINNED_HASH, summary: 'Fix camera crash' }]));
		respondToInitialLoad([COMMIT_OTHER, COMMIT_PINNED]);

		const chip = Array.from(document.querySelectorAll('.pinnedChip')).find((c: any) => c.dataset.type === 'commit') as any;
		chip.click();
		expect(scrollCalls).toContain('view');
	});

	test('clicking the ✕ of a pinned commit chip unpins it and re-renders', () => {
		loadWebview(makeState([{ hash: PINNED_HASH, summary: 'Fix camera crash' }], ['release/2.0']));
		respondToInitialLoad([COMMIT_PINNED, COMMIT_OTHER]);

		const remove = Array.from(document.querySelectorAll('.pinnedChipRemove')).find((c: any) => c.dataset.type === 'commit') as any;
		remove.click();

		// A setRepoState message must be sent, keeping the branch pin but dropping the commit pin
		const stateMsg = sentMessages.filter((m) => m.command === 'setRepoState').pop();
		expect(stateMsg).toBeDefined();
		expect(stateMsg.state.pinnedCommits).toEqual([]);
		expect(stateMsg.state.pinnedBranches).toEqual(['release/2.0']);

		// The commit chip and the 📌 badge are gone; the branch chip remains
		const chips: any[] = Array.from(document.querySelectorAll('.pinnedChip'));
		expect(chips.length).toBe(1);
		expect(chips[0].dataset.type).toBe('branch');
		expect(document.querySelector('tr.commit .pinnedBadge')).toBeNull();
	});

	test('clicking the ✕ of a pinned branch chip unpins it and re-renders', () => {
		loadWebview(makeState([{ hash: PINNED_HASH, summary: 'Fix camera crash' }], ['release/2.0']));
		respondToInitialLoad([COMMIT_PINNED, COMMIT_OTHER]);

		const remove = Array.from(document.querySelectorAll('.pinnedChipRemove')).find((c: any) => c.dataset.type === 'branch') as any;
		remove.click();

		// A setRepoState message must be sent, keeping the commit pin but dropping the branch pin
		const stateMsg = sentMessages.filter((m) => m.command === 'setRepoState').pop();
		expect(stateMsg).toBeDefined();
		expect(stateMsg.state.pinnedBranches).toEqual([]);
		expect(stateMsg.state.pinnedCommits).toEqual([{ hash: PINNED_HASH, summary: 'Fix camera crash' }]);

		// Only the commit chip remains, with its 📌 badge still rendered
		const chips: any[] = Array.from(document.querySelectorAll('.pinnedChip'));
		expect(chips.length).toBe(1);
		expect(chips[0].dataset.type).toBe('commit');
		expect(document.querySelector('tr.commit .pinnedBadge')).not.toBeNull();
	});

	test('clicking a pinned branch chip selects the branch in the Branches dropdown', () => {
		loadWebview(makeState([], ['release/2.0']));
		respondToInitialLoad([COMMIT_OTHER]);

		// The branches dropdown initially has "Show All" selected: loadCommits requests carry branches: null
		const initialLoadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(initialLoadMsg.branches).toBeNull();

		// Clicking the pinned branch chip selects exactly that branch
		const chip = Array.from(document.querySelectorAll('.pinnedChip')).find((c: any) => c.dataset.type === 'branch') as any;
		chip.click();

		const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(loadMsg).toBeDefined();
		expect(loadMsg.branches).toEqual(['release/2.0']);
	});

	test('clicking a pinned commit chip that is not in the view does not scroll', () => {
		// The pinned commit is NOT among the loaded commits (e.g. filtered out / beyond the loaded range)
		loadWebview(makeState([{ hash: 'ffffffffffffffffffffffffffffffffffffffff', summary: 'not loaded' }]));
		respondToInitialLoad([COMMIT_OTHER]);

		const chip = Array.from(document.querySelectorAll('.pinnedChip')).find((c: any) => c.dataset.type === 'commit') as any;
		expect(chip).toBeDefined();
		chip.click();
		expect(scrollCalls).not.toContain('view');
	});

	test('clicking a pinned commit chip beyond the loaded range jumps straight to it via countCommitsBefore', () => {
		const FAR_HASH = '9999aaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
		const COMMIT_FAR = { hash: FAR_HASH, parents: [], heads: [], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1753000000, message: 'far away commit' };
		loadWebview(makeState([{ hash: FAR_HASH, summary: 'far away commit' }]));
		respondToInitialLoad([COMMIT_OTHER]);

		// Re-deliver the initial load with moreCommitsAvailable: true (history extends beyond the loaded range)
		const firstLoadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: firstLoadMsg.refreshId, error: null, head: 'main', tags: [],
			moreCommitsAvailable: true, onlyFollowFirstParent: false, gerritStates: [], commits: [COMMIT_OTHER]
		} }));

		const chip = Array.from(document.querySelectorAll('.pinnedChip')).find((c: any) => c.dataset.type === 'commit') as any;
		chip.click();

		// The webview asks the extension how many commits precede the pinned commit
		const countMsg = sentMessages.filter((m) => m.command === 'countCommitsBefore').pop();
		expect(countMsg).toBeDefined();
		expect(countMsg.hash).toBe(FAR_HASH);

		// The extension answers: the commit is 1200 commits back
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'countCommitsBefore', hash: FAR_HASH, count: 1200
		} }));

		// A single loadCommits request must follow, with maxCommits large enough to include the commit
		const jumpLoadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(jumpLoadMsg).toBeDefined();
		expect(jumpLoadMsg).not.toBe(firstLoadMsg);
		expect(jumpLoadMsg.maxCommits).toBeGreaterThanOrEqual(1300);

		// Once the loaded commits include the pinned one, the view scrolls to it
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: jumpLoadMsg.refreshId, error: null, head: 'main', tags: [],
			moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: [], commits: [COMMIT_OTHER, COMMIT_FAR]
		} }));
		expect(scrollCalls).toContain('view');
	});

	test('clicking a pinned commit chip whose hash is unknown to Git shows an error instead of loading', () => {
		loadWebview(makeState([{ hash: 'ffffffffffffffffffffffffffffffffffffffff', summary: 'not loaded' }]));
		respondToInitialLoad([COMMIT_OTHER]);

		const firstLoadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'loadCommits', refreshId: firstLoadMsg.refreshId, error: null, head: 'main', tags: [],
			moreCommitsAvailable: true, onlyFollowFirstParent: false, gerritStates: [], commits: [COMMIT_OTHER]
		} }));

		const chip = Array.from(document.querySelectorAll('.pinnedChip')).find((c: any) => c.dataset.type === 'commit') as any;
		chip.click();

		// The extension reports the hash is unknown: no further loadCommits request may be made
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'countCommitsBefore', hash: 'ffffffffffffffffffffffffffffffffffffffff', count: null
		} }));
		expect(sentMessages.filter((m) => m.command === 'loadCommits').pop()).toBe(firstLoadMsg);
		expect(scrollCalls).not.toContain('view');
	});

	test('pinned branches and commits are restored when the webview is reloaded', () => {
		loadWebview(makeState([{ hash: PINNED_HASH, summary: 'Fix camera crash' }], ['release/2.0']));
		respondToInitialLoad([COMMIT_PINNED, COMMIT_OTHER]);
		expect(document.getElementById('pinnedControls').style.display).toBe('block');

		// Simulate the webview being reloaded (the panel was hidden and re-shown)
		loadWebview(makeState([{ hash: PINNED_HASH, summary: 'Fix camera crash' }], ['release/2.0']));
		respondToInitialLoad([COMMIT_PINNED, COMMIT_OTHER]);

		// The PINNED row, the chips and the 📌 badge must all be restored
		const pinnedControls = document.getElementById('pinnedControls');
		expect(pinnedControls.style.display).toBe('block');
		const chips: any[] = Array.from(pinnedControls.querySelectorAll('.pinnedChip'));
		expect(chips.length).toBe(2);
		expect(document.querySelector('tr.commit .pinnedBadge')).not.toBeNull();
	});
});
