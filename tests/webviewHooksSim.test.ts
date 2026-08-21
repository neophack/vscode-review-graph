/**
 * End-to-end webview simulation: the Gerrit "Hooks" button must load the status of the
 * repository's Git hooks, render it as a dialog (✓ installed / ✗ missing), and offer a
 * click-to-install "Get from Gerrit" flow for the commit-msg hook.
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
		'<span id="gerritFilterControl"></span><div id="gerritAmendBtn"></div><div id="gerritSubmitBtn"></div><div id="gerritClearRefsBtn"></div><div id="gerritHooksBtn"></div></div>' +
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

const respondToHookStatus = (hooks: any[], error: any = null) => {
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'gerritGetHookStatus', error: error, hooks: hooks
	} }));
};

describe('Webview Gerrit hooks simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;

		(window as any).Element.prototype.scroll = () => undefined;
		loadWebview();
		respondToRepoInfo();
	});

	test('the Hooks button is rendered and requests the hook status when clicked', () => {
		const hooksBtn = document.getElementById('gerritHooksBtn');
		expect(hooksBtn).not.toBeNull();
		expect(hooksBtn.textContent).toContain('Hooks');

		sentMessages.length = 0;
		hooksBtn.click();
		expect(sentMessages).toEqual([{ command: 'gerritGetHookStatus', repo: REPO }]);
	});

	test('the Hooks dialog shows the ✓/✗ status of every hook and a "Get from Gerrit" link for a missing installable hook', () => {
		document.getElementById('gerritHooksBtn').click();
		respondToHookStatus([
			{ name: 'pre-commit', installed: true, installable: false },
			{ name: 'commit-msg', installed: false, installable: true },
			{ name: 'post-commit', installed: false, installable: false }
		]);

		const dialogContent = document.querySelector('.dialogContent');
		expect(dialogContent).not.toBeNull();
		expect(dialogContent.textContent).toContain('HOOKS');
		expect(dialogContent.textContent).toContain('pre-commit');
		expect(dialogContent.textContent).toContain('commit-msg');
		expect(dialogContent.textContent).toContain('post-commit');
		// ✓ for the installed pre-commit, ✗ for the two missing hooks
		expect(dialogContent.innerHTML).toContain('✓');
		expect((dialogContent.innerHTML.match(/✗/g) || []).length).toBe(2);
		// Only the missing, Gerrit-served hook (commit-msg) offers installation
		const installLinks = dialogContent.querySelectorAll('.gg-hook-install');
		expect(installLinks.length).toBe(1);
		expect(installLinks[0].dataset.hook).toBe('commit-msg');
	});

	test('installed hooks do not show a "Get from Gerrit" link', () => {
		document.getElementById('gerritHooksBtn').click();
		respondToHookStatus([
			{ name: 'pre-commit', installed: true, installable: false },
			{ name: 'commit-msg', installed: true, installable: true },
			{ name: 'post-commit', installed: true, installable: false }
		]);
		expect(document.querySelector('.dialogContent').querySelectorAll('.gg-hook-install').length).toBe(0);
	});

	test('clicking "Get from Gerrit" asks for confirmation and then sends gerritInstallHook', () => {
		document.getElementById('gerritHooksBtn').click();
		respondToHookStatus([{ name: 'commit-msg', installed: false, installable: true }]);

		document.querySelector('.gg-hook-install').click();
		// A confirmation dialog appears; confirming triggers the install action
		const actionBtn = document.getElementById('dialogAction');
		expect(actionBtn).not.toBeNull();

		sentMessages.length = 0;
		actionBtn.click();
		expect(sentMessages).toEqual([{ command: 'gerritInstallHook', repo: REPO, hook: 'commit-msg' }]);
	});

	test('a successful install response re-loads the hook status', () => {
		document.getElementById('gerritHooksBtn').click();
		respondToHookStatus([{ name: 'commit-msg', installed: false, installable: true }]);
		document.querySelector('.gg-hook-install').click();
		document.getElementById('dialogAction').click();

		sentMessages.length = 0;
		window.dispatchEvent(new MessageEvent('message', { data: {
			command: 'gerritInstallHook', hook: 'commit-msg', error: null, installed: true
		} }));
		// The hook status is re-loaded so the dialog reflects the newly installed hook
		expect(sentMessages.filter((m) => m.command === 'gerritGetHookStatus').pop()).toEqual({ command: 'gerritGetHookStatus', repo: REPO });
	});

	test('an error response is shown as an error dialog', () => {
		document.getElementById('gerritHooksBtn').click();
		respondToHookStatus([], 'Unable to determine the Git directory of the repository.');
		const dialogContent = document.querySelector('.dialogContent');
		expect(dialogContent).not.toBeNull();
		expect(dialogContent.textContent).toContain('Unable to Load Hook Status');
	});
});
