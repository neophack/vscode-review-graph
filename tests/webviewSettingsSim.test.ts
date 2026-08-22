/**
 * End-to-end webview simulation of the Settings widget: it must render the
 * "Repository Settings" and "Global Settings" columns, the "Gerrit Code Review >
 * Change Refs Cache" row (editing it opens a form that sends a gerritSaveFetchConfig
 * request), and the Global Settings controls (which send setGlobalSetting requests).
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
			dateFormat: { type: 2, iso: false }, // DateFormatType.Relative
			dateType: 0,
			defaultColumnVisibility: { date: true, author: true, commit: false, signature: false },
			dialogDefaults: {}, enhancedAccessibility: false,
			fetchAndPrune: false, fetchAndPruneTags: false, fetchAvatars: false,
			gerrit: {
				enabled: true, remote: 'origin', fetchMode: 'latest', fetchLimit: 10, patchsets: 'latest', autoFetch: false,
				showChangeRefs: true, includeChangeCommits: true, showReviewProgress: true,
				showMetaCommits: 'collapsed', statusFilter: { new: true, merged: false, abandoned: false, wip: false },
				showPushButton: true, showControlsBar: true
			},
			graph: { colours: ['#0085d9'], style: 0, fontSize: 13, rowHeight: 24, issueLinking: {}, grid: { x: 10, y: 24, offsetX: 8, offsetY: 8, expandY: 8 } },
			initialLoadCommits: 500, interfaceLanguage: 'en', keybindings: {}, loadMoreCommits: 100, loadMoreCommitsAutomatically: true,
			markdown: false, mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }, onRepoLoad: { showCheckedOutBranch: null, showSpecificBranches: [] },
			pullRequests: { enabled: false },
			referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
			showCommitBodyInline: false, showRemoteBranches: true, showRemoteHeads: true,
			showUncommittedChanges: true, showUntrackedFiles: true,
			stickyHeader: true, tabIconColourTheme: 'colour', trackRemoteTags: false
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

/** Open the Settings widget, and return its HTML. */
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

	test('the settings widget renders separate Repository and Global Settings columns', () => {
		const html = openSettingsWidget();

		expect(html).toContain('Repository Settings');
		expect(html).toContain('Global Settings');

		const repoColumn = document.getElementById('settingsRepoColumn');
		const globalColumn = document.getElementById('settingsGlobalColumn');
		expect(repoColumn).not.toBeNull();
		expect(globalColumn).not.toBeNull();

		// Repository-scoped settings belong to the left column, Global Settings to the right one
		expect(repoColumn.textContent).toContain('General');
		expect(repoColumn.textContent).toContain('Issue Linking');
		expect(repoColumn.querySelector('#settingsShowStashesCheckbox')).not.toBeNull();
		expect(globalColumn.querySelector('#settingsShowStashesCheckbox')).toBeNull();

		expect(globalColumn.textContent).toContain('Graph & Display');
		expect(globalColumn.textContent).toContain('Commit Loading');
		expect(globalColumn.textContent).toContain('Remotes & Fetching');
		expect(globalColumn.textContent).toContain('Review Integration');
		expect(globalColumn.querySelector('#settingsGraphStyle')).not.toBeNull();
		expect(repoColumn.querySelector('#settingsGraphStyle')).toBeNull();
	});

	test('the Global Settings controls are pre-filled with the configured values', () => {
		openSettingsWidget();

		expect((<any>document.getElementById('settingsGraphStyle')).value).toBe('rounded');
		expect((<any>document.getElementById('settingsGraphRowHeight')).value).toBe('24');
		expect((<any>document.getElementById('settingsDateFormat')).value).toBe('Relative');
		expect((<any>document.getElementById('settingsInitialLoad')).value).toBe('500');
		expect((<any>document.getElementById('settingsCommitOrder')).value).toBe('date');
		expect((<any>document.getElementById('settingsStickyHeaderCheckbox')).checked).toBe(true);
		expect((<any>document.getElementById('settingsPullRequestsEnabledCheckbox')).checked).toBe(false);
	});

	test('toggling a Global Settings checkbox sends a setGlobalSetting request', () => {
		openSettingsWidget();

		const checkbox = <any>document.getElementById('settingsPullRequestsEnabledCheckbox');
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change'));

		expect(sentMessages.filter((m) => m.command === 'setGlobalSetting').pop()).toEqual({
			command: 'setGlobalSetting', setting: 'pullRequests.enabled', value: true
		});
	});

	test('changing a Global Settings dropdown sends a setGlobalSetting request', () => {
		openSettingsWidget();

		const select = <any>document.getElementById('settingsGraphStyle');
		select.value = 'angular';
		select.dispatchEvent(new Event('change'));

		expect(sentMessages.filter((m) => m.command === 'setGlobalSetting').pop()).toEqual({
			command: 'setGlobalSetting', setting: 'graph.style', value: 'angular'
		});
	});

	test('a Global Settings number outside the allowed range is rejected and restored', () => {
		openSettingsWidget();

		const input = <any>document.getElementById('settingsGraphRowHeight');
		input.value = '999';
		input.dispatchEvent(new Event('change'));

		expect(sentMessages.filter((m) => m.command === 'setGlobalSetting')).toHaveLength(0);
		expect(input.value).toBe('24');

		input.value = '32';
		input.dispatchEvent(new Event('change'));

		expect(sentMessages.filter((m) => m.command === 'setGlobalSetting').pop()).toEqual({
			command: 'setGlobalSetting', setting: 'graph.rowHeight', value: 32
		});
	});

	test('toggling a Gerrit change status saves the whole status filter', () => {
		openSettingsWidget();

		const checkbox = <any>document.getElementById('settingsGerritStatusMergedCheckbox');
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change'));

		expect(sentMessages.filter((m) => m.command === 'setGlobalSetting').pop()).toEqual({
			command: 'setGlobalSetting', setting: 'gerrit.statusFilter',
			value: { new: true, merged: true, abandoned: false, wip: false }
		});
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
