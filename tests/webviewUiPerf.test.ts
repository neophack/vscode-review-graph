/**
 * UI rendering performance benchmark: drives the ACTUAL compiled webview bundle
 * (media/out.min.js) inside jsdom against several synthetic project scales, and
 * measures the wall-clock cost of every phase of the interface a user waits on:
 * branch/author dropdown construction, the initial commit table + graph render,
 * "Load More" paging, the Find widget's search-and-highlight pass, and expanding
 * the Commit Details View (including building a large file tree).
 *
 * All repository data (authors, emails, branch/tag names, commit messages, file
 * paths) is entirely FICTIONAL and generated in-memory by a seeded PRNG - nothing
 * is read from, or derived from the content of, any real repository. The "Large"
 * tier is shaped after a large, actively-developed project - thousands of commits
 * and 100+ concurrent feature branches, merges and tags - matching the ORDER OF
 * MAGNITUDE of a large real-world monorepo, not any specific one.
 *
 * Each tier runs as a self-contained test against its own webview instance (own
 * repo path, own DOM), so results are not skewed by state left over from a
 * smaller/earlier tier.
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

jest.setTimeout(300000);

/* ==================== Fictional data generation ==================== */

const BASE_EPOCH = 1784599200; // 2026-07-21T10:00:00+00:00
const MINUTE = 60;

const FIRST_NAMES = ['Ava', 'Liam', 'Noah', 'Mia', 'Ethan', 'Zoe', 'Kai', 'Priya', 'Diego', 'Freya', 'Omar', 'Nina', 'Leo', 'Grace', 'Marcus', 'Ines', 'Tomas', 'Sana', 'Felix', 'Ruth', 'Anders', 'Yuki', 'Malik', 'Elena', 'Victor'];
const LAST_NAMES = ['Stone', 'Cross', 'Vance', 'Blackwood', 'Rivers', 'Bennett', 'Sutton', 'Nandan', 'Salas', 'Lindqvist', 'Haddad', 'Kowalski', 'Tanaka', 'Oduya', 'Webb', 'Farrow', 'Delgado', 'Okafor', 'Lindberg', 'Marsh'];
const MODULE_POOL = ['orbit', 'ledger', 'beacon', 'lattice', 'harbor', 'pixel', 'nimbus', 'cobalt', 'ripple', 'forge', 'atlas', 'quartz', 'vector', 'meadow', 'signal'];
const MESSAGE_TEMPLATES = [
	'feat: add {mod} pagination support', 'fix: correct {mod} timeout handling', 'refactor: simplify {mod} pipeline internals',
	'chore: bump {mod} dependency versions', 'docs: expand {mod} usage guide', 'test: add regression coverage for {mod}',
	'perf: reduce {mod} allocation overhead', 'style: tidy {mod} formatting'
];
const FILE_SUBDIRS = ['handlers', 'models', 'utils', 'views', 'tests', 'config'];
const FILE_EXTENSIONS = ['ts', 'tsx', 'css', 'md', 'json'];

interface Author { name: string; email: string; }
interface RawFileChange { oldFilePath: string; newFilePath: string; type: 'A' | 'M' | 'D' | 'R' | 'U'; additions: number | null; deletions: number | null; }

/** Deterministic PRNG (mulberry32), so every run generates the identical fictional project. */
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

function authorPool(count: number): Author[] {
	const authors: Author[] = [];
	for (let i = 0; i < count; i++) {
		const first = FIRST_NAMES[i % FIRST_NAMES.length];
		const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
		authors.push({ name: first + ' ' + last, email: (first + '.' + last).toLowerCase() + '@example.com' });
	}
	return authors;
}

function generateFileChanges(count: number, rng: () => number): RawFileChange[] {
	const statuses: RawFileChange['type'][] = ['A', 'M', 'D', 'R', 'U'];
	const changes: RawFileChange[] = [];
	for (let i = 0; i < count; i++) {
		const mod = pick(rng, MODULE_POOL), sub = pick(rng, FILE_SUBDIRS), ext = pick(rng, FILE_EXTENSIONS);
		const status = pick(rng, statuses);
		const newPath = 'src/' + mod + '/' + sub + '/file' + i + '.' + ext;
		const oldPath = status === 'R' ? 'src/' + mod + '/' + sub + '/legacy' + i + '.' + ext : newPath;
		changes.push({
			oldFilePath: oldPath, newFilePath: newPath, type: status,
			additions: status === 'D' ? null : Math.floor(rng() * 200),
			deletions: status === 'A' ? null : Math.floor(rng() * 100)
		});
	}
	return changes;
}

interface ProjectTier { name: string; repo: string; commits: number; branches: number; tags: number; authors: number; detailsFiles: number; }

interface BuiltProject { commits: any[]; branchNames: string[]; authorNames: string[]; headHash: string; }

/**
 * Build a fictional commit DAG: a trunk ("main") with many feature branches forking off it, most
 * merged back (creating merge commits), some left open - the same shape a real active repository
 * has. Commits are generated oldest-first (so parents can reference already-created hashes), then
 * reversed into the newest-first order the webview expects.
 */
function buildProject(tier: ProjectTier): BuiltProject {
	const rng = mulberry32(0xC0FFEE ^ tier.commits ^ (tier.branches << 16));
	const authors = authorPool(tier.authors);
	let hashCounter = 0;
	const nextHash = () => (++hashCounter).toString(16).padStart(40, '0');
	let epoch = BASE_EPOCH;
	const nextEpoch = () => (epoch += MINUTE);

	const created: any[] = [];
	const headsByHash: { [hash: string]: string[] } = {};
	const tagsByHash: { [hash: string]: { name: string, annotated: boolean }[] } = {};

	const makeCommit = (parents: string[]): string => {
		const hash = nextHash();
		const a = pick(rng, authors);
		const tmpl = pick(rng, MESSAGE_TEMPLATES);
		created.push({
			hash: hash, parents: parents, author: a.name, email: a.email, date: nextEpoch(),
			message: tmpl.replace('{mod}', pick(rng, MODULE_POOL)), heads: [], tags: [], remotes: [], stash: null
		});
		return hash;
	};

	const trunkCount = Math.max(2, Math.round(tier.commits * 0.45));
	let trunkTip = makeCommit([]);
	const trunkHashes = [trunkTip];
	for (let i = 1; i < trunkCount; i++) {
		trunkTip = makeCommit([trunkTip]);
		trunkHashes.push(trunkTip);
	}

	const branchNames: string[] = [];
	const remainingBudget = Math.max(tier.branches, tier.commits - trunkCount);
	const perBranch = Math.max(1, Math.round(remainingBudget / tier.branches));

	for (let b = 0; b < tier.branches; b++) {
		const branchName = 'feature/' + pick(rng, MODULE_POOL) + '-' + (b + 1);
		branchNames.push(branchName);
		let tip = trunkHashes[Math.floor(rng() * trunkHashes.length)];
		const branchCommitCount = 1 + Math.floor(rng() * perBranch * 2);
		for (let c = 0; c < branchCommitCount; c++) tip = makeCommit([tip]);

		if (rng() < 0.65) {
			trunkTip = makeCommit([trunkTip, tip]); // merged back into the trunk
			trunkHashes.push(trunkTip);
		} else {
			headsByHash[tip] = (headsByHash[tip] || []).concat(branchName); // left open
		}
	}
	headsByHash[trunkTip] = (headsByHash[trunkTip] || []).concat('main');
	branchNames.push('main');

	for (let t = 0; t < tier.tags; t++) {
		const h = trunkHashes[Math.floor(rng() * trunkHashes.length)];
		const name = 'v' + (1 + Math.floor(t / 20)) + '.' + (t % 20) + '.0';
		tagsByHash[h] = (tagsByHash[h] || []).concat({ name: name, annotated: t % 3 === 0 });
	}

	for (const c of created) {
		c.heads = headsByHash[c.hash] || [];
		c.tags = tagsByHash[c.hash] || [];
	}
	created.reverse(); // newest-first, as the webview expects

	return { commits: created, branchNames: branchNames, authorNames: authors.map((a) => a.name), headHash: trunkTip };
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
		initialLoadCommits: 300, keybindings: {}, loadMoreCommits: 300, loadMoreCommitsAutomatically: false,
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

/** Measure the wall-clock time (ms) of a synchronous operation. */
function timed<T>(fn: () => T): { value: T, ms: number } {
	const start = Date.now();
	const value = fn();
	return { value: value, ms: Date.now() - start };
}

interface Harness { sentMessages: any[]; }

// jsdom shares one window across the loadWebview() calls of this test: record every listener
// the bundle registers on the persistent nodes (window / document / body) and remove them at
// the start of each loadWebview() call, so the bundle instances of earlier tiers no longer
// respond to dispatched messages or events (in production, resetting the webview HTML tears the
// old page down).
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

function loadWebview(repo: string): Harness {
	removeStaleListeners();
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

function respondToRepoInfo(harness: Harness, branchNames: string[]) {
	const msg = harness.sentMessages.filter((m) => m.command === 'loadRepoInfo').pop();
	expect(msg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadRepoInfo', refreshId: msg.refreshId, error: null,
		branches: branchNames, head: 'main', remotes: ['origin'], stashes: [], isRepo: true
	} }));
}

function respondToLoadCommits(harness: Harness, commits: any[], moreAvailable: boolean, head: string) {
	const msg = harness.sentMessages.filter((m) => m.command === 'loadCommits').pop();
	expect(msg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'loadCommits', refreshId: msg.refreshId, error: null, head: head, tags: [],
		moreCommitsAvailable: moreAvailable, onlyFollowFirstParent: false, gerritStates: null, commits: commits
	} }));
}

function respondToCommitDetails(harness: Harness, hash: string, fileChanges: RawFileChange[]) {
	const msg = harness.sentMessages.filter((m) => m.command === 'commitDetails').pop();
	expect(msg).toBeDefined();
	window.dispatchEvent(new MessageEvent('message', { data: {
		command: 'commitDetails', refreshId: msg.refreshId, error: null, refresh: false, avatar: null, codeReview: null,
		commitDetails: {
			hash: hash, parents: [], author: 'Ava Stone', authorEmail: 'ava.stone@example.com', authorDate: BASE_EPOCH,
			committer: 'Ava Stone', committerEmail: 'ava.stone@example.com', committerDate: BASE_EPOCH,
			signature: null, body: 'A fictional commit body used only for benchmarking.', fileChanges: fileChanges
		}
	} }));
}

function clickLoadMore() {
	const btn = document.getElementById('loadMoreCommitsBtn');
	expect(btn).not.toBeNull();
	btn.click();
}

/* ==================== The benchmark ==================== */

// Note on scale: this benchmark is what surfaced a real bug (fixed in web/observers.ts,
// makeTableResizable) where every full render attached an individual DOM listener to every
// .resizeCol handle - one pair per commit row, not just the header - instead of a single
// delegated listener. At ~2,600 commits / 110 branches that took ~6 MINUTES to render a single
// page; after the fix, the same scale renders in ~4 SECONDS (see the PR description for the full
// before/after breakdown). With that fixed, the "Large" tier below can approach the order of
// magnitude of a large real-world monorepo (thousands of commits, 100+ branches) while staying
// fast enough for routine CI runs.
const TIERS: ProjectTier[] = [
	{ name: 'Small (light project)', repo: '/fictional/small-project', commits: 200, branches: 12, tags: 15, authors: 8, detailsFiles: 60 },
	{ name: 'Medium (active team project)', repo: '/fictional/medium-project', commits: 1200, branches: 50, tags: 80, authors: 25, detailsFiles: 250 },
	{ name: 'Large (approaches a big real-world monorepo)', repo: '/fictional/large-project', commits: 4000, branches: 110, tags: 200, authors: 45, detailsFiles: 600 }
];

interface ReportRow { tier: string; phase: string; ms: number; detail: string; }
const report: ReportRow[] = [];
const record = (tier: string, phase: string, ms: number, detail: string = '') => { report.push({ tier: tier, phase: phase, ms: ms, detail: detail }); };

afterAll(() => {
	/* eslint-disable no-console */
	const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
	console.log('\n==================== GIT GRAPH UI RENDERING BENCHMARK (fictional data) ====================');
	let lastTier = '';
	for (const row of report) {
		if (row.tier !== lastTier) { console.log('  ' + row.tier + ':'); lastTier = row.tier; }
		console.log('    ' + pad(row.phase, 58) + pad(row.ms.toFixed(0).padStart(7) + ' ms', 12) + row.detail);
	}
	console.log('=============================================================================================\n');
	/* eslint-enable no-console */
});

for (const tier of TIERS) {
	describe('UI rendering performance - ' + tier.name, () => {
		test('renders the full interface pipeline against a synthetic fictional project of this scale', () => {
			const built = timed(() => buildProject(tier));
			const project = built.value;
			record(tier.name, '0. synthetic project generation (' + project.commits.length + ' commits, ' + tier.branches + ' branches, ' + tier.tags + ' tags)', built.ms);

			const harness = loadWebview(tier.repo);

			// 1. Repo info arrives: builds the branch + author dropdown option lists
			const repoInfo = timed(() => respondToRepoInfo(harness, project.branchNames));
			record(tier.name, '1. repo info -> branch/author dropdown build (' + project.branchNames.length + ' branches)', repoInfo.ms);

			// 2. Initial page: the first 70% (newest-first) of history renders (table + graph)
			const initialCount = Math.max(1, Math.round(project.commits.length * 0.7));
			const initialPage = project.commits.slice(0, initialCount);
			const initialRender = timed(() => respondToLoadCommits(harness, initialPage, true, project.headHash));
			record(tier.name, '2. initial commit table + graph render (' + initialPage.length + ' commits)', initialRender.ms);
			expect(document.querySelectorAll('tr.commit').length).toBe(initialPage.length);

			// 3. Load More: the remaining history is appended (existing rows must be kept, not rebuilt)
			const existingFirstRow = document.querySelector('tr.commit[data-id="0"]');
			clickLoadMore();
			const append = timed(() => respondToLoadCommits(harness, project.commits, true, project.headHash));
			const appendedCount = project.commits.length - initialPage.length;
			record(tier.name, '3. "Load More" append (+' + appendedCount + ' commits)', append.ms);
			expect(document.querySelectorAll('tr.commit').length).toBe(project.commits.length);
			expect(existingFirstRow.isConnected).toBe(true); // the append path kept the existing DOM rows

			// 4. Find widget: search + highlight across the full loaded history
			document.getElementById('findBtn').click();
			const findInput = document.getElementById('findInput');
			findInput.value = 'feat:';
			jest.useFakeTimers();
			findInput.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'f' }));
			const find = timed(() => jest.runOnlyPendingTimers());
			jest.useRealTimers();
			record(tier.name, '4. Find widget search + highlight (\'feat:\' across ' + project.commits.length + ' commits)', find.ms);
			expect(document.getElementById('findPosition').textContent).not.toBe('No Results');

			// 5. Commit Details View: expand a commit with a large file tree
			const row = document.querySelector('tr.commit[data-id="' + (initialCount - 1) + '"]');
			row.querySelector('td:nth-child(2)').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
			const fileChanges = generateFileChanges(tier.detailsFiles, mulberry32(tier.detailsFiles));
			const details = timed(() => respondToCommitDetails(harness, initialPage[initialCount - 1].hash, fileChanges));
			record(tier.name, '5. Commit Details View expand + file tree build (' + tier.detailsFiles + ' files)', details.ms);
			expect(document.getElementById('cdv')).not.toBeNull();
			expect(document.querySelectorAll('#cdv .fileTreeFile').length).toBe(tier.detailsFiles);

			// Report the per-commit cost of each path (informational: with the full-render DOM
			// listener bug fixed, both paths are now genuinely fast, so their per-commit costs are
			// close enough that a strict inequality here would just be noise). The real regression
			// guard for the append optimisation is the isConnected check above: it fails if a future
			// change makes "Load More" fall back to rebuilding the whole table instead of appending.
			const perCommitInitial = initialRender.ms / initialPage.length;
			const perCommitAppend = append.ms / appendedCount;
			record(tier.name, '   => per-commit cost: initial render vs append', 0,
				'(' + perCommitInitial.toFixed(2) + ' ms/commit vs ' + perCommitAppend.toFixed(2) + ' ms/commit)');
		});
	});
}
