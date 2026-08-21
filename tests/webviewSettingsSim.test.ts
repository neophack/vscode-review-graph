/**
 * End-to-end webview simulation: the Repository Settings widget must render the
 * "Gerrit Code Review > Change Refs Cache" row, and editing it must open a form
 * that sends a gerritSaveFetchConfig request (cache all changes, or the latest N).
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
			defaultColumnVisibility: { date: true, author: true, commit: false, signature: false },
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
			includeCommitsMentionedByReflogs: null, issueLinkingConfig: null, lastImportAt: 0, name: 'repo',
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
	eval('var initialState = ' + JSON.stringify(makeState()) + ', globalState = ' + JSON.stringify({ avatars: {}, issueLinkingConfig: null }) + ', workspaceState = ' + JSON.stringify({}) + ';\n' + script);
	window.dispatchEvent(new Event('load'));
}

/** Respond to the initial loadRepoInfo and loadCommits requests of the freshly loaded view. */
function respondToInitialLoads() {
	const repoInfoMsg = sentMessages.find((m) => m.command === 'loadRepoInfo');
	expect(repoInfoMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadRepoInfo', refreshId: repoInfoMsg.refreshId, error: null,
		branches: ['develop'], head: 'develop', remotes: ['origin'], stashes: [], isRepo: true
	} }));

	const loadMsg = sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(loadMsg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: loadMsg.refreshId, error: null, head: 'develop', tags: [],
		moreAvailable: false, onlyFollowFirstParent: false,
		gerritStates: [],
		commits: [COMMIT_PLAIN]
	} }));
}

/** Open the Repository Settings widget, and return its HTML. */
function openSettingsWidget() {
	document.getElementById('settingsBtn').click();
	const widget = document.getElementById('settingsWidget');
	expect(widget.classList.contains('active')).toBe(true);
	return widget.innerHTML;
}

describe('Webview Gerrit settings simulation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		sentMessages.length = 0;
		webviewState = undefined;

		(window as any).Element.prototype.scroll = () => undefined;
		loadWebview();
		respondToInitialLoads();
	});

	test('the settings widget renders the Change Refs Cache row with the configured value', () => {
		const html = openSettingsWidget();

		expect(html).toContain('Gerrit Code Review');
		expect(html).toContain('Change Refs Cache:');
		expect(html).toContain('Latest 10 changes (Global)');
		expect(document.getElementById('editGerritFetchConfig')).not.toBeNull();
	});

	test('editing opens a form pre-filled with the configured cache configuration', () => {
		openSettingsWidget();
		document.getElementById('editGerritFetchConfig').click();

		// The form dialog is open, with the configured "Latest changes only" mode and limit of 10
		expect(document.getElementById('dialogAction')).not.toBeNull();
		const currentElem = document.querySelector('#dialogFormSelect0 .customSelectCurrent');
		expect(currentElem.textContent).toContain('Latest changes only');
		expect(document.getElementById('dialogInput1').value).toBe('10');
	});

	test('saving "All open changes" sends a gerritSaveFetchConfig request', () => {
		openSettingsWidget();
		document.getElementById('editGerritFetchConfig').click();

		// Open the Cache Mode select and choose "All open changes"
		document.querySelector('#dialogFormSelect0 .customSelectCurrent').click();
		const option = <any>Array.from(document.querySelectorAll('.customSelectOptions .customSelectOption')).find((o: any) => o.textContent.trim() === 'All open changes');
		expect(option).toBeDefined();
		option.click();

		// Set the number of changes and save
		document.getElementById('dialogInput1').value = '50';
		document.getElementById('dialogAction').click();

		const saveMsg = sentMessages.filter((m) => m.command === 'gerritSaveFetchConfig').pop();
		expect(saveMsg).toEqual({ command: 'gerritSaveFetchConfig', repo: REPO, fetchMode: 'all', fetchLimit: 50 });
	});

	test('saving an invalid number in latest mode shows an error and sends nothing', () => {
		openSettingsWidget();
		document.getElementById('editGerritFetchConfig').click();

		document.getElementById('dialogInput1').value = 'abc';
		document.getElementById('dialogAction').click();

		expect(sentMessages.filter((m) => m.command === 'gerritSaveFetchConfig')).toHaveLength(0);
		expect(document.body.textContent).toContain('Invalid Number of Changes');
	});
});
