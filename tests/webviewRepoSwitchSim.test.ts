/**
 * End-to-end webview simulation: session-only UI state (the "Select for Compare" source
 * commit, and the file path filter) must not leak from one repository into another when
 * the user switches repositories via the repo dropdown.
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

const REPO1 = '/path/to/repo1';
const REPO2 = '/path/to/repo2';

const REPO1_COMMIT_A = { hash: 'e83bd8dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', parents: [], heads: ['master'], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1755000000, message: 'repo1 commit A' };
const REPO1_COMMIT_B = { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', parents: [], heads: [], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1754500000, message: 'repo1 commit B' };
const REPO2_COMMIT = { hash: '65698d2cccccccccccccccccccccccccccccccc', parents: [], heads: ['master'], tags: [], remotes: [], stash: null, author: 'Dev', email: 'dev@example.com', date: 1754000000, message: 'repo2 commit' };

function makeRepoState(name: string) {
	return {
		cdvDivider: 50, cdvHeight: 50, columnWidths: null, commitOrdering: 'default', fileViewType: null, hideRemotes: [],
		includeCommitsMentionedByReflogs: null, issueLinkingConfig: {}, lastImportAt: 0, name,
		onlyFollowFirstParent: null, onRepoLoadShowCheckedOutBranch: null, onRepoLoadShowSpecificBranches: null,
		pullRequestConfig: null, showRemoteBranches: false, showRemoteBranchesV2: null, showStashes: null,
		showTags: null, workspaceFolderIndex: null
	};
}

function makeState() {
	return {
		avatar: null,
		config: {
			commitOrdering: 'date',
			commitDetailsView: { autoCenter: true, fileTreeCompactFolders: true, fileViewType: 'File Tree', location: 'Inline' },
			contextMenuActionsVisibility: {
				branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
				commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, undo: true, editMessage: true, copyHash: true, copySubject: true },
				commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true },
				remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
				stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
				tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
				uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true }
			},
			customBranchGlobPatterns: [], customEmojiShortcodeMappings: [], customPullRequestProviders: [],
			dateFormat: { type: 'relative', short: true, iso: false, string: '' },
			defaultColumnVisibility: { date: true, author: true, commit: true, signature: false },
			dialogDefaults: {}, enhancedAccessibility: false,
			fetchAndPrune: false, fetchAndPruneTags: false, fetchAvatars: false,
			gerrit: {
				enabled: false, remote: 'origin', fetchMode: 'latest', fetchLimit: 10, patchsets: 'latest', autoFetch: false,
				showChangeRefs: false, includeChangeCommits: true, showReviewProgress: true,
				showMetaCommits: 'collapsed', statusFilter: { new: true, merged: false, abandoned: false, wip: false },
				showPushButton: true, showControlsBar: true
			},
			graph: { colours: ['#0085d9'], style: 'rounded', issueLinking: {}, grid: { x: 10, y: 24, offsetX: 8, offsetY: 8, expandY: 8 } },
			initialLoadCommits: 500, keybindings: {}, loadMoreCommits: 100, loadMoreCommitsAutomatically: true,
			markdown: false, mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }, onRepoLoad: { showCheckedOutBranch: null, showSpecificBranches: [] }, referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
			showCommitBodyInline: false, stickyHeader: true, tabIconColourTheme: 'colour'
		},
		lastActiveRepo: REPO1,
		loadViewTo: null,
		repos: { [REPO1]: makeRepoState('repo1'), [REPO2]: makeRepoState('repo2') },
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
	'<div id="filterBtn"></div>' +
	'<div id="currentBtn"></div><div id="findBtn"></div><div id="terminalBtn"></div><div id="settingsBtn"></div><div id="fetchBtn"></div><div id="refreshBtn"></div></div>' +
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

function loadWebview(stateOverrides: any = {}) {
	removeStaleListeners();
	document.body.innerHTML = VIEW_HTML;
	(globalThis as any).acquireVsCodeApi = () => ({
		postMessage: (msg: any) => { sentMessages.push(msg); return undefined; },
		getState: () => webviewState,
		setState: (state: any) => { webviewState = state; }
	});
	const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'out.min.js'), 'utf8');
	const initialState = Object.assign(makeState(), stateOverrides);
	// eslint-disable-next-line no-eval
	eval('var initialState = ' + JSON.stringify(initialState) + ', globalState = ' + JSON.stringify({ avatars: {} }) + ', workspaceState = ' + JSON.stringify({}) + ';\n' + script);
	window.dispatchEvent(new Event('load'));
}

function respondToRepoInfo() {
	const repoInfoMsg = sentMessages.filter((m) => m.command === 'loadRepoInfo').pop();
	expect(repoInfoMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadRepoInfo', refreshId: repoInfoMsg.refreshId, error: null,
		branches: ['master'], head: 'master', remotes: ['origin'], stashes: [], isRepo: true
	} }));
}

function respondToCommits(commits: any[]) {
	const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(loadMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: 'master', tags: [],
		moreAvailable: false, onlyFollowFirstParent: false, gerritStates: [], commits: commits
	} }));
}

/** Right-clicks the commit row at the given index, and returns the titles of the visible context menu items. */
function openCommitContextMenu(rowIndex: number) {
	const commitRow = document.querySelectorAll('tr.commit:not(#uncommittedChanges)')[rowIndex];
	expect(commitRow).not.toBeUndefined();
	const event = new (window as any).MouseEvent('contextmenu', { bubbles: true, cancelable: true });
	commitRow.dispatchEvent(event);
	return Array.from(document.querySelectorAll('.contextMenuItem')).map((el: any) => el.textContent);
}

describe('Webview repository switch simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;

		(window as any).Element.prototype.scroll = () => undefined;
		loadWebview();
	});

	test('the "Select for Compare" source commit is restored when the webview is reloaded', () => {
		// 1. Load repo1 with two commits
		respondToRepoInfo();
		respondToCommits([REPO1_COMMIT_A, REPO1_COMMIT_B]);

		// 2. Select commit A "for Compare" via its context menu
		openCommitContextMenu(0);
		(Array.from(document.querySelectorAll('.contextMenuItem')).find((el: any) => el.textContent === 'Select for Compare') as any).click();

		// The selection must be persisted to the webview state
		expect(webviewState.compareSourceHash).toBe(REPO1_COMMIT_A.hash);

		// 3. Simulate the webview being reloaded (the panel was hidden and re-shown)
		loadWebview();
		respondToRepoInfo();
		respondToCommits([REPO1_COMMIT_A, REPO1_COMMIT_B]);

		// Assert: the selection must be restored, so commit B's context menu offers to compare with A
		const menuItems = openCommitContextMenu(1);
		expect(menuItems.some((t: any) => t.indexOf('Compare with Selected Commit') !== -1)).toBe(true);
	});

	test('the "Select for Compare" source commit and file path filter are cleared when switching repositories via the repo dropdown', () => {
		// 1. Load repo1 with two commits
		respondToRepoInfo();
		respondToCommits([REPO1_COMMIT_A, REPO1_COMMIT_B]);

		// 2. Select commit A "for Compare" via its context menu
		let menuItems = openCommitContextMenu(0);
		expect(menuItems).toContain('Select for Compare');
		(Array.from(document.querySelectorAll('.contextMenuItem')).find((el: any) => el.textContent === 'Select for Compare') as any).click();

		// Sanity check: opening the context menu on the other repo1 commit (B) must now offer to compare with A
		menuItems = openCommitContextMenu(1);
		expect(menuItems.some((t: any) => t.indexOf('Compare with Selected Commit') !== -1)).toBe(true);
		document.body.click(); // close the context menu

		// 3. Apply a file path filter in repo1
		document.getElementById('filterBtn')!.click();
		document.getElementById('dialogInput0').value = 'src/repo1-only.ts';
		document.getElementById('dialogAction')!.click();
		expect(document.getElementById('filterBtn')!.classList.contains('active')).toBe(true);

		// 4. Switch to repo2 via the repo dropdown (bypasses the loadRepos() reset logic, going straight to loadRepo())
		sentMessages.length = 0;
		document.querySelector('#repoDropdown .dropdownCurrentValue')!.click();
		const repo2Option: any = Array.from(document.querySelectorAll('#repoDropdown .dropdownOption')).find((el: any) => el.title === 'repo2');
		expect(repo2Option).toBeDefined();
		repo2Option.click();

		// 5. Load repo2 with a single (different) commit
		respondToRepoInfo();
		respondToCommits([REPO2_COMMIT]);

		// Assert: the file path filter must not have carried over to repo2
		expect(document.getElementById('filterBtn')!.classList.contains('active')).toBe(false);

		// Assert: the "Select for Compare" source commit must not have carried over to repo2 either
		// (if it had, "Compare with Selected Commit" would be offered here, comparing against a repo1 hash)
		menuItems = openCommitContextMenu(0);
		expect(menuItems.some((t: any) => t.indexOf('Compare with Selected Commit') !== -1)).toBe(false);
	});

	test('the file path filter from "Show File History" (loadViewTo) is applied on the first open of the view', () => {
		// Re-load the webview as if it was freshly created by review-graph.filterByFile
		loadWebview({ loadViewTo: { repo: REPO1, filterPath: 'src/foo.ts' } });

		// Respond to the repo info request; this triggers the loadCommits request
		respondToRepoInfo();

		// Assert: the commits request must already carry the filter path
		const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
		expect(loadMsg).toBeDefined();
		expect(loadMsg.filterPath).toBe('src/foo.ts');

		// Assert: the filter button must be shown as active
		expect(document.getElementById('filterBtn')!.classList.contains('active')).toBe(true);

		respondToCommits([REPO1_COMMIT_A]);
	});
});
