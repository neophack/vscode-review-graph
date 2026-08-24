/**
 * Integration tests: the Gerrit pipeline (ls-remote -> targeted fetch -> NoteDb meta parsing)
 * and commit graph loading, run against REAL Git repositories built in a temporary directory.
 *
 * A bare repository acts as the "Gerrit server": Gerrit change refs (refs/changes/<shard>/<n>/<ps>)
 * and NoteDb meta refs (refs/changes/<shard>/<n>/meta) are created in it exactly as Gerrit would,
 * using only local transports (no network access is required).
 *
 * Simulated repository shapes:
 *  - "mergeSubmit": a Gerrit repository containing every change status at once:
 *      * a merged change submitted with a fast-forward (its patchset commit IS in the branch)
 *      * a merged change submitted with a cherry-pick (its original patchset commit DANGLES,
 *        the branch only contains the re-hashed copy - a commonly observed Gerrit submit situation)
 *      * open changes (single and multiple patchsets), an abandoned change and a WIP change
 *  - "noGerrit": a plain repository whose remote has no change refs at all
 *  - "empty": a freshly initialised repository without any commit
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
import { buildFetchRefspecs } from '../src/gerrit';
import { CommitOrdering, GerritChangeState, GerritPatchsetsMode, GerritStatusFilter } from '../src/types';
import { Logger } from '../src/logger';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';

/** Recursively remove a directory (compatible with the Node typings bundled with the project). */
function rmRecursive(target: string) {
	if (!fs.existsSync(target)) return;
	for (const entry of fs.readdirSync(target)) {
		const entryPath = path.join(target, entry);
		if (fs.statSync(entryPath).isDirectory()) {
			rmRecursive(entryPath);
		} else {
			// Git marks its object files read-only: clear the flag before deleting (Windows)
			try {
				fs.unlinkSync(entryPath);
			} catch (_) {
				fs.chmodSync(entryPath, 0o666);
				fs.unlinkSync(entryPath);
			}
		}
	}
	// Windows can keep a directory handle briefly open after a Git subprocess exited (EBUSY);
	// wait a moment and retry instead of failing an otherwise-passed test during cleanup.
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmdirSync(target);
			return;
		} catch (e) {
			if (attempt >= 10 || ['EBUSY', 'EPERM', 'ENOTEMPTY'].indexOf(e.code || '') === -1) throw e;
		}
		cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},25)']);
	}
}

jest.setTimeout(120000);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BASE_EPOCH = 1784599200; // 2026-07-21T10:00:00+00:00 - all commit timestamps derive from this
const hour = 3600, minute = 60;

/**
 * Run a Git command synchronously (used to BUILD the test repositories; the code under test
 * always runs through DataSource/GerritDataSource).
 */
function git(cwd: string, args: string[], env: { [key: string]: string } = {}) {
	const result = cp.spawnSync('git', args, {
		cwd: cwd,
		env: Object.assign({}, process.env, env),
		encoding: 'utf8'
	});
	if (result.status !== 0) {
		throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ':\n' + (result.stderr || (result.error ? result.error.message : 'unknown error')));
	}
	return (result.stdout || '').trim();
}

/** Identity arguments so every command works without any global Git configuration. */
const IDENTITY = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];

/** Date environment variables for deterministic commit/meta timestamps. */
const at = (epoch: number) => ({
	GIT_AUTHOR_DATE: '@' + epoch,
	GIT_COMMITTER_DATE: '@' + epoch
});

interface MetaEventSpec {
	message: string;
	epoch: number;
	committer: string;
}

/**
 * A test repository pair: a bare "Gerrit server" (`remote`) and a working clone (`work`).
 */
class GerritSandbox {
	public readonly root: string;
	public readonly remote: string;
	public readonly work: string;

	constructor(root: string) {
		this.root = root;
		this.remote = path.join(root, 'remote.git');
		this.work = path.join(root, 'work');
		fs.mkdirSync(this.remote);
		fs.mkdirSync(this.work);
		git(this.remote, ['init', '--bare', '-b', 'develop']);
		git(this.work, ['init', '-b', 'develop']);
		git(this.work, ['remote', 'add', 'origin', this.remote.replace(/\\/g, '/')]);
	}

	/** Create a commit changing a unique file on the current branch. */
	public commit(message: string, epoch: number, file?: string) {
		const filePath = path.join(this.work, file || ('file-' + Math.random().toString(36).slice(2, 10) + '.txt'));
		fs.writeFileSync(filePath, message + ' @ ' + epoch + '\n');
		git(this.work, IDENTITY.concat(['add', path.basename(filePath)]));
		const env = at(epoch);
		git(this.work, IDENTITY.concat(['commit', '-m', message]), env);
		return this.hash('HEAD');
	}

	public hash(revision: string) {
		return git(this.work, ['rev-parse', revision]);
	}

	public branch(name: string, from?: string) {
		git(this.work, ['checkout', '-q', '-b', name].concat(from ? [from] : []));
	}

	public checkout(name: string) {
		git(this.work, ['checkout', '-q', name]);
	}

	public cherryPick(hash: string, epoch: number) {
		git(this.work, IDENTITY.concat(['cherry-pick', hash]), at(epoch));
	}

	public fastForward(branch: string) {
		git(this.work, IDENTITY.concat(['merge', '--ff-only', branch]));
	}

	public push(spec: string) {
		git(this.work, ['push', '-q', 'origin', spec]);
	}

	/** Push a patchset commit to `refs/changes/<shard>/<change>/<patchset>` on the remote. */
	public pushChangeRef(change: number, patchset: number, hash: string) {
		const shard = ('0' + (change % 100)).slice(-2);
		this.push(hash + ':refs/changes/' + shard + '/' + change + '/' + patchset);
	}

	/** Build a NoteDb meta ref (`refs/changes/<shard>/<change>/meta`) from a chain of event messages (oldest first). */
	public pushMetaRef(change: number, events: MetaEventSpec[]) {
		const shard = ('0' + (change % 100)).slice(-2);
		let parent: string | null = null, tip = '';
		for (const event of events) {
			const args = ['commit-tree', EMPTY_TREE, '-m', event.message];
			if (parent !== null) args.push('-p', parent);
			tip = git(this.remote, args, Object.assign({
				GIT_AUTHOR_NAME: event.committer,
				GIT_AUTHOR_EMAIL: event.committer.replace(/\s/g, '') + '@gerrit.local',
				GIT_COMMITTER_NAME: event.committer,
				GIT_COMMITTER_EMAIL: event.committer.replace(/\s/g, '') + '@gerrit.local'
			}, at(event.epoch)));
			parent = tip;
		}
		git(this.remote, ['update-ref', 'refs/changes/' + shard + '/' + change + '/meta', tip]);
		return tip;
	}

	public fetch() {
		git(this.work, ['fetch', '-q', 'origin']);
	}
}

/**
 * Reconstruct the change refs that GitGraphView.loadGerritData injects into the commit log for
 * the changes that pass the status filter (mirroring src/gitGraphView.ts, including the rule that
 * MERGED changes never contribute refs: their content is already in the target branch's history).
 */
function viewRefs(states: GerritChangeState[], patchsetsByChange: Map<number, number[]>, filter: GerritStatusFilter, patchsetsMode: GerritPatchsetsMode, remote: string) {
	const refs: string[] = [];
	const kept = states.filter((state) => state.wip ? filter.wip : filter[state.status]);
	for (const state of kept) {
		if (state.status === 'merged') continue; // merged changes must not alter the graph
		const patchsets = patchsetsByChange.get(state.change)!;
		const keep = patchsetsMode === 'all' ? patchsets : [patchsets[patchsets.length - 1]];
		for (const patchset of keep) {
			const shard = ('0' + (state.change % 100)).slice(-2);
			refs.push('refs/remotes/' + remote + '/changes/' + shard + '/' + state.change + '/' + patchset);
		}
	}
	return refs;
}

const changeRef = (remote: string, change: number, patchset: number) =>
	'refs/remotes/' + remote + '/changes/' + ('0' + (change % 100)).slice(-2) + '/' + change + '/' + patchset;

describe('Gerrit integration (real Git repositories)', () => {
	let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
	let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
	let logger: Logger;
	let dataSource: DataSource;

	beforeAll(() => {
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
		logger = new Logger();
		dataSource = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
	});

	afterAll(() => {
		dataSource.dispose();
		logger.dispose();
		onDidChangeGitExecutable.dispose();
		onDidChangeConfiguration.dispose();
	});

	/** Commit loading with the standard "Show All Branches" options used by the view. */
	const loadCommits = (repo: string, gerritRefs: string[] | null, maxCommits = 100, branches: string[] | null = null, gerritShowChangeRefs = false) =>
		dataSource.getCommits(repo, branches, null, maxCommits, false, true, false, false, CommitOrdering.Date, ['origin'], [], [], gerritRefs, gerritShowChangeRefs);

	const hashesOf = (data: { commits: { hash: string }[] }) => data.commits.map((commit) => commit.hash);

	describe('Repository without Gerrit change refs', () => {
		let sandbox: GerritSandbox, base: string;
		beforeAll(() => {
			sandbox = new GerritSandbox(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-nogerrit-')));
			sandbox.commit('base: plain repository', BASE_EPOCH);
			base = sandbox.hash('HEAD');
			sandbox.push('develop');
			sandbox.fetch();
		});
		afterAll(() => {
			rmRecursive(sandbox.root);
		});

		it('lists no changes via ls-remote', async () => {
			const changes = await dataSource.gerrit.listRemoteChanges(sandbox.work, 'origin');
			expect(changes.size).toBe(0);
		});

		it('loads the same commits with gerrit refs NULL (integration disabled) and empty (no changes passing the filter)', async () => {
			const withNull = await loadCommits(sandbox.work, null);
			const withEmpty = await loadCommits(sandbox.work, []);
			expect(hashesOf(withNull)).toEqual([base]);
			expect(hashesOf(withEmpty)).toEqual(hashesOf(withNull));
		});
	});

	describe('Empty repository', () => {
		let sandbox: GerritSandbox;
		beforeAll(() => {
			sandbox = new GerritSandbox(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-empty-')));
		});
		afterAll(() => {
			rmRecursive(sandbox.root);
		});

		it('rejects commit loading with the standard Git error', async () => {
			const data = await loadCommits(sandbox.work, null);
			expect(data.commits).toEqual([]);
			expect(data.error).toBeTruthy();
		});
	});

	describe('Merge-submit Gerrit repository (all change statuses at once)', () => {
		let sandbox: GerritSandbox;
		let B: string[] = []; // base commits on develop
		let M1: string, D1: string, D1prime: string, O1: string, P1: string, P2: string, A1: string, W1: string;
		let metaTips: string[] = [];
		let states: GerritChangeState[];
		let patchsetsByChange: Map<number, number[]>;

		beforeAll(() => {
			sandbox = new GerritSandbox(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-mergesubmit-')));

			// Base history on develop (6 commits, one per day)
			for (let i = 0; i < 6; i++) B.push(sandbox.commit('base: commit ' + (i + 1), BASE_EPOCH + (i + 1) * 24 * hour));

			// Change #100: merged with a fast-forward (patchset commit reachable from develop)
			sandbox.branch('change-100', 'develop');
			M1 = sandbox.commit('feat: fast-forward merged change\n\nChange-Id: I' + '100'.padEnd(40, '0'), BASE_EPOCH + 7 * 24 * hour);
			sandbox.checkout('develop');
			sandbox.fastForward('change-100'); // develop tip = M1

			// Change #101: merged with a cherry-pick (original patchset dangles, branch holds a re-hashed copy)
			sandbox.branch('change-101', 'develop');
			D1 = sandbox.commit('feat: cherry-pick merged change\n\nChange-Id: I' + '101'.padEnd(40, '0'), BASE_EPOCH + 8 * 24 * hour);
			sandbox.checkout('develop');
			sandbox.cherryPick(D1, BASE_EPOCH + 8 * 24 * hour + hour); // D1' = same content & message, different hash
			D1prime = sandbox.hash('HEAD');

			// Change #102: open, single patchset
			sandbox.branch('change-102', 'develop');
			O1 = sandbox.commit('feat: open change (single patchset)\n\nChange-Id: I' + '102'.padEnd(40, '0'), BASE_EPOCH + 9 * 24 * hour);

			// Change #103: open, two patchsets (second uploaded on top of the first)
			sandbox.checkout('develop');
			sandbox.branch('change-103', 'develop');
			P1 = sandbox.commit('feat: open change (patchset 1)\n\nChange-Id: I' + '103'.padEnd(40, '0'), BASE_EPOCH + 9 * 24 * hour + hour);
			P2 = sandbox.commit('feat: open change (patchset 2)\n\nChange-Id: I' + '103'.padEnd(40, '0'), BASE_EPOCH + 9 * 24 * hour + 2 * hour);

			// Change #104: abandoned
			sandbox.checkout('develop');
			sandbox.branch('change-104', 'develop');
			A1 = sandbox.commit('feat: abandoned change\n\nChange-Id: I' + '104'.padEnd(40, '0'), BASE_EPOCH + 10 * 24 * hour);

			// Change #105: work in progress
			sandbox.checkout('develop');
			sandbox.branch('change-105', 'develop');
			W1 = sandbox.commit('feat: wip change\n\nChange-Id: I' + '105'.padEnd(40, '0'), BASE_EPOCH + 11 * 24 * hour);

			sandbox.checkout('develop');
			sandbox.push('develop');
			// Delete the local side branches: a real user's repository only holds the target branch,
			// the change commits are reachable exclusively through the Gerrit change refs
			for (const change of [100, 101, 102, 103, 104, 105]) git(sandbox.work, ['branch', '-D', 'change-' + change]);

			// Gerrit change refs on the "server"
			sandbox.pushChangeRef(100, 1, M1);
			sandbox.pushChangeRef(101, 1, D1);
			sandbox.pushChangeRef(102, 1, O1);
			sandbox.pushChangeRef(103, 1, P1);
			sandbox.pushChangeRef(103, 2, P2);
			sandbox.pushChangeRef(104, 1, A1);
			sandbox.pushChangeRef(105, 1, W1);

			// NoteDb meta refs on the "server" (event chains, oldest first)
			const t = (day: number, minutes: number) => BASE_EPOCH + day * 24 * hour + minutes * minute;
			metaTips.push(sandbox.pushMetaRef(100, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + M1 + '\nStatus: new\n', epoch: t(7, 1), committer: 'Dev' },
				{ message: 'Patch Set 1: Code-Review+2\n\nPatch-set: 1\nCommit: ' + M1 + '\nLabel: Code-Review=+2\nLabel: Verified=+1\nStatus: new\n', epoch: t(7, 2), committer: 'Gerrit User 1000013' },
				{ message: 'Change has been successfully merged by Alice\n\nPatch-set: 1\nCommit: ' + M1 + '\nStatus: merged\n', epoch: t(7, 3), committer: 'Gerrit User 1000018' }
			]));
			metaTips.push(sandbox.pushMetaRef(101, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + D1 + '\nStatus: new\n', epoch: t(8, 1), committer: 'Dev' },
				{ message: 'Change has been successfully cherry-picked by Bob\n\nPatch-set: 1\nCommit: ' + D1 + '\nStatus: merged\n', epoch: t(8, 2), committer: 'Gerrit User 1000018' }
			]));
			metaTips.push(sandbox.pushMetaRef(102, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + O1 + '\nStatus: new\n', epoch: t(9, 1), committer: 'Dev' },
				{ message: 'Patch Set 1: Code-Review+1\n\nPatch-set: 1\nCommit: ' + O1 + '\nLabel: Code-Review=+1\nStatus: new\n', epoch: t(9, 2), committer: 'Gerrit User 1000013' }
			]));
			metaTips.push(sandbox.pushMetaRef(103, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + P1 + '\nStatus: new\n', epoch: t(9, 10), committer: 'Dev' },
				{ message: 'Uploaded patch set 2.\n\nPatch-set: 2\nCommit: ' + P2 + '\nStatus: new\n', epoch: t(9, 11), committer: 'Dev' }
			]));
			metaTips.push(sandbox.pushMetaRef(104, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + A1 + '\nStatus: new\n', epoch: t(10, 1), committer: 'Dev' },
				{ message: 'Abandoned\n\nPatch-set: 1\nCommit: ' + A1 + '\nStatus: abandoned\n', epoch: t(10, 2), committer: 'Dev' }
			]));
			metaTips.push(sandbox.pushMetaRef(105, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + W1 + '\nStatus: new\n', epoch: t(11, 1), committer: 'Dev' },
				{ message: 'Start Work In Progress\n\nPatch-set: 1\nCommit: ' + W1 + '\nWork-in-progress: true\nStatus: new\n', epoch: t(11, 2), committer: 'Dev' }
			]));

			sandbox.fetch();
		});

		afterAll(() => {
			rmRecursive(sandbox.root);
		});

		/* 1. ls-remote: discover the changes on the remote */

		it('lists every change and its patchsets on the remote', async () => {
			patchsetsByChange = await dataSource.gerrit.listRemoteChanges(sandbox.work, 'origin');
			expect(Array.from(patchsetsByChange.keys()).sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 104, 105]);
			expect(patchsetsByChange.get(100)).toEqual([1]);
			expect(patchsetsByChange.get(103)).toEqual([1, 2]);
		});

		/* 2. Targeted fetch: patchset + meta refs land under refs/remotes/origin/changes/ */

		it('fetches the change refs and meta refs of the remote into the repository', async () => {
			const changes = await dataSource.gerrit.listRemoteChanges(sandbox.work, 'origin');
			const error = await dataSource.gerrit.fetchChanges(sandbox.work, 'origin', buildFetchRefspecs(changes, 'origin', 'latest'));
			expect(error).toBeNull();

			const localRefs = await dataSource.gerrit.listLocalChangeRefs(sandbox.work, 'origin');
			const expected: string[] = [];
			for (const [change, patchsets] of changes) {
				const shard = ('0' + (change % 100)).slice(-2);
				expected.push('refs/remotes/origin/changes/' + shard + '/' + change + '/' + patchsets[patchsets.length - 1]);
				expected.push('refs/remotes/origin/changes/' + shard + '/' + change + '/meta');
			}
			expect(localRefs.sort()).toEqual(expected.sort());
		});

		/* 3. NoteDb meta parsing: derive the change states from the real meta refs */

		it('parses the change states from the fetched NoteDb meta refs', async () => {
			states = [];
			for (const change of [100, 101, 102, 103, 104, 105]) {
				const state = await dataSource.gerrit.parseMeta(sandbox.work, 'origin', change, null);
				expect(state).not.toBeNull();
				states.push(state!);
			}
			const byChange = (change: number) => states.find((state) => state.change === change)!;

			expect(byChange(100)).toMatchObject({ status: 'merged', patchset: 1, headHash: M1, codeReview: 2, verified: 1, wip: false });
			expect(byChange(100).events.map((event) => event.type)).toEqual(['merged', 'vote', 'created']);
			expect(byChange(100).events[0].reviewer).toBe('Alice'); // submitter name from "merged by"

			expect(byChange(101)).toMatchObject({ status: 'merged', patchset: 1, headHash: D1, wip: false });
			expect(byChange(101).events[0].type).toBe('merged');
			expect(byChange(101).events[0].reviewer).toBe('Bob'); // submitter name from "cherry-picked by"

			expect(byChange(102)).toMatchObject({ status: 'new', patchset: 1, headHash: O1, codeReview: 1, verified: 0, wip: false });

			expect(byChange(103)).toMatchObject({ status: 'new', patchset: 2, headHash: P2 }); // head hash of the LATEST patchset
			expect(byChange(103).events.map((event) => event.type)).toEqual(['patchset', 'created']);

			expect(byChange(104)).toMatchObject({ status: 'abandoned', patchset: 1, headHash: A1 });
			expect(byChange(104).events.map((event) => event.type)).toEqual(['abandoned', 'created']);

			expect(byChange(105)).toMatchObject({ status: 'new', wip: true, headHash: W1 });
		});

		it('derives no change URL for a local path remote', async () => {
			expect(await dataSource.gerrit.getChangeUrlBase(sandbox.work, 'origin')).toBeNull();
		});

		/* 4. Commit graph: which changes may inject their patchset commits */

		it('shows the patchset commits of OPEN changes in the graph (latest patchset only)', async () => {
			const refs = viewRefs(states, patchsetsByChange, { new: true, merged: false, abandoned: false, wip: false }, 'latest', 'origin');
			expect(refs).toEqual([changeRef('origin', 102, 1), changeRef('origin', 103, 2)]);

			const data = await loadCommits(sandbox.work, refs);
			expect(hashesOf(data)).toEqual([P2, P1, O1, D1prime, M1, B[5], B[4], B[3], B[2], B[1], B[0]]);
		});

		it('shows all patchsets of open changes when the patchsets mode is "all"', async () => {
			// Fetch every patchset of every change (the "gerrit.patchsets": "all" pipeline)
			const changes = await dataSource.gerrit.listRemoteChanges(sandbox.work, 'origin');
			expect(await dataSource.gerrit.fetchChanges(sandbox.work, 'origin', buildFetchRefspecs(changes, 'origin', 'all'))).toBeNull();

			const refs = viewRefs(states, patchsetsByChange, { new: true, merged: false, abandoned: false, wip: false }, 'all', 'origin');
			expect(refs).toEqual([changeRef('origin', 102, 1), changeRef('origin', 103, 1), changeRef('origin', 103, 2)]);

			const data = await loadCommits(sandbox.work, refs);
			expect(hashesOf(data)).toEqual([P2, P1, O1, D1prime, M1, B[5], B[4], B[3], B[2], B[1], B[0]]);
		});

		it('keeps the graph IDENTICAL when the "Merged" chip is toggled (merged changes inject no refs)', async () => {
			const refsDefault = viewRefs(states, patchsetsByChange, { new: true, merged: false, abandoned: false, wip: false }, 'latest', 'origin');
			const refsMergedOn = viewRefs(states, patchsetsByChange, { new: true, merged: true, abandoned: false, wip: false }, 'latest', 'origin');
			expect(refsMergedOn).toEqual(refsDefault); // the fix: toggling "Merged" must not add refs

			const [withoutMerged, withMerged] = await Promise.all([
				loadCommits(sandbox.work, refsDefault),
				loadCommits(sandbox.work, refsMergedOn)
			]);
			expect(hashesOf(withMerged)).toEqual(hashesOf(withoutMerged));
			expect(hashesOf(withMerged)).not.toContain(D1); // the dangling cherry-picked patchset must NOT appear
		});

		it('injecting the dangling patchsets of merged changes WOULD distort the graph (window shift regression)', async () => {
			// This documents the original bug: refs/changes of cherry-pick-merged changes are NOT
			// reachable from any branch, so injecting them adds floating chains to the top of the
			// graph and pushes branch commits out of the loaded commits window.
			const openRefs = viewRefs(states, patchsetsByChange, { new: true, merged: false, abandoned: false, wip: false }, 'latest', 'origin');
			const buggyRefs = openRefs.concat([changeRef('origin', 101, 1)]); // merged change's patchset ref

			const withoutDangling = await loadCommits(sandbox.work, openRefs, 8);
			const withDangling = await loadCommits(sandbox.work, buggyRefs, 8);

			expect(hashesOf(withDangling)).toContain(D1);
			expect(hashesOf(withDangling)).not.toContain(B[3]); // B4 pushed out of the window
			expect(hashesOf(withoutDangling)).not.toContain(D1);
			expect(hashesOf(withoutDangling)).toContain(B[3]);
			expect(withoutDangling.moreCommitsAvailable).toBe(true);
		});

		it('a fast-forward merged change contributes no commits (its patchset is already in the branch)', async () => {
			const plain = await loadCommits(sandbox.work, []);
			const withFFMergedRef = await loadCommits(sandbox.work, [changeRef('origin', 100, 1)]);
			expect(hashesOf(withFFMergedRef)).toEqual(hashesOf(plain));
			expect(hashesOf(plain)).toContain(M1);
		});

		it('shows abandoned and WIP patchset commits only when their chips are enabled', async () => {
			const refs = viewRefs(states, patchsetsByChange, { new: false, merged: false, abandoned: true, wip: true }, 'latest', 'origin');
			expect(refs).toEqual([changeRef('origin', 104, 1), changeRef('origin', 105, 1)]);

			const data = await loadCommits(sandbox.work, refs);
			const hashes = hashesOf(data);
			expect(hashes.slice(0, 2)).toEqual([W1, A1]);
			expect(hashes).not.toContain(O1);
			expect(hashes).not.toContain(P2);
		});

		it('includes open change commits even when a specific branch is selected', async () => {
			const refs = viewRefs(states, patchsetsByChange, { new: true, merged: false, abandoned: false, wip: false }, 'latest', 'origin');
			const data = await loadCommits(sandbox.work, refs, 100, ['develop']);
			expect(hashesOf(data)).toEqual([P2, P1, O1, D1prime, M1, B[5], B[4], B[3], B[2], B[1], B[0]]);
		});

		it('never leaks NoteDb meta commits into the graph', async () => {
			const refs = viewRefs(states, patchsetsByChange, { new: true, merged: true, abandoned: true, wip: true }, 'all', 'origin');
			const data = await loadCommits(sandbox.work, refs);
			for (const metaTip of metaTips) {
				expect(hashesOf(data)).not.toContain(metaTip);
			}
		});

		it('does not list Gerrit change refs as remote branch references', async () => {
			const refData = await (<any>dataSource).getRefs(sandbox.work, true, false, []);
			expect(refData.remotes.map((ref: { name: string }) => ref.name).sort()).toEqual(['origin/develop']);
		});

		it('lists the Gerrit change refs as remote branch references when "Show Refs" is enabled', async () => {
			const refData = await (<any>dataSource).getRefs(sandbox.work, true, false, [], true);
			expect(refData.remotes.map((ref: { name: string }) => ref.name).sort()).toEqual([
				'origin/changes/00/100/1',
				'origin/changes/01/101/1',
				'origin/changes/02/102/1',
				'origin/changes/03/103/1',
				'origin/changes/03/103/2',
				'origin/changes/04/104/1',
				'origin/changes/05/105/1',
				'origin/develop'
			]);
		});

		it('annotates the change commits with their Gerrit change refs when "Show Refs" is enabled', async () => {
			const refs = viewRefs(states, patchsetsByChange, { new: true, merged: false, abandoned: false, wip: false }, 'latest', 'origin');
			const data = await loadCommits(sandbox.work, refs, 100, null, true);
			const remotesByHash: { [hash: string]: string[] } = {};
			for (const commit of data.commits) remotesByHash[commit.hash] = commit.remotes.map((remote) => remote.name);
			expect(remotesByHash[O1]).toEqual(['origin/changes/02/102/1']);
			expect(remotesByHash[P2]).toEqual(['origin/changes/03/103/2']);
			expect(remotesByHash[P1]).toEqual(['origin/changes/03/103/1']); // patchset 1 was downloaded by the earlier 'all' patchsets fetch
			expect(remotesByHash[M1]).toEqual(['origin/changes/00/100/1']); // a merged change's ref points at a commit already on develop
			expect(remotesByHash[D1prime]).toEqual(['origin/HEAD', 'origin/develop']); // the develop tip carries the remote HEAD + branch refs
		});

		/* 5. Pruning: keep the local change refs of the kept changes only */

		it('prunes the local change refs of changes outside the keep list', async () => {
			await dataSource.gerrit.pruneLocalChanges(sandbox.work, 'origin', [100, 101]);

			const localRefs = (await dataSource.gerrit.listLocalChangeRefs(sandbox.work, 'origin')).sort();
			expect(localRefs).toEqual([
				'refs/remotes/origin/changes/00/100/1',
				'refs/remotes/origin/changes/00/100/meta',
				'refs/remotes/origin/changes/01/101/1',
				'refs/remotes/origin/changes/01/101/meta'
			]);
		});

		it('clears all local change refs', async () => {
			const { error, cleared } = await dataSource.gerrit.clearLocalChanges(sandbox.work, 'origin');
			expect(error).toBeNull();
			expect(cleared).toBe(4);
			expect(await dataSource.gerrit.listLocalChangeRefs(sandbox.work, 'origin')).toEqual([]);
		});
	});

	describe('NoteDb submit records (constructed meta refs)', () => {
		let sandbox: GerritSandbox;
		let N1: string, N2: string, N2re: string, N3: string;

		beforeAll(async () => {
			sandbox = new GerritSandbox(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-submitfmt-')));
			sandbox.commit('base: submit formats', BASE_EPOCH);
			sandbox.push('develop');

			// Change #200: the submitter's name appears only in the BODY of the submit record
			// (modern Gerrit writes "Update patch set N" as the meta commit subject)
			N1 = sandbox.commit('feat: change 200\n\nChange-Id: I' + '200'.padEnd(40, '0'), BASE_EPOCH + 24 * hour);
			// Change #201: cherry-pick submit record ("... as <hash> by <name>" with the re-submit hash)
			N2 = sandbox.commit('feat: change 201\n\nChange-Id: I' + '201'.padEnd(40, '0'), BASE_EPOCH + 25 * hour);
			N2re = sandbox.commit('feat: change 201 (cherry-picked copy)\n\nChange-Id: I' + '201'.padEnd(40, '0'), BASE_EPOCH + 25 * hour + minute);
			// Change #202: Gerrit batched the vote and the submit into ONE meta commit
			N3 = sandbox.commit('feat: change 202\n\nChange-Id: I' + '202'.padEnd(40, '0'), BASE_EPOCH + 26 * hour);

			sandbox.pushChangeRef(200, 2, N1);
			sandbox.pushChangeRef(201, 1, N2);
			sandbox.pushChangeRef(202, 1, N3);

			const t = (day: number, minutes: number) => BASE_EPOCH + day * 24 * hour + minutes * minute;
			sandbox.pushMetaRef(200, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + N1 + '\nStatus: new\n', epoch: t(1, 1), committer: 'Dev' },
				{ message: 'Uploaded patch set 2.\n\nPatch-set: 2\nCommit: ' + N1 + '\nStatus: new\n', epoch: t(1, 2), committer: 'Dev' },
				{ message: 'Update patch set 2\n\nChange has been successfully merged by 张三\n\nPatch-set: 2\nCommit: ' + N1 + '\nStatus: merged\nSubmitted-with: OK\nTag: autogenerated:gerrit:merged\n', epoch: t(1, 3), committer: 'Gerrit User 1000018' }
			]);
			sandbox.pushMetaRef(201, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + N2 + '\nStatus: new\n', epoch: t(2, 1), committer: 'Dev' },
				{ message: 'Update patch set 1\n\nChange has been successfully cherry-picked as ' + N2re + ' by 李四\n\nPatch-set: 1\nCommit: ' + N2 + '\nStatus: merged\n', epoch: t(2, 2), committer: 'Gerrit User 1000018' }
			]);
			sandbox.pushMetaRef(202, [
				{ message: 'Create change\n\nPatch-set: 1\nCommit: ' + N3 + '\nStatus: new\n', epoch: t(3, 1), committer: 'Dev' },
				{ message: 'Patch Set 1: Code-Review+2\n\nChange has been successfully merged by 王五\n\nPatch-set: 1\nCommit: ' + N3 + '\nLabel: Code-Review=+2\nStatus: merged\n', epoch: t(3, 2), committer: 'Gerrit User 1000018' }
			]);

			// The real pipeline: discover the change refs on the "server" and fetch them locally
			const changes = await dataSource.gerrit.listRemoteChanges(sandbox.work, 'origin');
			expect(Array.from(changes.keys()).sort((a, b) => a - b)).toEqual([200, 201, 202]);
			expect(await dataSource.gerrit.fetchChanges(sandbox.work, 'origin', buildFetchRefspecs(changes, 'origin', 'latest'))).toBeNull();
		});

		afterAll(() => {
			rmRecursive(sandbox.root);
		});

		it('parses the submitter from the body when the subject is "Update patch set N" (modern NoteDb format)', async () => {
			const state = await dataSource.gerrit.parseMeta(sandbox.work, 'origin', 200, null);
			expect(state).not.toBeNull();
			expect(state!.status).toBe('merged');
			expect(state!.patchset).toBe(2);
			const merged = state!.events.find((event) => event.type === 'merged')!;
			expect(merged.raw).toBe('Update patch set 2');
			expect(merged.reviewer).toBe('张三'); // not the anonymous committer "Gerrit User 1000018"
		});

		it('parses the submitter from a "cherry-picked as <hash> by <name>" body line', async () => {
			const state = await dataSource.gerrit.parseMeta(sandbox.work, 'origin', 201, null);
			expect(state!.status).toBe('merged');
			const merged = state!.events.find((event) => event.type === 'merged')!;
			expect(merged.raw).toBe('Update patch set 1');
			expect(merged.reviewer).toBe('李四');
		});

		it('shows the submitter on a vote that Gerrit batched with the submit into one meta commit', async () => {
			const state = await dataSource.gerrit.parseMeta(sandbox.work, 'origin', 202, null);
			expect(state!.status).toBe('merged');
			const vote = state!.events.find((event) => event.type === 'vote')!;
			expect(vote.reviewer).toBe('王五');
			expect(state!.codeReview).toBe(2); // the Code-Review+2 batched with the submit still counts
		});
	});
});
