/**
 * Integration tests: complex Git repository shapes, run against REAL Git repositories built in a
 * temporary directory (no network access is required).
 *
 * Covered scenarios (motivated by the most common problem reports of the upstream project):
 *  - non-fast-forward merges and octopus merges (multi-parent commits)
 *  - rebased history (rewritten commits)
 *  - orphan branches (additional root commits)
 *  - annotated and lightweight tags, and multiple tags on one commit
 *  - stashes (including a stash based on a commit that is otherwise unreferenced)
 *  - detached HEAD
 *  - empty repositories
 *  - the commit path filter (filterPath)
 *  - commit subjects and author names containing the log field separator characters
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
import { CommitOrdering } from '../src/types';
import { Logger } from '../src/logger';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';

/** Recursively remove a directory (compatible with the Node typings bundled with the project). */
function rmRecursive(target: string) {
	if (!fs.existsSync(target)) return;
	for (const entry of fs.readdirSync(target)) {
		const entryPath = path.join(target, entry);
		// A Git subprocess may still be finishing and delete an entry (e.g. .git/index.lock)
		// after the readdir above listed it: an entry that is already gone needs no removal.
		let isDirectory: boolean;
		try {
			isDirectory = fs.statSync(entryPath).isDirectory();
		} catch (e) {
			if (e.code === 'ENOENT') continue;
			throw e;
		}
		if (isDirectory) {
			rmRecursive(entryPath);
		} else {
			// Git marks its object files read-only: clear the flag before deleting (Windows)
			try {
				fs.unlinkSync(entryPath);
			} catch (e) {
				if (e.code === 'ENOENT') continue;
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

const BASE_EPOCH = 1784599200; // 2026-07-21T10:00:00+00:00 - all commit timestamps derive from this
const hour = 3600;

/**
 * Run a Git command synchronously (used to BUILD the test repositories; the code under test
 * always runs through DataSource).
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

/** Date environment variables for deterministic commit timestamps. */
const at = (epoch: number) => ({
	GIT_AUTHOR_DATE: '@' + epoch,
	GIT_COMMITTER_DATE: '@' + epoch
});

/** Recursively ensure a directory exists (the bundled Node typings predate recursive mkdir). */
function ensureDir(dir: string) {
	// A leading separator must anchor the walk to the filesystem root: dropping it (as splitting
	// '/tmp/x' into ['', 'tmp', 'x'] and joining naively does) would create the tree RELATIVE to
	// the current working directory on macOS and Linux. A Windows drive letter ('C:') anchors
	// itself, so only POSIX-style absolute paths need the explicit root prefix.
	let cur = dir.split(path.sep)[0] === '' ? path.sep : '';
	for (const part of dir.split(path.sep)) {
		if (part === '') continue;
		cur = cur === '' ? part : path.join(cur, part);
		if (!fs.existsSync(cur)) fs.mkdirSync(cur);
	}
}

/**
 * A plain test repository (no Gerrit remote required).
 */
class GitSandbox {
	public readonly root: string;
	public readonly work: string;

	constructor(root: string, initialBranch = 'master') {
		this.root = root;
		this.work = path.join(root, 'work');
		ensureDir(this.work);
		git(this.work, ['init', '-b', initialBranch]);
	}

	/** Create a commit changing the specified file (relative to the repository root). */
	public commit(message: string, epoch: number, file: string, contents?: string) {
		const filePath = path.join(this.work, file);
		ensureDir(path.dirname(filePath));
		fs.writeFileSync(filePath, contents !== undefined ? contents : message + ' @ ' + epoch + '\n');
		git(this.work, IDENTITY.concat(['add', '--', file]));
		git(this.work, IDENTITY.concat(['commit', '-m', message]), at(epoch));
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

	public merge(message: string, epoch: number, args: string[]) {
		git(this.work, IDENTITY.concat(['merge', '-m', message].concat(args)), at(epoch));
		return this.hash('HEAD');
	}

	public rebase(onto: string) {
		git(this.work, IDENTITY.concat(['rebase', onto]));
	}

	public tag(name: string, annotated: boolean, message?: string) {
		git(this.work, annotated
			? IDENTITY.concat(['tag', '-a', name, '-m', message || ('annotated tag ' + name)])
			: ['tag', name]);
	}

	public stash(message?: string) {
		git(this.work, IDENTITY.concat(['stash', 'push'].concat(message ? ['-m', message] : [])));
	}

	public dispose() {
		rmRecursive(this.root);
	}
}

describe('Complex Git scenarios (real Git repositories)', () => {
	let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
	let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
	let logger: Logger;
	let dataSource: DataSource;
	let sandboxRoot: string;

	beforeAll(() => {
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
		logger = new Logger();
		dataSource = new DataSource({ path: 'git', version: '2.30.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-complex-'));
	});

	afterAll(() => {
		dataSource.dispose();
		logger.dispose();
		onDidChangeGitExecutable.dispose();
		onDidChangeConfiguration.dispose();
		rmRecursive(sandboxRoot);
	});

	const newSandbox = (name: string, initialBranch?: string) => new GitSandbox(path.join(sandboxRoot, name), initialBranch);

	/** Commit loading with the standard "Show All Branches" options used by the view. */
	const loadCommits = (repo: string, maxCommits = 100, branches: string[] | null = null, filterPath: string | null = null, showTags = false, stashes: any[] = []) =>
		dataSource.getCommits(repo, branches, null, maxCommits, showTags, true, false, false, CommitOrdering.Date, [], [], stashes, null, false, filterPath);

	const commitsByHash = (data: { commits: { hash: string }[] }) => {
		const map: { [hash: string]: any } = {};
		for (const commit of data.commits) map[commit.hash] = commit;
		return map;
	};

	it('Should load a non-fast-forward merge commit with both parents in order', async () => {
		const sandbox = newSandbox('merge');
		try {
			const base = sandbox.commit('base', BASE_EPOCH, 'base.txt');
			sandbox.branch('feature');
			sandbox.commit('feature work', BASE_EPOCH + hour, 'feature.txt');
			const featureHead = sandbox.hash('HEAD');
			sandbox.checkout('master');
			sandbox.commit('master work', BASE_EPOCH + hour, 'master.txt');
			const masterHead = sandbox.hash('HEAD');
			const mergeHash = sandbox.merge('Merge feature', BASE_EPOCH + 2 * hour, ['--no-ff', 'feature']);

			const data = await loadCommits(sandbox.work);
			const commits = commitsByHash(data);
			expect(commits[mergeHash].parents).toStrictEqual([masterHead, featureHead]);
			expect(commits[mergeHash].heads).toStrictEqual(['master']);
			expect(commits[base].parents).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('Should load an octopus merge commit with three parents', async () => {
		const sandbox = newSandbox('octopus');
		try {
			const base = sandbox.commit('base', BASE_EPOCH, 'base.txt');
			for (const name of ['a', 'b', 'c']) {
				sandbox.branch('branch-' + name, base);
				sandbox.commit('work ' + name, BASE_EPOCH + hour, name + '.txt');
			}
			sandbox.checkout('master');
			const octopusHash = sandbox.merge('Octopus merge', BASE_EPOCH + 2 * hour, ['branch-a', 'branch-b', 'branch-c']);
			const parents = [sandbox.hash('master^1'), sandbox.hash('master^2'), sandbox.hash('master^3')];
			expect(parents).toHaveLength(3);

			const data = await loadCommits(sandbox.work);
			const commits = commitsByHash(data);
			expect(commits[octopusHash].parents).toHaveLength(3);
			expect(commits[octopusHash].parents).toStrictEqual(parents);
		} finally {
			sandbox.dispose();
		}
	});

	it('Should load rebased history (the rewritten commits, without the pre-rebase originals)', async () => {
		const sandbox = newSandbox('rebase');
		try {
			sandbox.commit('base', BASE_EPOCH, 'base.txt');
			sandbox.branch('feature');
			const original = sandbox.commit('feature work (original)', BASE_EPOCH + hour, 'feature.txt');
			sandbox.checkout('master');
			sandbox.commit('master moved on', BASE_EPOCH + 2 * hour, 'master.txt');
			const newBase = sandbox.hash('HEAD');
			sandbox.checkout('feature');
			sandbox.rebase('master');
			const rebased = sandbox.hash('HEAD');

			const data = await loadCommits(sandbox.work);
			const hashes = data.commits.map((commit) => commit.hash);
			// The rebased branch contains the rewritten commit; the original is unreachable
			expect(hashes).toContain(rebased);
			expect(hashes).not.toContain(original);
			const commits = commitsByHash(data);
			expect(commits[rebased].parents).toStrictEqual([newBase]);
			expect(commits[rebased].heads).toStrictEqual(['feature']);
		} finally {
			sandbox.dispose();
		}
	});

	it('Should load an orphan branch with an additional root commit', async () => {
		const sandbox = newSandbox('orphan');
		try {
			sandbox.commit('base', BASE_EPOCH, 'base.txt');
			git(sandbox.work, ['checkout', '--orphan', 'isolated']);
			git(sandbox.work, IDENTITY.concat(['commit', '-m', 'orphan root']), at(BASE_EPOCH + hour));
			const orphanRoot = sandbox.hash('HEAD');

			const data = await loadCommits(sandbox.work);
			const commits = commitsByHash(data);
			// The orphan root has no parents, and both root commits are loaded
			expect(commits[orphanRoot].parents).toStrictEqual([]);
			expect(data.commits.filter((commit) => commit.parents.length === 0)).toHaveLength(2);
		} finally {
			sandbox.dispose();
		}
	});

	it('Should load annotated and lightweight tags, and multiple tags on one commit', async () => {
		const sandbox = newSandbox('tags');
		try {
			const c1 = sandbox.commit('first', BASE_EPOCH, 'first.txt');
			sandbox.tag('lightweight', false);
			const c2 = sandbox.commit('second', BASE_EPOCH + hour, 'second.txt');
			sandbox.tag('v1.0.0', true, 'release 1.0.0');
			sandbox.tag('v1.0', false);

			const repoInfo = await dataSource.getRepoInfo(sandbox.work, false, false, []);
			expect(repoInfo.error).toBeNull();
			expect(repoInfo.tags).toStrictEqual(['lightweight', 'v1.0', 'v1.0.0']);

			const data = await loadCommits(sandbox.work, 100, null, null, true);
			const commits = commitsByHash(data);
			expect(commits[c1].tags).toStrictEqual([{ name: 'lightweight', annotated: false }]);
			// An annotated tag points at the commit via its tag object; both tags attach to the commit
			expect(commits[c2].tags).toHaveLength(2);
			expect(commits[c2].tags).toContainEqual({ name: 'v1.0.0', annotated: true });
			expect(commits[c2].tags).toContainEqual({ name: 'v1.0', annotated: false });
		} finally {
			sandbox.dispose();
		}
	});

	it('Should load stashes and attach them to their base commits', async () => {
		const sandbox = newSandbox('stash');
		try {
			sandbox.commit('base', BASE_EPOCH, 'base.txt');
			sandbox.commit('work in progress', BASE_EPOCH + hour, 'wip.txt');
			const stashBase = sandbox.hash('HEAD');
			fs.writeFileSync(path.join(sandbox.work, 'wip.txt'), 'uncommitted change\n');
			sandbox.stash('my stash message');

			const repoInfo = await dataSource.getRepoInfo(sandbox.work, true, true, []);
			expect(repoInfo.error).toBeNull();
			expect(repoInfo.stashes).toHaveLength(1);
			const stash = repoInfo.stashes[0];
			expect(stash.baseHash).toBe(stashBase);
			expect(stash.selector).toBe('refs/stash@{0}');
			expect(stash.message).toContain('my stash message');

			const data = await loadCommits(sandbox.work, 100, null, null, false, repoInfo.stashes as any[]);
			const commits = commitsByHash(data);
			// The stash commit isn't part of the branch history: it is inserted as an additional
			// commit node above its base commit, carrying the parsed stash selector
			expect(commits[stash.hash].stash).toStrictEqual({
				selector: stash.selector,
				baseHash: stash.baseHash,
				untrackedFilesHash: stash.untrackedFilesHash
			});
			expect(commits[stash.hash].parents).toStrictEqual([stashBase]);
			expect(commits[stashBase].stash).toBeNull();
		} finally {
			sandbox.dispose();
		}
	});

	it('Should load the commits of a repository in a detached HEAD state', async () => {
		const sandbox = newSandbox('detached');
		try {
			sandbox.commit('first', BASE_EPOCH, 'first.txt');
			const detachedAt = sandbox.commit('second', BASE_EPOCH + hour, 'second.txt');
			sandbox.commit('third', BASE_EPOCH + 2 * hour, 'third.txt');
			git(sandbox.work, ['checkout', '-q', '--detach', detachedAt]);

			const repoInfo = await dataSource.getRepoInfo(sandbox.work, true, true, []);
			expect(repoInfo.error).toBeNull();
			// `git branch` reports "(HEAD detached at <hash>)", which is filtered as a non-branch:
			// the branch head is NULL in a detached HEAD state (the graph still loads every branch)
			expect(repoInfo.head).toBeNull();

			const data = await loadCommits(sandbox.work);
			// All branches are shown, so every commit is loaded despite the detached HEAD
			expect(data.commits).toHaveLength(3);
			expect(data.error).toBeNull();
		} finally {
			sandbox.dispose();
		}
	});

	it('Should return empty results for a repository without any commit', async () => {
		const sandbox = newSandbox('empty');
		try {
			const repoInfo = await dataSource.getRepoInfo(sandbox.work, true, true, []);
			expect(repoInfo.error).toBeNull();
			// `git branch` lists nothing until the first commit exists
			expect(repoInfo.branches).toStrictEqual([]);
			expect(repoInfo.head).toBeNull();
			expect(repoInfo.stashes).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('Should filter the loaded commits by a file path (filterPath)', async () => {
		const sandbox = newSandbox('filter');
		try {
			sandbox.commit('touch readme', BASE_EPOCH, 'README.md');
			const readmeHash = sandbox.hash('HEAD');
			sandbox.commit('touch source', BASE_EPOCH + hour, 'src/main.ts');
			const sourceHash = sandbox.hash('HEAD');
			// A commit that only modifies a file inside a subdirectory of the filter path
			sandbox.commit('touch nested source', BASE_EPOCH + 2 * hour, 'src/deep/nested.ts');
			const nestedHash = sandbox.hash('HEAD');

			// No filter: every commit is loaded
			const unfiltered = await loadCommits(sandbox.work);
			expect(unfiltered.commits).toHaveLength(3);

			// Filter by file: only the commits that modified README.md
			const byFile = await loadCommits(sandbox.work, 100, null, 'README.md');
			expect(byFile.commits.map((commit) => commit.hash)).toStrictEqual([readmeHash]);

			// Filter by directory: every commit that modified anything below src/
			const byDirectory = await loadCommits(sandbox.work, 100, null, 'src');
			expect(byDirectory.commits.map((commit) => commit.hash).sort()).toStrictEqual([nestedHash, sourceHash].sort());

			// Filter by a path nothing modified
			const byMissing = await loadCommits(sandbox.work, 100, null, 'does/not/exist.txt');
			expect(byMissing.commits).toStrictEqual([]);
		} finally {
			sandbox.dispose();
		}
	});

	it('Should parse subjects and author names containing separator characters (searchHistory)', async () => {
		const sandbox = newSandbox('separators');
		try {
			// An author name and a subject containing the legacy `|` separator must not shift fields
			git(sandbox.work, ['-c', 'user.name=Anne|Beth', '-c', 'user.email=anne@example.com', 'commit', '--allow-empty', '-m', 'fix|parse|pipes'], at(BASE_EPOCH));
			const hash = sandbox.hash('HEAD');

			const results = await dataSource.searchHistory(sandbox.work, 'parse');
			expect(results).toHaveLength(1);
			expect(results[0].hash).toBe(hash);
			expect(results[0].author).toBe('Anne|Beth');
			expect(results[0].message).toBe('fix|parse|pipes');
			expect(results[0].date).toBe(BASE_EPOCH);
		} finally {
			sandbox.dispose();
		}
	});
});
