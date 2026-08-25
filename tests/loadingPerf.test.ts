/**
 * Loading performance benchmark: builds a COMPLEX Git repository (long history, many branches &
 * tags, 80 Gerrit changes with NoteDb meta refs) and measures the time of every phase of the
 * Git Graph View load pipeline (ls-remote -> targeted fetch -> prune -> NoteDb meta parsing ->
 * commit graph loading).
 *
 * The repository is built with `git fast-import` (a single process per import stream), so hundreds
 * of commits are created in seconds. A bare repository acts as the "Gerrit server": change refs
 * (refs/changes/<shard>/<n>/<ps>) and NoteDb meta refs (refs/changes/<shard>/<n>/meta) are created
 * in it exactly as Gerrit would, using only local transports (no network access is required).
 *
 * Simulated scale (a typical mid-sized Gerrit project):
 *  - 150 commits on develop + 8 feature branches x 4 commits + 20 tags
 *  - 80 Gerrit changes: 20 stale (pruned by the "latest 60" cache mode), 20 open, 10 WIP,
 *    5 merged by fast-forward, 10 merged by cherry-pick (dangling patchsets) and 15 abandoned
 *  - each change has 1-3 patchsets and a NoteDb meta ref with 2-4 review events
 *
 * Reported metrics per phase: wall-clock time and the number of spawned Git processes (the
 * dominant cost of the pipeline on Windows, where each spawn costs ~50-150ms).
 */
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/askpass/askpassManager');
jest.mock('../src/logger');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { DataSource } from '../src/dataSource';
import { buildFetchRefspecs, filterChangeStates, limitChanges } from '../src/gerrit';
import { CommitOrdering, GerritChangeState, GerritStatusFilter } from '../src/types';
import { Logger } from '../src/logger';
import * as utils from '../src/utils';
import { UNCOMMITTED } from '../src/utils';
import { EventEmitter } from '../src/utils/event';

jest.setTimeout(600000);

const BASE_EPOCH = 1784599200; // 2026-07-21T10:00:00+00:00 - all commit timestamps derive from this
const hour = 3600, minute = 60;

/* Repository scale */
const BASE_COMMITS = 150;
const BRANCHES = 8, BRANCH_COMMITS = 4;
const STALE_CHANGES = 20; // changes 1000-1019: cached locally, pruned by the "latest 60" cache mode
const OPEN_CHANGES = 20; // changes 1020-1039
const WIP_CHANGES = 10; // changes 1040-1049
const FF_MERGED = 5; // changes 1050-1054 (patchset commit IS on develop)
const CP_MERGED = 10; // changes 1055-1064 (patchset commit dangles, develop holds a copy)
const ABANDONED_CHANGES = 15; // changes 1065-1079
const ALL_CHANGES = STALE_CHANGES + OPEN_CHANGES + WIP_CHANGES + FF_MERGED + CP_MERGED + ABANDONED_CHANGES; // 80
const FIRST_CHANGE = 1000;
const FETCH_LIMIT = ALL_CHANGES - STALE_CHANGES; // 60: the "gerrit.fetchMode": "latest" pipeline limit
const REMOTE = 'origin';

/** Recursively remove a directory (compatible with the Node typings bundled with the project). */
function rmRecursive(target: string) {
	if (!fs.existsSync(target)) return;
	for (const entry of fs.readdirSync(target)) {
		const entryPath = path.join(target, entry);
		if (fs.statSync(entryPath).isDirectory()) rmRecursive(entryPath);
		else fs.unlinkSync(entryPath);
	}
	fs.rmdirSync(target);
}

/**
 * Run a Git command synchronously (used to BUILD the test repository; the code under test
 * always runs through DataSource/GerritDataSource).
 */
function git(cwd: string, args: string[]) {
	const result = cp.spawnSync('git', args, { cwd: cwd, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ':\n' + result.stderr);
	}
	return (result.stdout || '').trim();
}

/** Measure the wall-clock time (ms) of an async operation. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T, ms: number }> {
	const start = Date.now();
	const value = await fn();
	return { value: value, ms: Date.now() - start };
}

/**
 * Count how many Git processes an async operation spawns.
 */
async function countSpawns<T>(fn: () => Promise<T>): Promise<{ value: T, ms: number, spawns: number, commands: string[][] }> {
	const realSpawn = cp.spawn.bind(cp);
	let spawns = 0;
	const commands: string[][] = [];
	const spy = jest.spyOn(cp, 'spawn').mockImplementation(((command: string, args: readonly string[], options: any) => {
		spawns++;
		commands.push([...args]);
		return realSpawn(command, args as any[], options);
	}) as any);
	try {
		const { value, ms } = await timed(fn);
		return { value: value, ms: ms, spawns: spawns, commands: commands };
	} finally {
		spy.mockRestore();
	}
}

/**
 * Builder of a `git fast-import` stream: creates commits, refs and tags in a single Git process.
 */
class FastImport {
	private chunks: string[] = [];
	private mark = 0;
	private static streamId = 0;

	constructor(private readonly repo: string) {}

	private data(content: string) {
		this.chunks.push('data ' + Buffer.byteLength(content, 'utf8'));
		this.chunks.push(content);
	}

	/** Create a commit on a ref (optionally on top of a previous mark of this stream). */
	public commit(ref: string, message: string, epoch: number, who: string, fromMark?: number) {
		this.mark++;
		this.chunks.push('commit ' + ref, 'mark :' + this.mark);
		const identity = who + ' <' + who.replace(/[^A-Za-z0-9]/g, '') + '@gerrit.local> ' + epoch + ' +0000';
		this.chunks.push('author ' + identity, 'committer ' + identity);
		this.data(message);
		if (fromMark !== undefined) this.chunks.push('from :' + fromMark);
		return this.mark;
	}

	/** Point a ref at an existing mark without creating a commit. */
	public reset(ref: string, mark: number) {
		this.chunks.push('reset ' + ref, 'from :' + mark);
	}

	/** Create an annotated tag. */
	public tag(name: string, mark: number, epoch: number) {
		this.chunks.push('tag ' + name, 'from :' + mark, 'tagger Dev <dev@gerrit.local> ' + epoch + ' +0000');
		this.data('release ' + name + '\n');
	}

	/** Run the stream, returning the mark -> commit hash map. */
	public run(): Map<number, string> {
		const marksFile = path.join(this.repo, 'marks-' + (++FastImport.streamId) + '-' + Math.random().toString(36).slice(2, 8) + '.txt');
		const result = cp.spawnSync('git', ['fast-import', '--quiet', '--done', '--export-marks=' + marksFile], {
			cwd: this.repo, input: this.chunks.join('\n') + '\ndone\n', encoding: 'utf8'
		});
		const marks = new Map<number, string>();
		if (fs.existsSync(marksFile)) {
			for (const line of fs.readFileSync(marksFile, 'utf8').split(/\r?\n/)) {
				const match = /^:(\d+) ([0-9a-f]{40})$/.exec(line.trim());
				if (match !== null) marks.set(parseInt(match[1], 10), match[2]);
			}
			fs.unlinkSync(marksFile);
		}
		if (result.status !== 0 || marks.size === 0) {
			throw new Error('git fast-import failed in ' + this.repo + ':\n' + result.stderr);
		}
		return marks;
	}
}

/** NoteDb meta event message (same format as Gerrit writes). */
const metaMessage = (event: string, patchset: number, hash: string, extra: string[] = []) =>
	[event].concat(extra).concat(['Patch-set: ' + patchset, 'Commit: ' + hash]).join('\n') + '\n';

const changeShard = (change: number) => ('0' + (change % 100)).slice(-2);

interface ChangeSpec {
	change: number;
	patchsets: number;
	status: 'new' | 'merged' | 'abandoned';
	wip: boolean;
	/** the change ref of every patchset points at a develop commit (fast-forward submit) */
	fastForward: boolean;
}

const changeSpecs = (): ChangeSpec[] => {
	const specs: ChangeSpec[] = [];
	let change = FIRST_CHANGE;
	const add = (patchsets: number, status: ChangeSpec['status'], wip = false, fastForward = false) =>
		specs.push({ change: change, patchsets: patchsets, status: status, wip: wip, fastForward: fastForward });
	for (let i = 0; i < STALE_CHANGES; i++) { add(change % 3 + 1, 'new'); change++; }
	for (let i = 0; i < OPEN_CHANGES; i++) { add(change % 3 + 1, 'new'); change++; }
	for (let i = 0; i < WIP_CHANGES; i++) { add(change % 3 + 1, 'new', true); change++; }
	for (let i = 0; i < FF_MERGED; i++) { add(1, 'merged', false, true); change++; }
	for (let i = 0; i < CP_MERGED; i++) { add(1, 'merged'); change++; }
	for (let i = 0; i < ABANDONED_CHANGES; i++) { add(1, 'abandoned'); change++; }
	return specs;
};

describe('Loading performance (complex Git repository, real Git)', () => {
	let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
	let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
	let logger: Logger;
	let dataSource: DataSource; // the instance used by the optimized pipeline
	let baselineSource: DataSource; // an independent cold instance for the sequential baseline
	let work: string, remote: string, root: string;

	/* benchmark results, reported in afterAll */
	const report: { phase: string, ms: number, spawns: number | null }[] = [];
	const record = (phase: string, ms: number, spawns: number | null = null) => {
		report.push({ phase: phase, ms: ms, spawns: spawns });
	};

	/* shared state between the sequential test steps */
	let remoteChanges: Map<number, number[]>;
	let keptChanges: Map<number, number[]>;
	let baselineStates: GerritChangeState[] = [];
	let baselineMs = 0, optimizedMs = 0;
	let developTip: string;
	let openPatchsetHash: string;
	const metaTips: string[] = [];

	beforeAll(() => {
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
		logger = new Logger();
		dataSource = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		baselineSource = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);

		root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-perf-'));
		remote = path.join(root, 'remote.git');
		work = path.join(root, 'work');
		fs.mkdirSync(remote);
		git(remote, ['init', '--bare', '-b', 'develop']);

		const specs = changeSpecs();
		const epoch = (i: number) => BASE_EPOCH + i * hour;
		const buildStart = Date.now();

		/* import stream 1: develop history, feature branches, tags and the patchset commits */
		const imp = new FastImport(remote);
		let mark = 0;
		for (let i = 1; i <= BASE_COMMITS; i++) mark = imp.commit('refs/heads/develop', 'base: commit ' + i + '\n', epoch(i), 'Dev', i > 1 ? mark : undefined);
		for (let b = 0; b < BRANCHES; b++) {
			let branchMark = imp.commit('refs/heads/feature-' + b, 'feature ' + b + ': commit 1\n', epoch(BASE_COMMITS + b * BRANCH_COMMITS), 'Dev' + b, 10 + b * 15);
			for (let c = 2; c <= BRANCH_COMMITS; c++) branchMark = imp.commit('refs/heads/feature-' + b, 'feature ' + b + ': commit ' + c + '\n', epoch(BASE_COMMITS + b * BRANCH_COMMITS + c), 'Dev' + b, branchMark);
		}
		for (let t = 0; t < 10; t++) imp.tag('v0.' + (t + 1), 10 + t * 10, epoch(10 + t * 10));
		for (let t = 0; t < 10; t++) imp.reset('refs/tags/base-' + t, 20 + t * 10);

		const patchsetMarks = new Map<string, number>(); // '<change>/<patchset>' -> mark
		for (const spec of specs) {
			const ref = (ps: number) => 'refs/changes/' + changeShard(spec.change) + '/' + spec.change + '/' + ps;
			const baseMark = 30 + (spec.change - FIRST_CHANGE) % BASE_COMMITS;
			if (spec.fastForward) {
				imp.reset(ref(1), baseMark); // the patchset commit IS a develop commit
				continue;
			}
			const changeId = 'I' + String(spec.change).padEnd(40, '0');
			let parent: number | undefined = undefined;
			for (let ps = 1; ps <= spec.patchsets; ps++) {
				const m = imp.commit(ref(ps), 'feat: change ' + spec.change + ' patchset ' + ps + '\n\nChange-Id: ' + changeId + '\n', epoch(BASE_COMMITS + 100 + spec.change + ps), 'Dev', parent === undefined ? baseMark : parent);
				patchsetMarks.set(spec.change + '/' + ps, m);
				parent = m;
			}
		}
		const marks = imp.run();
		developTip = marks.get(mark)!;
		const firstOpen = specs[STALE_CHANGES]; // change 1020: the first open change of the kept window
		openPatchsetHash = marks.get(patchsetMarks.get(firstOpen.change + '/' + firstOpen.patchsets)!)!;

		/* import stream 2: the NoteDb meta refs (their events reference the real patchset hashes) */
		const meta = new FastImport(remote);
		const metaTipMarks: number[] = [];
		for (const spec of specs) {
			const ref = 'refs/changes/' + changeShard(spec.change) + '/' + spec.change + '/meta';
			const headMark = patchsetMarks.get(spec.change + '/' + spec.patchsets);
			const headHash = headMark !== undefined
				? marks.get(headMark)!
				: git(remote, ['rev-parse', 'refs/changes/' + changeShard(spec.change) + '/' + spec.change + '/1']); // fast-forward merged
			const t = (m: number) => epoch(BASE_COMMITS + 200 + spec.change) + m * minute;
			let m = meta.commit(ref, metaMessage('Create change', 1, headHash, ['Status: new']), t(1), 'Dev');
			if (spec.patchsets > 1) {
				m = meta.commit(ref, metaMessage('Uploaded patch set ' + spec.patchsets + '.', spec.patchsets, headHash, ['Status: new']), t(2), 'Dev', m);
			}
			m = meta.commit(ref, metaMessage('Patch Set ' + spec.patchsets + ': Code-Review+2', spec.patchsets, headHash, ['Label: Code-Review=+2', 'Status: ' + spec.status]), t(3), 'Gerrit User 1000013', m);
			if (spec.wip) {
				m = meta.commit(ref, metaMessage('Start Work In Progress', spec.patchsets, headHash, ['Work-in-progress: true', 'Status: new']), t(4), 'Dev', m);
			} else if (spec.status === 'merged') {
				m = meta.commit(ref, metaMessage('Change has been successfully merged by Alice', spec.patchsets, headHash, ['Status: merged']), t(4), 'Gerrit User 1000018', m);
			} else if (spec.status === 'abandoned') {
				m = meta.commit(ref, metaMessage('Abandoned', spec.patchsets, headHash, ['Status: abandoned']), t(4), 'Dev', m);
			}
			metaTipMarks.push(m);
		}
		const metaMarks = meta.run();
		for (const m of metaTipMarks) metaTips.push(metaMarks.get(m)!);

		/* clone the repository, then fetch ALL change refs (a previous "all changes" cache run) */
		git(root, ['clone', '-q', '--no-checkout', remote, work]);
		git(work, ['fetch', '-q', REMOTE, '+refs/changes/*:refs/remotes/' + REMOTE + '/changes/*']);

		record('0. repository build (fast-import: ' + (BASE_COMMITS + BRANCHES * BRANCH_COMMITS) + ' commits + ' + ALL_CHANGES + ' changes)', Date.now() - buildStart, null);
	});

	afterAll(() => {
		if (root !== undefined) rmRecursive(root);
		dataSource.dispose();
		baselineSource.dispose();
		logger.dispose();
		onDidChangeGitExecutable.dispose();
		onDidChangeConfiguration.dispose();

		/* the benchmark report (the console output IS the deliverable of this test suite) */
		/* eslint-disable no-console */
		const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
		console.log('\n==================== GIT GRAPH LOADING BENCHMARK ====================');
		for (const entry of report) {
			console.log('  ' + pad(entry.phase, 66) + pad(entry.ms.toFixed(0).padStart(7) + ' ms', 12) + (entry.spawns !== null ? entry.spawns + ' git spawns' : ''));
		}
		if (baselineMs > 0 && optimizedMs > 0) {
			console.log('  ' + pad('=> NoteDb meta parsing speed-up (sequential -> concurrent)', 66) + (baselineMs / optimizedMs).toFixed(1) + 'x');
		}
		console.log('=====================================================================\n');
		/* eslint-enable no-console */
	});

	/* 1. Discovery: list the open change refs on the remote */
	it('discovers all changes via ls-remote', async () => {
		const { value: changes, ms, spawns } = await countSpawns(() => dataSource.gerrit.listRemoteChanges(work, REMOTE));
		record('1. ls-remote (discover ' + changes.size + ' changes)', ms, spawns);
		remoteChanges = changes;
		expect(changes.size).toBe(ALL_CHANGES);
	});

	/* 2-3. The targeted fetch + prune of the "latest N changes" cache mode */
	it('fetches the latest patchsets and prunes the stale change refs', async () => {
		keptChanges = limitChanges(remoteChanges, FETCH_LIMIT);
		expect(keptChanges.size).toBe(FETCH_LIMIT);

		const fetch = await countSpawns(() => dataSource.gerrit.fetchChanges(work, REMOTE, buildFetchRefspecs(keptChanges, REMOTE, 'latest')));
		record('2. fetch (latest patchsets + metas of ' + keptChanges.size + ' changes)', fetch.ms, fetch.spawns);
		expect(fetch.value).toBeNull();

		const prune = await countSpawns(() => dataSource.gerrit.pruneLocalChanges(work, REMOTE, Array.from(keptChanges.keys())));
		record('3. prune (delete the refs of ' + STALE_CHANGES + ' stale changes)', prune.ms, prune.spawns);

		// only the refs of the kept changes remain (their earlier patchsets stay cached locally)
		const localRefs = (await dataSource.gerrit.listLocalChangeRefs(work, REMOTE)).sort();
		const expected: string[] = [];
		for (const [change, patchsets] of keptChanges) {
			expected.push('refs/remotes/' + REMOTE + '/changes/' + changeShard(change) + '/' + change + '/meta');
			for (const ps of patchsets) expected.push('refs/remotes/' + REMOTE + '/changes/' + changeShard(change) + '/' + change + '/' + ps);
		}
		expect(localRefs).toEqual(expected.sort());
	});

	/* 4. Baseline: the ORIGINAL sequential NoteDb meta parsing (2 Git processes per change) */
	it('parses the change metas sequentially (baseline)', async () => {
		const { value, ms, spawns } = await countSpawns(async () => {
			const states: GerritChangeState[] = [];
			for (const change of keptChanges.keys()) {
				const state = await baselineSource.gerrit.parseMeta(work, REMOTE, change, null);
				if (state !== null) states.push(state);
			}
			return states;
		});
		baselineMs = ms;
		record('4a. parse ' + keptChanges.size + ' NoteDb metas SEQUENTIALLY (baseline)', ms, spawns);
		baselineStates = value;
		expect(value.length).toBe(FETCH_LIMIT);
	});

	/* 5. Optimized: concurrent NoteDb meta parsing with batched ref-hash resolution */
	it('parses the change metas concurrently and identically to the baseline', async () => {
		const { value: statesByChange, ms, spawns } = await countSpawns(() => dataSource.gerrit.parseMetas(work, REMOTE, Array.from(keptChanges.keys()), null));
		optimizedMs = ms;
		record('4b. parse ' + keptChanges.size + ' NoteDb metas CONCURRENTLY (optimized)', ms, spawns);

		const states = Array.from(statesByChange.values()).filter((state) => state !== null) as GerritChangeState[];
		expect(states.length).toBe(FETCH_LIMIT);
		// identical results (same states, in the same order) as the sequential baseline
		expect(states).toEqual(baselineStates);

		const counts = { new: 0, merged: 0, abandoned: 0, wip: 0 };
		for (const state of states) {
			if (state.status === 'new') counts.new++;
			if (state.status === 'merged') counts.merged++;
			if (state.status === 'abandoned') counts.abandoned++;
			if (state.wip) counts.wip++;
		}
		expect(counts).toEqual({ new: OPEN_CHANGES + WIP_CHANGES, merged: FF_MERGED + CP_MERGED, abandoned: ABANDONED_CHANGES, wip: WIP_CHANGES });

		// the concurrent parsing must be faster than the sequential baseline
		expect(ms).toBeLessThan(baselineMs * 0.8);
	});

	/* 6. Warm cache: re-parsing must be served without any Git log process */
	it('serves warm re-parses from the meta cache', async () => {
		const { value, ms, spawns } = await countSpawns(() => dataSource.gerrit.parseMetas(work, REMOTE, Array.from(keptChanges.keys()), null));
		record('5. re-parse from the meta cache (warm)', ms, spawns);
		expect((Array.from(value.values()).filter((state) => state !== null)).length).toBe(FETCH_LIMIT);
		expect(spawns).toBeLessThanOrEqual(2); // only the batched ref-hash resolution may run
		expect(ms).toBeLessThan(optimizedMs * 0.75);
	});

	/* 7. End-to-end: the complete view load (Gerrit pipeline + commit graph) */
	it('loads the commit graph with the Gerrit change refs (end-to-end)', async () => {
		const { value: data, ms, spawns } = await countSpawns(async () => {
			// the Gerrit pipeline of GitGraphView.loadGerritData (warm cache: what a view re-load costs)
			const changes = limitChanges(await dataSource.gerrit.listRemoteChanges(work, REMOTE), FETCH_LIMIT);
			const urlBase = await dataSource.gerrit.getChangeUrlBase(work, REMOTE);
			const statesByChange = await dataSource.gerrit.parseMetas(work, REMOTE, Array.from(changes.keys()), urlBase);
			const states = (Array.from(statesByChange.values()).filter((state) => state !== null)) as GerritChangeState[];
			// the refs GitGraphView.loadGerritData injects into the commit log (open + WIP changes)
			const filter: GerritStatusFilter = { new: true, merged: false, abandoned: false, wip: true };
			const refs: string[] = [];
			for (const state of filterChangeStates(states, filter)) {
				if (state.status === 'merged') continue;
				const patchsets = changes.get(state.change)!;
				refs.push('refs/remotes/' + REMOTE + '/changes/' + changeShard(state.change) + '/' + state.change + '/' + patchsets[patchsets.length - 1]);
			}
			return dataSource.getCommits(work, null, null, 1000, true, true, false, false, CommitOrdering.Date, [REMOTE], [], [], refs, false);
		});
		record('6. end-to-end view load (Gerrit pipeline + commit graph, warm)', ms, spawns);

		expect(data.error).toBeNull();
		expect(data.moreCommitsAvailable).toBe(false);
		expect(data.commits.length).toBeGreaterThan(BASE_COMMITS + BRANCHES * BRANCH_COMMITS);
		const hashes = data.commits.map((commit) => commit.hash);
		expect(hashes).toContain(developTip); // the branch head is loaded
		expect(hashes).toContain(openPatchsetHash); // the patchset commit of an open change is loaded
		expect(hashes).not.toContain(metaTips[0]); // NoteDb meta commits never leak into the graph
		expect(data.commits.some((commit) => commit.message.startsWith('feat: change ' + FIRST_CHANGE + ' '))).toBe(false); // pruned stale change
	});

	/* 8. Two-phase view load: the branch graph renders BEFORE the Gerrit data arrives */
	it('renders the branch graph before the Gerrit data (two-phase view load)', async () => {
		// Phase 1 (what the user sees first): repository info + the commit graph WITHOUT Gerrit refs
		const firstPaint = await countSpawns(async () => {
			const repoInfo = await dataSource.getRepoInfo(work, true, false, []);
			expect(repoInfo.error).toBeNull();
			return dataSource.getCommits(work, null, null, 1000, true, true, false, false, CommitOrdering.Date, [REMOTE], [], [], null, false);
		});
		record('7. FIRST PAINT (repo info + commit graph, no Gerrit refs)', firstPaint.ms, firstPaint.spawns);
		expect(firstPaint.value.error).toBeNull();
		expect(firstPaint.value.commits.length).toBeGreaterThan(0);

		// Phase 2 (asynchronous, in the background): the COLD Gerrit pipeline (a fresh DataSource
		// with an empty meta cache, as on the first opening of a repository)
		const coldSource = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		const gerrit = await countSpawns(async () => {
			const changes = limitChanges(await coldSource.gerrit.listRemoteChanges(work, REMOTE), FETCH_LIMIT);
			expect(await coldSource.gerrit.fetchChanges(work, REMOTE, buildFetchRefspecs(changes, REMOTE, 'latest'))).toBeNull();
			await coldSource.gerrit.pruneLocalChanges(work, REMOTE, Array.from(changes.keys()));
			const statesByChange = await coldSource.gerrit.parseMetas(work, REMOTE, Array.from(changes.keys()), null);
			return { changes: changes, states: (Array.from(statesByChange.values()).filter((state) => state !== null)) as GerritChangeState[] };
		});
		coldSource.dispose();
		record('8. Gerrit pipeline (background, cold meta cache)', gerrit.ms, gerrit.spawns);
		expect(gerrit.value.states.length).toBe(FETCH_LIMIT);

		// Phase 3 (when the Gerrit data arrives): the commit graph re-loaded WITH the Gerrit refs
		const filter: GerritStatusFilter = { new: true, merged: false, abandoned: false, wip: true };
		const refs: string[] = [];
		for (const state of filterChangeStates(gerrit.value.states, filter)) {
			if (state.status === 'merged') continue;
			const patchsets = gerrit.value.changes.get(state.change)!;
			refs.push('refs/remotes/' + REMOTE + '/changes/' + changeShard(state.change) + '/' + state.change + '/' + patchsets[patchsets.length - 1]);
		}
		const finalGraph = await countSpawns(() => dataSource.getCommits(work, null, null, 1000, true, true, false, false, CommitOrdering.Date, [REMOTE], [], [], refs, false));
		record('9. final graph (commit log re-loaded with the Gerrit refs)', finalGraph.ms, finalGraph.spawns);
		expect(finalGraph.value.error).toBeNull();

		// The branch graph must be visible long before the full Gerrit-augmented graph completes
		const fullMs = firstPaint.ms + gerrit.ms + finalGraph.ms;
		record('=> full two-phase view load (first paint + background Gerrit + final graph)', fullMs, null);
		expect(firstPaint.ms).toBeLessThan(fullMs * 0.9);
	});

	/* 9. Uncommitted changes: `git status` must run in PARALLEL with the commit log & refs */
	it('detects uncommitted changes in parallel with the commit log (dirty worktree)', async () => {
		fs.writeFileSync(path.join(work, 'dirty-file.txt'), 'uncommitted content\n');
		const { value: data, ms, spawns, commands } = await countSpawns(() => dataSource.getCommits(work, null, null, 1000, true, true, false, false, CommitOrdering.Date, [REMOTE], [], [], null, false));
		record('10. commit graph with uncommitted changes (git status in parallel)', ms, spawns);

		expect(data.error).toBeNull();
		expect(data.commits[0].hash).toBe(UNCOMMITTED);
		expect(data.commits[0].message).toBe('Uncommitted Changes (1)');
		// Exactly one `git status` and one `git log`, both started up front (concurrently, not
		// sequentially). The refs may add up to 3 more processes when the 3s ref snapshot cache
		// has expired (show-ref + for-each-ref + symbolic-ref), which depends on timing, not on
		// the code under test - so only the per-command counts are asserted.
		const count = (name: string) => commands.filter((args) => args.indexOf(name) !== -1).length;
		expect(count('status')).toBe(1);
		expect(count('log')).toBe(1);
		expect(spawns).toBeLessThanOrEqual(5);
	});

	/* 10. Commit Details View: the three Git commands of the details load run concurrently */
	it('loads the commit details of the branch head (parallel details load)', async () => {
		const { value: data, ms, spawns } = await countSpawns(() => dataSource.getCommitDetails(work, developTip, true));
		record('11. commit details (show + name-status + numstat, parallel)', ms, spawns);

		expect(data.error).toBeNull();
		expect(data.commitDetails!.hash).toBe(developTip);
		expect(spawns).toBeLessThanOrEqual(3);
	});
});
