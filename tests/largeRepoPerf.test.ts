/**
 * Large-repository performance guardrails: a heavier sibling of firstOpenPerf.test.ts / loadingPerf.test.ts.
 *
 * Builds a REAL Git repository on disk at a scale beyond the other benchmarks (5,000 commits across
 * a trunk plus 30 feature branches with merges, and 100 tags) using a single `git fast-import`
 * stream, then asserts GUARDRAIL thresholds (not just reports) on the operations a user waits on
 * when browsing such a repository in Git Graph:
 *
 *   1. first screen     - getCommits() loading the initial page (300 commits)          < 5,000 ms
 *   2. load more        - getCommits() loading the next page (300 -> 600 commits)      < 2,000 ms
 *   3. commit details   - getCommitDetails() on the branch head                        < 2,000 ms
 *   4. webview render   - the compiled webview bundle rendering the first screen       < 5,000 ms
 *
 * All repository data is fictional. This suite is heavyweight: run it with
 * `npx jest tests/largeRepoPerf.test.ts --runInBand`.
 */
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/askpass/askpassManager');
jest.mock('../src/logger');

/**
 * @jest-environment jsdom
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { DataSource } from '../src/dataSource';
import { CommitOrdering, GitCommit } from '../src/types';
import { Logger } from '../src/logger';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';

declare const document: any;
declare const window: any;
declare const Event: any;
declare const MessageEvent: any;

/* The whole suite (repository build included) must finish well within this budget. */
jest.setTimeout(180000);

/* ==================== Guardrail thresholds (ms) ==================== */
const FIRST_SCREEN_MAX_MS = 5000;
const LOAD_MORE_MAX_MS = 2000;
const COMMIT_DETAILS_MAX_MS = 2000;
const WEBVIEW_RENDER_MAX_MS = 5000;

/* ==================== Repository scale ==================== */
const TRUNK_COMMITS = 4600;
const BRANCHES = 30;
const TAGS = 100;
const INITIAL_LOAD_COMMITS = 300; // the webview's initialLoadCommits
const LOAD_MORE_COMMITS = 300; // the webview's loadMoreCommits increment
// total: ~4,600 trunk + ~30 * ~5 branch commits + ~20 merges ~= 5,000 commits

const BASE_EPOCH = 1784599200; // 2026-07-21T10:00:00+00:00
const hour = 3600;

const AUTHORS = [
	'Ava Stone <ava.stone@example.com>', 'Liam Cross <liam.cross@example.com>', 'Mia Vance <mia.vance@example.com>',
	'Ethan Blackwood <ethan.blackwood@example.com>', 'Zoe Rivers <zoe.rivers@example.com>', 'Kai Bennett <kai.bennett@example.com>'
];
const MESSAGE_TEMPLATES = [
	'feat: add %s pagination support', 'fix: correct %s timeout handling', 'refactor: simplify %s pipeline internals',
	'chore: bump %s dependency versions', 'docs: expand %s usage guide', 'test: add regression coverage for %s'
];
const MODULES = ['orbit', 'ledger', 'beacon', 'lattice', 'harbor', 'pixel', 'nimbus', 'cobalt', 'ripple', 'forge'];

function mulberry32(seed: number): () => number {
	let s = seed;
	return () => {
		s |= 0; s = (s + 0x6D2B79F5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
	return arr[Math.floor(rng() * arr.length)];
}

/** Run a Git command synchronously (used to BUILD the test repository). */
function git(cwd: string, args: string[]) {
	const result = cp.spawnSync('git', args, { cwd: cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ':\n' + result.stderr);
	}
	return (result.stdout || '').trim();
}

/** Builder of a `git fast-import` stream (same approach as firstOpenPerf.test.ts). */
class FastImport {
	private chunks: string[] = [];
	private mark = 0;

	constructor(private readonly repo: string) { }

	private data(content: string) {
		this.chunks.push('data ' + Buffer.byteLength(content, 'utf8'));
		this.chunks.push(content);
	}

	public commit(ref: string, epoch: number, fromMark?: number) {
		this.mark++;
		const rng = mulberry32(this.mark);
		const author = pick(rng, AUTHORS);
		const message = pick(rng, MESSAGE_TEMPLATES).replace('%s', pick(rng, MODULES)) + '\n';
		this.chunks.push('commit ' + ref, 'mark :' + this.mark);
		const identity = author + ' ' + epoch + ' +0000';
		this.chunks.push('author ' + identity, 'committer ' + identity);
		this.data(message);
		if (fromMark !== undefined) this.chunks.push('from :' + fromMark);
		return this.mark;
	}

	public merge(ref: string, epoch: number, fromMark: number, mergeMark: number) {
		this.mark++;
		const rng = mulberry32(this.mark);
		const author = pick(rng, AUTHORS);
		this.chunks.push('commit ' + ref, 'mark :' + this.mark);
		const identity = author + ' ' + epoch + ' +0000';
		this.chunks.push('author ' + identity, 'committer ' + identity);
		this.data('merge: bring in a feature branch\n');
		this.chunks.push('from :' + fromMark, 'merge :' + mergeMark);
		return this.mark;
	}

	public tag(name: string, mark: number, epoch: number) {
		this.chunks.push('tag ' + name, 'from :' + mark, 'tagger Dev <dev@example.com> ' + epoch + ' +0000');
		this.data('release ' + name + '\n');
	}

	public run() {
		const result = cp.spawnSync('git', ['fast-import', '--quiet'], { cwd: this.repo, input: this.chunks.join('\n') + '\ndone\n', encoding: 'utf8' });
		if (result.status !== 0) {
			throw new Error('git fast-import failed in ' + this.repo + ':\n' + result.stderr);
		}
	}
}

/**
 * Build the large fictional repository ON DISK: a long trunk, 30 feature branches (two thirds
 * merged back with real 2-parent merge commits, the rest left open) and 100 annotated tags.
 */
function buildRepository(repo: string) {
	const rng = mulberry32(0xC0FFEE);
	const epoch = (i: number) => BASE_EPOCH + i * hour;
	const imp = new FastImport(repo);

	let trunkTip = imp.commit('refs/heads/main', epoch(1));
	const trunkMarks = [trunkTip];
	for (let i = 1; i < TRUNK_COMMITS; i++) {
		trunkTip = imp.commit('refs/heads/main', epoch(i + 1), trunkTip);
		trunkMarks.push(trunkTip);
	}

	const perBranch = 4;
	const branchSpan = perBranch * 2 + 5;
	for (let b = 0; b < BRANCHES; b++) {
		const branchName = 'feature/' + pick(rng, MODULES) + '-' + (b + 1);
		let tip = trunkMarks[Math.floor(rng() * trunkMarks.length)];
		const branchEpoch = TRUNK_COMMITS + 100 + b * branchSpan;
		for (let c = 0; c < perBranch; c++) tip = imp.commit('refs/heads/' + branchName, epoch(branchEpoch + c), tip);

		if (rng() < 0.65) {
			trunkTip = imp.merge('refs/heads/main', epoch(branchEpoch + perBranch + 1), trunkTip, tip);
			trunkMarks.push(trunkTip);
		}
	}

	for (let t = 0; t < TAGS; t++) {
		imp.tag('v' + (1 + Math.floor(t / 20)) + '.' + (t % 20) + '.0', trunkMarks[Math.floor(rng() * trunkMarks.length)], epoch(TRUNK_COMMITS + 200 + t));
	}

	imp.run();
	git(repo, ['checkout', '-q', 'main']);
}

/* Measure the wall-clock time (ms) of an async operation. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T, ms: number }> {
	const start = Date.now();
	const value = await fn();
	return { value: value, ms: Date.now() - start };
}

/* Count how many Git processes an async operation spawns. */
async function countSpawns<T>(fn: () => Promise<T>): Promise<{ value: T, ms: number, spawns: number }> {
	const realSpawn = cp.spawn.bind(cp);
	let spawns = 0;
	const spy = jest.spyOn(cp, 'spawn').mockImplementation(((command: string, args: readonly string[], options: any) => {
		spawns++;
		return realSpawn(command, args as any[], options);
	}) as any);
	try {
		const { value, ms } = await timed(fn);
		return { value: value, ms: ms, spawns: spawns };
	} finally {
		spy.mockRestore();
	}
}

function rmRecursive(target: string) {
	if (!fs.existsSync(target)) return;
	for (const entry of fs.readdirSync(target)) {
		const entryPath = path.join(target, entry);
		if (fs.statSync(entryPath).isDirectory()) rmRecursive(entryPath);
		else fs.unlinkSync(entryPath);
	}
	fs.rmdirSync(target);
}

/* ==================== Webview bootstrap (drives media/out.min.js in jsdom) ==================== */

function makeConfig(): any {
	return {
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
			showPushButton: true, showControlsBar: true
		},
		graph: { colours: ['#0085d9'], style: 'rounded', issueLinking: {}, grid: { x: 10, y: 24, offsetX: 8, offsetY: 8, expandY: 8 } },
		initialLoadCommits: INITIAL_LOAD_COMMITS, keybindings: {}, loadMoreCommits: LOAD_MORE_COMMITS, loadMoreCommitsAutomatically: false,
		markdown: false, mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }, onRepoLoad: { showCheckedOutBranch: null, showSpecificBranches: [] },
		referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
		showCommitBodyInline: false, stickyHeader: true, tabIconColourTheme: 'colour'
	};
}

function makeState(repo: string): any {
	return {
		avatar: null, config: makeConfig(), lastActiveRepo: repo, loadViewTo: null,
		repos: {
			[repo]: {
				cdvDivider: 50, cdvHeight: 50, columnWidths: null, commitOrdering: 'default', fileViewType: null, hideRemotes: [],
				includeCommitsMentionedByReflogs: null, issueLinkingConfig: {}, lastImportAt: 0, name: 'repo',
				onlyFollowFirstParent: null, onRepoLoadShowCheckedOutBranch: null, onRepoLoadShowSpecificBranches: null,
				pullRequestConfig: null, showRemoteBranches: false, showRemoteBranchesV2: null, showStashes: null,
				showTags: null, workspaceFolderIndex: null
			}
		},
		loadRepoInfoRefreshId: 1, loadCommitsRefreshId: 1
	};
}

const VIEW_HTML = '<div id="view" tabindex="-1">' +
	'<div id="controls"><span id="repoControl"><div id="repoDropdown" class="dropdown"></div></span>' +
	'<span id="branchControl"><div id="branchDropdown" class="dropdown"></div></span>' +
	'<span id="authorControl"><div id="authorDropdown" class="dropdown"></div></span>' +
	'<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox"></label>' +
	'<div id="currentBtn"></div><div id="findBtn"></div><div id="filterBtn"></div><div id="terminalBtn"></div><div id="settingsBtn"></div><div id="fetchBtn"></div><div id="refreshBtn"></div></div>' +
	'<div id="gerritControls"><span class="gerritRowLabel">Gerrit:</span>' +
	'<span id="gerritFilterControl"></span><div id="gerritAmendBtn"></div><div id="gerritSubmitBtn"></div><div id="gerritClearRefsBtn"></div></div>' +
	'<div id="content"><div id="commitGraph"></div><div id="commitTable"></div></div>' +
	'<div id="footer"></div></div>';

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', 'media', 'out.min.js'), 'utf8');

interface Harness { sentMessages: any[]; }

function loadWebview(repo: string): Harness {
	document.body.innerHTML = VIEW_HTML;
	(window as any).Element.prototype.scroll = () => undefined;
	window.requestAnimationFrame = (cb: any) => { cb(); return 0; };
	window.cancelAnimationFrame = () => undefined;
	const harness: Harness = { sentMessages: [] };
	let webviewState: any;
	(globalThis as any).acquireVsCodeApi = () => ({
		postMessage: (msg: any) => { harness.sentMessages.push(msg); return undefined; },
		getState: () => webviewState,
		setState: (state: any) => { webviewState = state; }
	});
	// eslint-disable-next-line no-eval
	eval('var initialState = ' + JSON.stringify(makeState(repo)) + ', globalState = ' + JSON.stringify({ avatars: {} }) + ', workspaceState = ' + JSON.stringify({}) + ';\n' + BUNDLE);
	window.dispatchEvent(new Event('load'));
	return harness;
}

function respondToRepoInfo(harness: Harness, branchNames: string[], head: string | null, remotes: string[]) {
	const msg = harness.sentMessages.filter((m) => m.command === 'loadRepoInfo').pop();
	expect(msg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadRepoInfo', refreshId: msg.refreshId, error: null,
		branches: branchNames, head: head, remotes: remotes, stashes: [], isRepo: true
	} }));
}

function respondToLoadCommits(harness: Harness, commits: any[], moreAvailable: boolean, head: string | null) {
	const msg = harness.sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(msg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: msg.refreshId, error: null, head: head, tags: [],
		moreCommitsAvailable: moreAvailable, onlyFollowFirstParent: false, gerritStates: null, commits: commits
	} }));
}

/* ==================== The benchmark ==================== */

interface ReportRow { phase: string, ms: number, spawns: number | null }
const report: ReportRow[] = [];
const record = (phase: string, ms: number, spawns: number | null = null) => { report.push({ phase: phase, ms: ms, spawns: spawns }); };

function guardrail(what: string, ms: number, max: number) {
	record('GUARDRAIL ' + what + ' (max ' + max + ' ms)', ms);
	expect(ms).toBeLessThan(max);
}

describe('Large-repository performance guardrails (real Git, ~5,000 commits, fictional data)', () => {
	let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
	let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
	let logger: Logger;
	let repo: string, root: string;

	let firstScreen: { commits: GitCommit[], head: string | null, moreCommitsAvailable: boolean };

	beforeAll(() => {
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
		logger = new Logger();

		root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-large-repo-'));
		repo = path.join(root, 'repo');
		fs.mkdirSync(repo);
		git(repo, ['init', '-q', '-b', 'main']);

		const buildStart = Date.now();
		buildRepository(repo);
		record('0. repository build on disk (~' + (TRUNK_COMMITS + BRANCHES * 5) + ' commits, ' + BRANCHES + ' branches, ' + TAGS + ' tags)', Date.now() - buildStart, null);
	});

	afterAll(() => {
		if (root !== undefined) rmRecursive(root);
		logger.dispose();
		onDidChangeGitExecutable.dispose();
		onDidChangeConfiguration.dispose();

		/* eslint-disable no-console */
		const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
		console.log('\n==================== GIT GRAPH LARGE-REPO BENCHMARK (real Git, fictional repository) ====================');
		for (const entry of report) {
			console.log('  ' + pad(entry.phase, 78) + pad(entry.ms.toFixed(0).padStart(7) + ' ms', 12) + (entry.spawns !== null ? entry.spawns + ' git spawns' : ''));
		}
		console.log('==========================================================================================================\n');
		/* eslint-enable no-console */
	});

	/* 1. First screen: the initial load the webview requests on open */
	it('loads the first screen of commits within the guardrail', async () => {
		const source = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		try {
			const repoInfo = await source.getRepoInfo(repo, true, false, []);
			expect(repoInfo.error).toBeNull();
			expect(repoInfo.branches.length).toBeGreaterThan(BRANCHES);

			const { value, ms, spawns } = await countSpawns(() => source.getCommits(
				repo, null, null, INITIAL_LOAD_COMMITS, true, true, false, false,
				CommitOrdering.Date, repoInfo.remotes, [], repoInfo.stashes, null, false
			));
			record('1. first screen: repo info (branches/remotes/tags/stashes)', 0, null);
			guardrail('1. first screen: getCommits() first ' + INITIAL_LOAD_COMMITS + ' commits', ms, FIRST_SCREEN_MAX_MS);

			expect(value.error).toBeNull();
			expect(value.commits.length).toBe(INITIAL_LOAD_COMMITS);
			expect(value.moreCommitsAvailable).toBe(true);
			firstScreen = { commits: value.commits, head: value.head, moreCommitsAvailable: value.moreCommitsAvailable };
			record('1a. first screen git spawns', 0, spawns);
		} finally {
			source.dispose();
		}
	});

	/* 2. Load more: the next page appended when the user scrolls to the bottom */
	it('loads the next page of commits within the guardrail', async () => {
		const source = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		try {
			const repoInfo = await source.getRepoInfo(repo, true, false, []);
			const { value, ms, spawns } = await countSpawns(() => source.getCommits(
				repo, null, null, INITIAL_LOAD_COMMITS + LOAD_MORE_COMMITS, true, true, false, false,
				CommitOrdering.Date, repoInfo.remotes, [], repoInfo.stashes, null, false
			));
			guardrail('2. load more: getCommits() ' + INITIAL_LOAD_COMMITS + ' -> ' + (INITIAL_LOAD_COMMITS + LOAD_MORE_COMMITS) + ' commits', ms, LOAD_MORE_MAX_MS);

			expect(value.error).toBeNull();
			expect(value.commits.length).toBe(INITIAL_LOAD_COMMITS + LOAD_MORE_COMMITS);
			expect(value.commits.slice(0, INITIAL_LOAD_COMMITS).map((c) => c.hash)).toEqual(firstScreen.commits.map((c) => c.hash)); // strictly appended
			record('2a. load more git spawns', 0, spawns);
		} finally {
			source.dispose();
		}
	});

	/* 3. Commit details: opening the details view of the branch head */
	it('loads the commit details of the branch head within the guardrail', async () => {
		const source = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		try {
			const head = git(repo, ['rev-parse', 'HEAD']);
			const { value, ms, spawns } = await countSpawns(() => source.getCommitDetails(repo, head, true));
			guardrail('3. commit details (show + name-status + numstat)', ms, COMMIT_DETAILS_MAX_MS);

			expect(value.error).toBeNull();
			expect(value.commitDetails!.hash).toBe(head);
			record('3a. commit details git spawns', 0, spawns);
		} finally {
			source.dispose();
		}
	});

	/* 4. Webview: the first render of the first screen's real data */
	it('renders the first screen in the webview within the guardrail', async () => {
		const harness = loadWebview(repo);
		const branches = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n');
		respondToRepoInfo(harness, branches, firstScreen.head, []);
		const render = { ms: Date.now() };
		respondToLoadCommits(harness, firstScreen.commits, firstScreen.moreCommitsAvailable, firstScreen.head);
		const ms = Date.now() - render.ms;

		guardrail('4. webview first render (' + firstScreen.commits.length + ' commits)', ms, WEBVIEW_RENDER_MAX_MS);
		expect(document.querySelectorAll('tr.commit').length).toBe(firstScreen.commits.length);
	});
});
