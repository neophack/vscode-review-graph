import * as cp from 'child_process';
import * as fs from 'fs';
import { decode, encodingExists } from 'iconv-lite';
import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassEnvironment, AskpassManager } from './askpass/askpassManager';
import { getConfig } from './config';
import { GerritDataSource } from './gerrit';
import { Logger } from './logger';
import { ActionedUser, CommitOrdering, DateType, DeepWriteable, ErrorInfo, ErrorInfoExtensionPrefix, GitCommit, GitCommitDetails, GitCommitStash, GitConfigLocation, GitFileChange, GitFileStatus, GitLineCounts, GitPushBranchMode, GitRepoConfig, GitRepoConfigBranches, GitResetMode, GitSignature, GitSignatureStatus, GitStash, GitTagDetails, LossWarning, MergeActionOn, RebaseActionOn, SquashMessageFormat, TagType, Writeable } from './types';
import { GitExecutable, GitVersionRequirement, UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED, abbrevCommit, constructIncompatibleGitVersionMessage, doesVersionMeetRequirement, getPathFromStr, getPathFromUri, isSafeRefName, isSafeStashSelector, isValidCommitHash, openGitTerminal, pathWithTrailingSlash, quoteShellArg, realpath, resolveSpawnOutput, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { GgEvent } from './utils/event';

const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;
const EOL_REGEX = /\r\n|\r|\n/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const GIT_LOG_SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';

/**
 * How long a repository's refs stay cached after they were read. Just long enough that the
 * `loadRepoInfo` and `loadCommits` requests of a single view load share one read of the refs
 * (they are sent milliseconds apart), and short enough that it can't serve a stale graph. Every
 * Git action run by the extension, and every change to the repository's `.git` directory,
 * invalidates it explicitly (`invalidateRefCache`).
 */
const REF_SNAPSHOT_CACHE_MS = 3000;

/** The maximum number of refs peeled by a single `rev-parse` process. */
const PEEL_REFS_BATCH_SIZE = 200;

/**
 * The hash of Git's empty tree object, used as the diff base of a root commit (whose files then
 * report as added rather than being unaccounted for).
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

const GPG_STATUS_CODE_PARSING_DETAILS: Readonly<{ [statusCode: string]: GpgStatusCodeParsingDetails }> = {
	'GOODSIG': { status: GitSignatureStatus.GoodAndValid, uid: true },
	'BADSIG': { status: GitSignatureStatus.Bad, uid: true },
	'ERRSIG': { status: GitSignatureStatus.CannotBeChecked, uid: false },
	'EXPSIG': { status: GitSignatureStatus.GoodButExpired, uid: true },
	'EXPKEYSIG': { status: GitSignatureStatus.GoodButMadeByExpiredKey, uid: true },
	'REVKEYSIG': { status: GitSignatureStatus.GoodButMadeByRevokedKey, uid: true }
};

/**
 * Interfaces Git Graph with the Git executable to provide all Git integrations.
 */
export class DataSource extends Disposable {
	private readonly logger: Logger;
	private readonly askpassEnv: AskpassEnvironment;
	public readonly gerrit: GerritDataSource;
	private gitExecutable!: GitExecutable | null;
	private gitExecutableSupportsGpgInfo!: boolean;
	private gitFormatCommitDetails!: string;
	private gitFormatLog!: string;
	private gitFormatStash!: string;
	/** Cache of Git config data per repository, to avoid repeated Git spawns on every view load. */
	private readonly configCache = new Map<string, { remotesSignature: string, promise: Promise<GitRepoConfigData> }>();
	/** Cache of the refs of each repository, to avoid repeated ref scans on every view load. */
	private readonly refSnapshotCache = new Map<string, { key: string, expiresAt: number, promise: Promise<GitRefSnapshot> }>();
	/**
	 * The `+N/-M` line counts of the last diff whose counts were computed. A details load settles
	 * its file list's counts in batches, and a diff between two fixed revisions cannot change
	 * under the cache, so every batch after the first settles from memory.
	 */
	private numStatCache: { repo: string, from: string | null, to: string, counts: { [path: string]: GitLineCounts } } | null = null;

	/**
	 * Check that values received from an untrusted source (the webview) are safe to be passed to
	 * git, i.e. they cannot be misinterpreted as git options (argument injection).
	 * @param checks Tuples of [argument name, value, kind] to validate. Values that are null or
	 * undefined are skipped.
	 * @returns An error message if any value is unsafe, otherwise null.
	 */
	private static checkUnsafeGitArgs(...checks: [string, string | null | undefined, 'hash' | 'ref' | 'stash' | 'url'][]): ErrorInfo {
		for (const [name, value, kind] of checks) {
			if (value === null || value === undefined) continue;
			let valid: boolean;
			if (kind === 'hash') {
				valid = isValidCommitHash(value);
			} else if (kind === 'stash') {
				valid = isSafeStashSelector(value);
			} else if (kind === 'url') {
				// URLs (including the "" placeholder used when no URL is set) can't be validated as
				// strictly as a ref name, but a leading '-' would still let the value be misinterpreted
				// as a git option instead of a positional argument
				valid = value[0] !== '-';
			} else {
				valid = isSafeRefName(value);
			}
			if (!valid) {
				const label = kind === 'hash' ? 'commit hash' : (kind === 'stash' ? 'stash selector' : (kind === 'url' ? 'URL' : 'reference name'));
				return 'Invalid ' + label + ' was provided for "' + name + '"';
			}
		}
		return null;
	}

	/**
	 * Creates the Git Graph Data Source.
	 * @param gitExecutable The Git executable available to Git Graph at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(gitExecutable: GitExecutable | null, onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>, onDidChangeGitExecutable: GgEvent<GitExecutable | null>, logger: Logger) {
		super();
		this.logger = logger;
		this.setGitExecutable(gitExecutable);

		const askpassManager = new AskpassManager();
		this.askpassEnv = askpassManager.getEnv();
		this.gerrit = new GerritDataSource(this);

		this.registerDisposables(
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('review-graph.date.type') ||
					event.affectsConfiguration('review-graph.repository.commits.showSignatureStatus') ||
					event.affectsConfiguration('review-graph.repository.useMailmap')
				) {
					this.generateGitCommandFormats();
				}
			}),
			onDidChangeGitExecutable((gitExecutable) => {
				this.setGitExecutable(gitExecutable);
			}),
			askpassManager
		);
	}

	/**
	 * Check if the Git executable is unknown.
	 * @returns TRUE => Git executable is unknown, FALSE => Git executable is known.
	 */
	public isGitExecutableUnknown() {
		return this.gitExecutable === null;
	}

	/**
	 * Set the Git executable used by the DataSource.
	 * @param gitExecutable The Git executable.
	 */
	private setGitExecutable(gitExecutable: GitExecutable | null) {
		this.gitExecutable = gitExecutable;
		this.gitExecutableSupportsGpgInfo = gitExecutable !== null && doesVersionMeetRequirement(gitExecutable.version, GitVersionRequirement.GpgInfo);
		this.generateGitCommandFormats();
	}

	/**
	 * Generate the format strings used by various Git commands.
	 */
	private generateGitCommandFormats() {
		const config = getConfig();
		const dateType = config.dateType === DateType.Author ? '%at' : '%ct';
		const useMailmap = config.useMailmap;

		this.gitFormatCommitDetails = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', '%at', useMailmap ? '%cN' : '%cn', useMailmap ? '%cE' : '%ce', '%ct', // Author / Commit Information
			...(config.showSignatureStatus && this.gitExecutableSupportsGpgInfo ? ['%G?', '%GS', '%GK'] : ['', '', '']), // GPG Key Information
			'%B' // Body
		].join(GIT_LOG_SEPARATOR);

		// Only the subject is fetched for the commit list: full bodies dominate the git log output
		// size on large repositories (and with it the parse and IPC cost). Bodies are fetched on
		// demand via getCommitBodies (e.g. when "Show Commit Body Inline" is enabled).
		this.gitFormatLog = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatStash = [
			'%H', '%P', '%gD', // Hash, Parent & Selector Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);
	}


	/* Get Data Methods - Core */

	/**
	 * Get the high-level information of a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showStashes Are stashes shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The repositories information.
	 */
	public async trackRemoteTags(repo: string): Promise<void> {
		try {
			const remotes = await this.getRemotes(repo);
			await Promise.all(remotes.map(async (remote) => {
				const fetchConfigs = await this._spawnGit(['config', '--get-all', 'remote.' + remote + '.fetch'], repo, stdout => stdout, true);
				if (!fetchConfigs.includes('refs/remotes/' + remote + '/tags/*')) {
					await this._spawnGit(['config', '--add', 'remote.' + remote + '.fetch', '+refs/tags/*:refs/remotes/' + remote + '/tags/*'], repo, () => {}, true);
				}
			}));
		} catch (e) {}
	}

	public searchHistory(repo: string, query: string): Promise<{hash: string, author: string, date: number, message: string}[]> {
		// The unit separator (\x1f) is used instead of `|` so that hashes, author names and
		// subjects containing `|` don't shift the fields
		const args = ['log', '--all', '-E', '-i', '--grep=' + query, '--format=%H%x1f%an%x1f%at%x1f%s', '--max-count=100'];
		return this.spawnGit(args, repo, (stdoutBuf) => {
			const text = stdoutBuf.toString().replace(/\n$/, '');
			if (!text) return [];
			const lines = text.split('\n');
			return lines.map(line => {
				const parts = line.split('\x1f');
				return {
					hash: parts[0],
					author: parts[1],
					date: parseInt(parts[2], 10),
					message: parts.slice(3).join('|')
				};
			});
		});
	}

	public getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: ReadonlyArray<string>): Promise<GitRepoInfo> {
		const config = getConfig();
		return Promise.all([
			// The branches and tags come from the SAME ref read that the `loadCommits` request
			// immediately after this one needs, rather than from a `git branch -a` and a
			// `git tag --list` that would each scan the repository's refs all over again.
			this.readRefs(repo, {
				showRemoteBranches: showRemoteBranches,
				showRemoteHeads: config.showRemoteHeads,
				hideRemotes: hideRemotes,
				showChangeRefs: config.gerrit.showChangeRefs
			}).catch(() => <GitRefSnapshot>{ refData: { head: null, heads: [], tags: [], remotes: [] }, branches: [], branchHead: null, tagNames: [] }),
			this.getRemotes(repo),
			showStashes ? this.getStashes(repo) : Promise.resolve([])
		]).then((results) => {
			return { branches: results[0].branches, head: results[0].branchHead, remotes: results[1], stashes: results[2], tags: results[0].tagNames, error: null };
		}).catch((errorMessage) => {
			return { branches: [], head: null, remotes: [], stashes: [], tags: [], error: errorMessage };
		});
	}
	/**
	 * Get the commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param maxCommits The maximum number of commits to return.
	 * @param showTags Are tags are shown.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Should commits mentioned by reflogs being included.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param commitOrdering The order for commits to be returned.
	 * @param remotes An array of known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param gerritRefs The list of Gerrit change refs allowed into the graph (NULL => Gerrit integration disabled).
	 * @param gerritShowChangeRefs Should the Gerrit change refs (refs/remotes/<remote>/changes/*) be displayed as remote branch refs.
	 * @param filterPath Only show commits that modified the file(s) at this path (relative to the repository root; multiple comma-separated paths match commits changing ANY of them), or NULL (no path filter).
	 * @param deferUncommittedChanges Skip computing the "Uncommitted Changes" row (which requires a
	 * `git status` that can be slow on large working trees). Use this to render the graph
	 * immediately, and fetch the uncommitted changes status separately afterwards.
	 * @returns The commits in the repository.
	 */
	public getCommits(repo: string, branches: ReadonlyArray<string> | null, authors: ReadonlyArray<string> | null, maxCommits: number, showTags: boolean, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, commitOrdering: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>, gerritRefs: ReadonlyArray<string> | null = null, gerritShowChangeRefs: boolean = false, filterPath: string | null = null, deferUncommittedChanges: boolean = false): Promise<GitCommitData> {
		const config = getConfig();
		// Branch names are received from the webview and passed to git log as bare arguments, so
		// drop any that could be misinterpreted as git options (argument injection). Custom Branch
		// Glob Patterns are the one legitimate exception: they are always of the form `--glob=<pattern>`
		// (see Config.customBranchGlobPatterns), a single argv token that git can't reinterpret as a
		// different option, so they're allowed through even though they start with `-`.
		const refs = branches === null ? null : branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
		// The commit log, refs and uncommitted changes status are all started before any of them
		// is awaited, so that the three Git processes run in parallel
		const logPromise = this.getLog(repo, refs, authors, maxCommits + 1, showTags && config.showCommitsOnlyReferencedByTags, showRemoteBranches, includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, remotes, hideRemotes, stashes, gerritRefs, filterPath);
		const refsPromise = this.getRefs(repo, showRemoteBranches, config.showRemoteHeads, hideRemotes, gerritShowChangeRefs).then((refData: GitRefData) => refData, (errorMessage: string) => errorMessage);
		const uncommittedChangesPromise = config.showUncommittedChanges && !deferUncommittedChanges ? this.getUncommittedChanges(repo) : null;
		if (uncommittedChangesPromise !== null) uncommittedChangesPromise.catch(() => { /* the failure is re-thrown when the value is used below */ });
		return Promise.all([logPromise, refsPromise]).then(async (results) => {
			let commits: GitCommitRecord[] = results[0], refData: GitRefData | string = results[1], i;
			let moreCommitsAvailable = commits.length === maxCommits + 1;
			if (moreCommitsAvailable) commits.pop();

			// It doesn't matter if getRefs() was rejected if no commits exist
			if (typeof refData === 'string') {
				// getRefs() returned an error message (string)
				if (commits.length > 0) {
					// Commits exist, throw the error
					throw refData;
				} else {
					// No commits exist, so getRefs() will always return an error. Set refData to the default value
					refData = { head: null, heads: [], tags: [], remotes: [] };
				}
			}

			if (refData.head !== null && uncommittedChangesPromise !== null) {
				for (i = 0; i < commits.length; i++) {
					if (refData.head === commits[i].hash) {
						const numUncommittedChanges = await uncommittedChangesPromise;
						if (numUncommittedChanges > 0) {
							commits.unshift({ hash: UNCOMMITTED, parents: [refData.head], author: '*', email: '', date: Math.round((new Date()).getTime() / 1000), message: 'Uncommitted Changes (' + numUncommittedChanges + ')' });
						}
						break;
					}
				}
			}

			let commitNodes: DeepWriteable<GitCommit>[] = [];
			let commitLookup: { [hash: string]: number } = {};

			for (i = 0; i < commits.length; i++) {
				commitLookup[commits[i].hash] = i;
				commitNodes.push({ ...commits[i], heads: [], tags: [], remotes: [], stash: null });
			}

			/* Insert Stashes */
			let toAdd: { index: number, data: GitStash }[] = [];
			for (i = 0; i < stashes.length; i++) {
				if (typeof commitLookup[stashes[i].hash] === 'number') {
					commitNodes[commitLookup[stashes[i].hash]].stash = {
						selector: stashes[i].selector,
						baseHash: stashes[i].baseHash,
						untrackedFilesHash: stashes[i].untrackedFilesHash
					};
				} else if (typeof commitLookup[stashes[i].baseHash] === 'number') {
					toAdd.push({ index: commitLookup[stashes[i].baseHash], data: stashes[i] });
				}
			}
			toAdd.sort((a, b) => a.index !== b.index ? a.index - b.index : b.data.date - a.data.date);
			for (i = toAdd.length - 1; i >= 0; i--) {
				let stash = toAdd[i].data;
				commitNodes.splice(toAdd[i].index, 0, {
					hash: stash.hash,
					parents: [stash.baseHash],
					author: stash.author,
					email: stash.email,
					date: stash.date,
					message: stash.message,
					heads: [], tags: [], remotes: [],
					stash: {
						selector: stash.selector,
						baseHash: stash.baseHash,
						untrackedFilesHash: stash.untrackedFilesHash
					}
				});
			}
			for (i = 0; i < commitNodes.length; i++) {
				// Correct commit lookup after stashes have been spliced in
				commitLookup[commitNodes[i].hash] = i;
			}

			/* Annotate Heads */
			for (i = 0; i < refData.heads.length; i++) {
				if (typeof commitLookup[refData.heads[i].hash] === 'number') commitNodes[commitLookup[refData.heads[i].hash]].heads.push(refData.heads[i].name);
			}

			/* Annotate Tags */
			if (showTags) {
				for (i = 0; i < refData.tags.length; i++) {
					if (typeof commitLookup[refData.tags[i].hash] === 'number') commitNodes[commitLookup[refData.tags[i].hash]].tags.push({ name: refData.tags[i].name, annotated: refData.tags[i].annotated });
				}
			}

			/* Annotate Remotes */
			for (i = 0; i < refData.remotes.length; i++) {
				if (typeof commitLookup[refData.remotes[i].hash] === 'number') {
					let name = refData.remotes[i].name;
					let remote = remotes.find(remote => name.startsWith(remote + '/'));
					commitNodes[commitLookup[refData.remotes[i].hash]].remotes.push({ name: name, remote: remote ? remote : null });
				}
			}

			return {
				commits: commitNodes,
				head: refData.head,
				tags: unique(refData.tags.map((tag) => tag.name)),
				moreCommitsAvailable: moreCommitsAvailable,
				error: null
			};
		}).catch((errorMessage) => {
			return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: errorMessage };
		});
	}

	/**
	 * Get various Git config variables for a repository that are consumed by the Git Graph View.
	 * The result is cached per repository (and invalidated when the set of remotes changes, the
	 * repository's `.git/config` is modified, or `invalidateConfigCache` is called), because it
	 * requires several Git spawns that would otherwise be repeated on every view load.
	 * @param repo The path of the repository.
	 * @param remotes An array of known remotes.
	 * @returns The config data.
	 */
	public getConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		const remotesSignature = remotes.join('\n');
		const cached = this.configCache.get(repo);
		if (cached !== undefined && cached.remotesSignature === remotesSignature) {
			return cached.promise;
		}
		const promise = this.loadConfig(repo, remotes).then((data) => {
			if (data.error !== null) {
				// Don't cache error results (they may be transient): allow the next call to retry
				if (this.configCache.get(repo)?.promise === promise) this.configCache.delete(repo);
			}
			return data;
		});
		this.configCache.set(repo, { remotesSignature: remotesSignature, promise: promise });
		return promise;
	}

	/**
	 * Invalidate the cached Git config data for a repository (e.g. because its `.git/config` file
	 * was modified), so that the next `getConfig` call reloads it from Git.
	 * @param repo The path of the repository (or NULL to clear the cache of all repositories).
	 */
	public invalidateConfigCache(repo: string | null) {
		if (repo === null) {
			this.configCache.clear();
		} else {
			this.configCache.delete(repo);
		}
	}

	private loadConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		return Promise.all([
			this.getConfigList(repo),
			this.getConfigList(repo, GitConfigLocation.Local),
			this.getConfigList(repo, GitConfigLocation.Global),
			this.getAuthorList(repo)
		]).then((results) => {
			const consolidatedConfigs = results[0], localConfigs = results[1], globalConfigs = results[2], authors = results[3];

			const branches: GitRepoConfigBranches = {};
			Object.keys(localConfigs).forEach((key) => {
				if (key.startsWith('branch.')) {
					if (key.endsWith('.remote')) {
						const branchName = key.substring(7, key.length - 7);
						branches[branchName] = {
							pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
							remote: localConfigs[key]
						};
					} else if (key.endsWith('.pushremote')) {
						const branchName = key.substring(7, key.length - 11);
						branches[branchName] = {
							pushRemote: localConfigs[key],
							remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
						};
					}
				}
			});
			return {
				config: {
					branches: branches,
					authors,
					diffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffTool),
					guiDiffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffGuiTool),
					pushDefault: getConfigValue(consolidatedConfigs, GitConfigKey.RemotePushDefault),
					remotes: remotes.map((remote) => ({
						name: remote,
						url: getConfigValue(localConfigs, 'remote.' + remote + '.url'),
						pushUrl: getConfigValue(localConfigs, 'remote.' + remote + '.pushurl')
					})),
					user: {
						name: {
							local: getConfigValue(localConfigs, GitConfigKey.UserName),
							global: getConfigValue(globalConfigs, GitConfigKey.UserName)
						},
						email: {
							local: getConfigValue(localConfigs, GitConfigKey.UserEmail),
							global: getConfigValue(globalConfigs, GitConfigKey.UserEmail)
						}
					}
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { config: null, error: errorMessage };
		});
	}

	private async getAuthorList(repo: string): Promise<ActionedUser[]> {
		const args = ['shortlog', '-e', '-s', '-n', 'HEAD'];
		const dict = new Set<string>();
		const result = await this.spawnGit(args, repo, (authors) => {
			return authors.split(/\r?\n/g)
				.map(line => line.trim())
				.filter(line => line.trim().length > 0)
				.map(line => line.substring(line.indexOf('\t') + 1))
				.map(line => {
					const indexOfEmailSeparator = line.indexOf('<');
					if (indexOfEmailSeparator === -1) {
						return {
							name: line.trim(),
							email: ''
						};
					} else {
						const nameParts = line.split('<');
						const name = nameParts.shift()!.trim();
						const email = nameParts[0].substring(0, nameParts[0].length - 1).trim();
						return {
							name,
							email
						};
					}
				})
				.filter(item => {
					if (dict.has(item.name)) {
						return false;
					}
					dict.add(item.name);
					return true;
				})
				.sort((a, b) => (a.name > b.name ? 1 : -1));
		}).catch((errorMessage) => {
			if (typeof errorMessage === 'string') {
				const message = errorMessage.toLowerCase();
				if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
					// If the Git command failed due to the configuration file not existing, return an empty list instead of throwing the exception
					return [];
				}
			} else {
				errorMessage = 'An unexpected error occurred while spawning the Git child process.';
			}
			throw errorMessage;
		});
		return result;
	}
	/* Get Data Methods - Commit Details View */

	/**
	 * Get the commit details for the Commit Details View.
	 *
	 * The `+N/-M` line counts are deliberately NOT computed here: every file's counts cost two
	 * blob reads, which dominates the load of a many-file commit. The file list is returned with
	 * statuses only and the view settles the counts afterwards, a viewport at a time, through
	 * `getCommitFileCounts`.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @param hasParents Does the commit have parents
	 * @returns The commit details.
	 */
	public getCommitDetails(repo: string, commitHash: string, hasParents: boolean): Promise<GitCommitDetailsData> {
		const fromCommit = commitHash + (hasParents ? '^' : '');
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, fromCommit, commitHash)
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1], [], null);
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the `+N/-M` line counts of the given paths of the diff that the open Commit Details /
	 * Commit Comparison view is showing, as `git diff --numstat` reports them.
	 *
	 * The counts cannot be limited to the asked-for paths by a pathspec: a rename's old path would
	 * fall outside the limit, so the pair would never be made and a moved file would count as a
	 * wholesale addition. The whole diff is counted instead — the cost the eager load used to pay
	 * before the file list could render at all — and kept for the batches that follow, which
	 * settle from memory.
	 * @param repo The path of the repository.
	 * @param from The diff's left side, or null to diff `to` against its first parent (a plain commit).
	 * @param to The diff's right side.
	 * @param paths The paths to count, keyed by each file's new path.
	 * @returns The counts of the requested paths; a binary file reports null counts.
	 */
	public getCommitFileCounts(repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<GitCommitFileCountsData> {
		if (paths.length === 0) return Promise.resolve({ counts: {}, error: null });
		if ((from !== null && !isValidCommitHash(from)) || !isValidCommitHash(to)) {
			return Promise.resolve({ counts: {}, error: 'An invalid revision was requested.' });
		}
		return this.numStatCounts(repo, from, to).then((counts) => {
			const wanted: { [path: string]: GitLineCounts } = {};
			for (let i = 0; i < paths.length; i++) {
				const counted = counts[paths[i]];
				if (typeof counted !== 'undefined') wanted[paths[i]] = counted;
			}
			return { counts: wanted, error: null };
		}).catch((errorMessage) => {
			return { counts: {}, error: errorMessage };
		});
	}

	/**
	 * The numstat counts of a whole diff, keyed by each file's new path, served from the
	 * single-entry cache whenever the same diff is asked for again.
	 */
	private numStatCounts(repo: string, from: string | null, to: string): Promise<{ [path: string]: GitLineCounts }> {
		if (this.numStatCache !== null && this.numStatCache.repo === repo && this.numStatCache.from === from && this.numStatCache.to === to) {
			return Promise.resolve(this.numStatCache.counts);
		}

		// null => the commit's first parent — or, for a root commit (whose `to^` cannot be
		// resolved), the empty tree, whose files then report as added
		const base = from !== null
			? Promise.resolve(from)
			: this.spawnGit(['rev-parse', '--verify', '-q', to + '^'], repo, (stdout) => stdout.trim()).catch(() => '');
		return base.then((resolvedBase) => {
			return this.spawnGit(['diff', '--numstat', '--find-renames', '-z', resolvedBase !== '' ? resolvedBase : EMPTY_TREE, to], repo, (stdout) => {
				const counts: { [path: string]: GitLineCounts } = {};
				const fields = stdout.split('\0');
				for (let i = 0; i < fields.length && fields[i] !== '';) {
					const parts = fields[i].split('\t');
					if (parts.length !== 3) break;
					// A rename's numstat record has an empty path, followed by the two paths as separate
					// NUL-terminated fields; the new path (the last one) is what the counts are keyed by.
					const filePath = parts[2] !== '' ? parts[2] : fields[i + 2];
					const additions = parseInt(parts[0], 10);
					const deletions = parseInt(parts[1], 10);
					counts[filePath] = {
						// A binary file reports a dash, which parses to NaN and is reported as unknown
						additions: Number.isNaN(additions) ? null : additions,
						deletions: Number.isNaN(deletions) ? null : deletions
					};
					i += parts[2] !== '' ? 1 : 3;
				}
				this.numStatCache = { repo: repo, from: from, to: to, counts: counts };
				return counts;
			});
		});
	}

	/**
	 * Get the stash details for the Commit Details View.
	 *
	 * As with `getCommitDetails`, the line counts of the stash's own diff are settled afterwards
	 * through `getCommitFileCounts` (against the stash's base). The counts of the untracked files
	 * are computed here: they cannot be asked for through the same diff, and their numstat is
	 * cheap (new blobs only).
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the stash commit open in the Commit Details View.
	 * @param stash The stash.
	 * @returns The stash details.
	 */
	public getStashDetails(repo: string, commitHash: string, stash: GitCommitStash): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, stash.baseHash, commitHash),
			stash.untrackedFilesHash !== null ? this.getDiffNameStatus(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([]),
			stash.untrackedFilesHash !== null ? this.getDiffNumStat(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([])
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1], [], null);
			if (stash.untrackedFilesHash !== null) {
				generateFileChanges(results[2], results[3], null).forEach((fileChange) => {
					if (fileChange.type === GitFileStatus.Added) {
						fileChange.type = GitFileStatus.Untracked;
						results[0].fileChanges.push(fileChange);
					}
				});
			}
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the uncommitted details for the Commit Details View.
	 *
	 * Unlike a commit's details, the line counts are computed here: the diff's right side is the
	 * working tree, which cannot be cached and is usually small. An unborn HEAD (a fresh
	 * repository with no commits) cannot be diffed against at all — everything the status scan
	 * reports (untracked files) is then the whole difference.
	 * @param repo The path of the repository.
	 * @returns The uncommitted details.
	 */
	public getUncommittedDetails(repo: string): Promise<GitCommitDetailsData> {
		return this.spawnGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repo, () => true).catch(() => false).then((headExists) => {
			return Promise.all([
				headExists ? this.getDiffNameStatus(repo, 'HEAD', '') : Promise.resolve([]),
				headExists ? this.getDiffNumStat(repo, 'HEAD', '') : Promise.resolve([]),
				this.getStatus(repo)
			]).then((results) => {
				return {
					commitDetails: {
						hash: UNCOMMITTED, parents: [],
						author: '', authorEmail: '', authorDate: 0,
						committer: '', committerEmail: '', committerDate: 0, signature: null,
						body: '', fileChanges: generateFileChanges(results[0], results[1], results[2])
					},
					error: null
				};
			});
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the comparison details for the Commit Comparison View.
	 *
	 * When both sides are fixed revisions the line counts are settled afterwards through
	 * `getCommitFileCounts`; only a comparison against the working tree computes them here (see
	 * `getUncommittedDetails`).
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the comparison is from.
	 * @param toHash The commit hash the comparison is to.
	 * @returns The comparison details.
	 */
	public getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<GitCommitComparisonData> {
		const againstWorktree = toHash === UNCOMMITTED;
		return Promise.all([
			this.getDiffNameStatus(repo, fromHash, againstWorktree ? '' : toHash),
			againstWorktree ? this.getDiffNumStat(repo, fromHash, '') : Promise.resolve([]),
			againstWorktree ? this.getStatus(repo) : Promise.resolve(null)
		]).then((results) => {
			return {
				fileChanges: generateFileChanges(results[0], results[1], results[2]),
				error: null
			};
		}).catch((errorMessage) => {
			return { fileChanges: [], error: errorMessage };
		});
	}

	/**
	 * Get the contents of a file at a specific revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash specifying the revision of the file.
	 * @param filePath The path of the file relative to the repositories root.
	 * @returns The file contents, or NULL when the file is binary.
	 */
	public getCommitFile(repo: string, commitHash: string, filePath: string): Promise<string | null> {
		return this._spawnGit(['show', '--textconv', commitHash + ':' + filePath], repo, (stdout) => {
			// A NUL byte in the first 8000 bytes marks a binary file, whose contents cannot be
			// meaningfully decoded
			if (stdout.subarray(0, 8000).includes(0)) return null;
			const encoding = getConfig(repo).fileEncoding;
			return decode(stdout, encodingExists(encoding) ? encoding : 'utf8');
		});
	}

	/**
	 * Get the unified diff of a single file between two revisions (used by the Commit Comparison View).
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to ('' compares against the working tree).
	 * @param oldFilePath The relative path of the file on the from-side.
	 * @param newFilePath The relative path of the file on the to-side (differs when renamed).
	 * @returns The unified diff output.
	 */
	public getCommitFileDiff(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string) {
		if (toHash === UNCOMMITTED) toHash = '';
		const args = ['diff', '--no-color', '--find-renames', fromHash];
		if (toHash !== '') args.push(toHash);
		args.push('--');
		if (oldFilePath !== newFilePath) args.push(oldFilePath);
		args.push(newFilePath);
		return this.spawnGit(args, repo, stdout => stdout);
	}


	/* Get Data Methods - General */

	/**
	 * Get a lightweight summary (hash, author, date, full message) of each of the given commits,
	 * used by the Commit Comparison View to describe the two commits being compared.
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits to summarise.
	 * @returns A map of commit hash to summary, or NULL if an error occurred.
	 */
	public getCommitSummaries(repo: string, commitHashes: string[]): Promise<{ [hash: string]: { hash: string, author: string, email: string, date: number, message: string } } | null> {
		return this.spawnGit(['show', '--quiet', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B%x1e'].concat(commitHashes), repo, (stdout) => {
			const summaries: { [hash: string]: { hash: string, author: string, email: string, date: number, message: string } } = {};
			for (const record of stdout.replace(/\x1e\s*$/, '').split('\x1e')) {
				const parts = record.trim().split('\x1f');
				if (parts.length === 5) {
					summaries[parts[0]] = { hash: parts[0], author: parts[1], email: parts[2], date: parseInt(parts[3], 10), message: parts[4].trim() };
				}
			}
			return summaries;
		}).catch(() => null);
	}

	/**
	 * Get the subject of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The subject string, or NULL if an error occurred.
	 */
	public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', commitHash, '--'], repo, (stdout) => {
			return stdout.trim().replace(/\s+/g, ' ');
		}).then((subject) => subject, () => null);
	}

	/**
	 * Get the URL of a repositories remote.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote.
	 * @returns The URL, or NULL if an error occurred.
	 */
	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return this.spawnGit(['config', '--get', 'remote.' + remote + '.url'], repo, (stdout) => {
			return stdout.split(EOL_REGEX)[0];
		}).then((url) => url, () => null);
	}

	/**
	 * Check to see if a file has been renamed between a commit and the working tree, and return the new file path.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash where `oldFilePath` is known to have existed.
	 * @param oldFilePath The file path that may have been renamed.
	 * @returns The new renamed file path, or NULL if either: the file wasn't renamed or the Git command failed to execute.
	 */
	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string) {
		return this.getDiffNameStatus(repo, commitHash, '', 'R').then((renamed) => {
			const renamedRecordForFile = renamed.find((record) => record.oldFilePath === oldFilePath);
			return renamedRecordForFile ? renamedRecordForFile.newFilePath : null;
		}).catch(() => null);
	}

	/**
	 * Get the details of a tag.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @returns The tag details.
	 */
	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
		if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.TagDetails)) {
			return Promise.resolve({ details: null, error: constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.TagDetails, 'retrieving Tag Details') });
		}

		const ref = 'refs/tags/' + tagName;
		return this.spawnGit(['for-each-ref', ref, '--format=' + ['%(objectname)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents:signature)', '%(contents)'].join(GIT_LOG_SEPARATOR)], repo, (stdout) => {
			const data = stdout.split(GIT_LOG_SEPARATOR);
			const taggerDate = parseInt(data[3]);
			return {
				hash: data[0],
				taggerName: data[1],
				taggerEmail: data[2].substring(data[2].startsWith('<') ? 1 : 0, data[2].length - (data[2].endsWith('>') ? 1 : 0)),
				taggerDate: Number.isNaN(taggerDate) ? 0 : taggerDate,
				message: removeTrailingBlankLines(data.slice(5).join(GIT_LOG_SEPARATOR).replace(data[4], '').split(EOL_REGEX)).join('\n'),
				signed: data[4] !== ''
			};
		}).then(async (tag) => ({
			details: {
				hash: tag.hash,
				taggerName: tag.taggerName,
				taggerEmail: tag.taggerEmail,
				taggerDate: tag.taggerDate,
				message: tag.message,
				signature: tag.signed
					? await this.getTagSignature(repo, ref)
					: null
			},
			error: null
		})).catch((errorMessage) => ({
			details: null,
			error: errorMessage
		}));
	}

	/**
	 * Get the submodules of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of the paths of the submodules.
	 */
	public getSubmodules(repo: string) {
		return new Promise<string[]>(resolve => {
			fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err: NodeJS.ErrnoException | null, data: string) => {
				let submodules: string[] = [];
				if (!err) {
					let lines = data.split(EOL_REGEX), inSubmoduleSection = false, match;
					const section = /^\s*\[.*\]\s*$/, submodule = /^\s*\[submodule "([^"]+)"\]\s*$/, pathProp = /^\s*path\s+=\s+(.*)$/;

					for (let i = 0; i < lines.length; i++) {
						if (lines[i].match(section) !== null) {
							inSubmoduleSection = lines[i].match(submodule) !== null;
							continue;
						}

						if (inSubmoduleSection && (match = lines[i].match(pathProp)) !== null) {
							let root = await this.repoRoot(getPathFromUri(vscode.Uri.file(path.join(repo, getPathFromStr(match[1])))));
							if (root !== null && !submodules.includes(root)) {
								submodules.push(root);
							}
						}
					}
				}
				resolve(submodules);
			});
		});
	}


	/* Repository Info Methods */

	/**
	 * Check if there are any staged changes in the repository.
	 * @param repo The path of the repository.
	 * @returns TRUE => Staged Changes, FALSE => No Staged Changes.
	 */
	private areStagedChanges(repo: string) {
		return this.spawnGit(['diff-index', 'HEAD'], repo, (stdout) => stdout !== '').then(changes => changes, () => false);
	}

	/**
	 * Get the root of the repository containing the specified path.
	 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within a repository).
	 * @returns STRING => The root of the repository, NULL => `pathOfPotentialRepo` is not in a repository.
	 */
	public repoRoot(pathOfPotentialRepo: string) {
		return this.spawnGit(['rev-parse', '--show-toplevel'], pathOfPotentialRepo, (stdout) => getPathFromUri(vscode.Uri.file(path.normalize(stdout.trim())))).then(async (pathReturnedByGit) => {
			if (process.platform === 'win32') {
				// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
				// Attempt to replace the UNC Path with the Drive Letter.
				let driveLetterPathMatch: RegExpMatchArray | null;
				if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
					const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
					if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
						pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
					}
				}
			}
			let path = pathOfPotentialRepo;
			let first = path.indexOf('/');
			while (true) {
				if (pathReturnedByGit === path || pathReturnedByGit === await realpath(path)) return path;
				let next = path.lastIndexOf('/');
				if (first !== next && next > -1) {
					path = path.substring(0, next);
				} else {
					return pathReturnedByGit;
				}
			}
		}).catch(() => null); // null => path is not in a repo
	}


	/* Git Action Methods - Remotes */

	/**
	 * Add a new remote to a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @param url The URL of the remote.
	 * @param pushUrl The Push URL of the remote.
	 * @param fetch Fetch the remote after it is added.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['name', name, 'ref'], ['url', url, 'url'], ['pushUrl', pushUrl, 'url']);
		if (unsafeArgs !== null) return unsafeArgs;

		let status = await this.runGitCommand(['remote', 'add', name, url], repo);
		if (status !== null) return status;

		if (pushUrl !== null) {
			status = await this.runGitCommand(['remote', 'set-url', name, '--push', pushUrl], repo);
			if (status !== null) return status;
		}

		return fetch ? this.fetch(repo, name, false, false) : null;
	}

	/**
	 * Delete an existing remote from a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteRemote(repo: string, name: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['name', name, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['remote', 'remove', name], repo);
	}

	/**
	 * Edit an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param nameOld The old name of the remote.
	 * @param nameNew The new name of the remote.
	 * @param urlOld The old URL of the remote.
	 * @param urlNew The new URL of the remote.
	 * @param pushUrlOld The old Push URL of the remote.
	 * @param pushUrlNew The new Push URL of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(
			['nameOld', nameOld, 'ref'], ['nameNew', nameNew, 'ref'],
			['urlOld', urlOld, 'url'], ['urlNew', urlNew, 'url'],
			['pushUrlOld', pushUrlOld, 'url'], ['pushUrlNew', pushUrlNew, 'url']
		);
		if (unsafeArgs !== null) return unsafeArgs;

		if (nameOld !== nameNew) {
			let status = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
			if (status !== null) return status;
		}

		if (urlOld !== urlNew) {
			let args = ['remote', 'set-url', nameNew];
			if (urlNew === null) args.push('--delete', urlOld!);
			else if (urlOld === null) args.push('--add', urlNew);
			else args.push(urlNew, urlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		if (pushUrlOld !== pushUrlNew) {
			let args = ['remote', 'set-url', '--push', nameNew];
			if (pushUrlNew === null) args.push('--delete', pushUrlOld!);
			else if (pushUrlOld === null) args.push('--add', pushUrlNew);
			else args.push(pushUrlNew, pushUrlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		return null;
	}

	/**
	 * Prune an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneRemote(repo: string, name: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['name', name, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['remote', 'prune', name], repo);
	}


	/* Git Action Methods - Tags */

	/**
	 * Add a new tag to a commit.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param commitHash The hash of the commit the tag should be added to.
	 * @param type Is the tag annotated or lightweight.
	 * @param message The message of the tag (if it is an annotated tag).
	 * @param force Force add the tag, replacing an existing tag with the same name (if it exists).
	 * @returns The ErrorInfo from the executed command.
	 */
	public addTag(repo: string, tagName: string, commitHash: string, type: TagType, message: string, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['tagName', tagName, 'ref'], ['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (type === TagType.Lightweight) {
			args.push(tagName);
		} else {
			args.push(getConfig().signTags ? '-s' : '-a', tagName, '-m', message);
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Delete an existing tag from a repository.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param deleteOnRemote The name of the remote to delete the tag on, or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['tagName', tagName, 'ref'], ['deleteOnRemote', deleteOnRemote, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;

		if (deleteOnRemote !== null) {
			let status = await this.runGitCommand(['push', deleteOnRemote, '--delete', tagName], repo);
			if (status !== null && !status.includes('remote ref does not exist')) return status;
			await this._spawnGit(['update-ref', '-d', 'refs/remotes/' + deleteOnRemote + '/tags/' + tagName], repo, () => {}, true);
		}
		let status = await this.runGitCommand(['tag', '-d', tagName], repo);

		const remotes = await this.getRemotes(repo);
		for (const remote of remotes) {
			if (remote !== deleteOnRemote) {
				await this._spawnGit(['update-ref', '-d', 'refs/remotes/' + remote + '/tags/' + tagName], repo, () => {}, true);
			}
		}

		if (status !== null && status.includes('not found')) return null;
		return status;
	}


	/* Git Action Methods - Remote Sync */

	/**
	 * Fetch from the repositories remote(s).
	 * @param repo The path of the repository.
	 * @param remote The remote to fetch, or NULL (fetch all remotes).
	 * @param prune Is pruning enabled.
	 * @param pruneTags Should tags be pruned.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['remote', remote, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['fetch', remote === null ? '--all' : remote];

		if (prune) {
			args.push('--prune');
		}
		if (pruneTags) {
			if (!prune) {
				return Promise.resolve('In order to Prune Tags, pruning must also be enabled when fetching from ' + (remote !== null ? 'a remote' : 'remote(s)') + '.');
			} else if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.FetchAndPruneTags)) {
				return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.FetchAndPruneTags, 'pruning tags when fetching'));
			}
			args.push('--prune-tags');
		}

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to a remote.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remote The remote to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['push'];
		args.push(remote, branchName);
		if (setUpstream) args.push('--set-upstream');
		if (mode !== GitPushBranchMode.Normal) args.push('--' + mode);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to multiple remotes.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remotes The remotes to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: string[], setUpstream: boolean, mode: GitPushBranchMode): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/**
	 * Push a tag to remote(s).
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag to push.
	 * @param remotes The remote(s) to push the tag to.
	 * @param commitHash The commit hash the tag is on.
	 * @param skipRemoteCheck Skip checking that the tag is on each of the `remotes`.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushTag(repo: string, tagName: string, remotes: string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['tagName', tagName, 'ref'], ['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return [unsafeArgs];

		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
		}

		const unsafeRemotes = remotes.filter((remote) => !isSafeRefName(remote));
		if (unsafeRemotes.length > 0) {
			return ['Invalid reference name was provided for "remotes"'];
		}

		if (!skipRemoteCheck) {
			const remotesContainingCommit = await this.getRemotesContainingCommit(repo, commitHash, remotes).catch(() => remotes);
			const remotesNotContainingCommit = remotes.filter((remote) => !remotesContainingCommit.includes(remote));
			if (remotesNotContainingCommit.length > 0) {
				return [ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote + JSON.stringify(remotesNotContainingCommit)];
			}
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.runGitCommand(['push', remotes[i], tagName], repo);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}


	/* Git Action Methods - Branches */

	/**
	 * Checkout a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to checkout.
	 * @param remoteBranch The name of the remote branch to check out (if not NULL).
	 * @returns The ErrorInfo from the executed command.
	 */
	public async checkoutBranch(repo: string, branchName: string, remoteBranch: string | null, confirmed: boolean = false): Promise<ErrorInfo | LossWarning> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remoteBranch', remoteBranch, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;
		if (!confirmed) {
			const warning = await this.detachedCommitsLossWarning(repo);
			if (warning !== null) return warning;
		}

		let args = ['checkout'];
		if (remoteBranch === null) args.push(branchName);
		else args.push('-b', branchName, remoteBranch);

		return this.runGitCommand(args, repo);
	}

	/**
	 * The data-loss warning for moving HEAD away from detached commits that no ref or stash
	 * keeps reachable, or NULL when nothing can be lost. Such commits are left behind,
	 * recoverable from the local reflog only until git gc prunes them.
	 * @param anchoredAt A revision that, when it is the current HEAD, anchors the detached
	 *                   commits (a branch being created right at HEAD): nothing is stranded.
	 */
	private async detachedCommitsLossWarning(repo: string, anchoredAt: string | null = null): Promise<LossWarning | null> {
		if (anchoredAt !== null) {
			const head = await this.spawnGit(['rev-parse', 'HEAD'], repo, (stdout) => stdout.trim()).catch(() => '');
			if (head !== '' && head === anchoredAt) return null;
		}
		const count = await this.countDetachedOnlyCommits(repo);
		if (count <= 0) return null;
		const one = count === 1;
		return {
			message: 'HEAD is currently detached with <b>' + count + ' commit' + (one ? '' : 's') + '</b> that no branch, tag, remote or stash keeps reachable. Switching now leaves ' + (one ? 'it' : 'them') + ' behind, recoverable from the local reflog only until git gc prunes ' + (one ? 'it' : 'them') + '. Create a branch at HEAD to keep ' + (one ? 'it' : 'them') + ' (a stash made on ' + (one ? 'it' : 'them') + ' works too).'
		};
	}

	/**
	 * Count the commits that moving HEAD away from its current position would leave behind:
	 * commits reachable from HEAD but from no branch, tag, remote or stash. Non-zero only while
	 * HEAD is detached and has commits of its own.
	 */
	private async countDetachedOnlyCommits(repo: string): Promise<number> {
		// A stash keeps its base commit's whole history reachable exactly as a branch does, so
		// every stash entry counts as an anchor — not just the refs/stash tip: older entries live
		// only in its reflog. (--all cannot stand in for the explicit roots: it includes HEAD
		// itself, which would silence the guard entirely.) `git stash list` exits 0 with no
		// output when nothing is stashed, so the fallback only masks a git that failed to run.
		const stashRoots = await this.spawnGit(['stash', 'list', '--format=%H'], repo, (stdout) =>
			stdout.split(EOL_REGEX).map((line) => line.trim()).filter((line) => line !== '')
		).catch(() => <string[]>[]);
		const count = await this.spawnGit(['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes', ...stashRoots, '--count'], repo, (stdout) =>
			parseInt(stdout, 10)
		).catch(() => 0);
		return Number.isNaN(count) ? 0 : count;
	}

	/**
	 * Create a branch at a commit.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param commitHash The hash of the commit the branch should be created at.
	 * @param checkout Check out the branch after it is created.
	 * @param force Force create the branch, replacing an existing branch with the same name (if it exists).
	 * @returns The ErrorInfo's from the executed command(s).
	 */
	public async createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean, confirmed: boolean = false): Promise<(ErrorInfo | LossWarning)[]> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return [unsafeArgs];

		// `checkout -b` moves HEAD to the new branch: when it points anywhere other than the
		// current HEAD, a detached position's own commits are stranded exactly as by a checkout.
		// The guard must run before ANY command whatever `force` is: with force the checkout runs
		// as a second step, and a warning returned there would sit at statuses[1] — behind the
		// successful branch creation — where the view's warning forwarding (which reads the first
		// element) would miss it and show the warning object as an error string instead.
		if (checkout && !confirmed) {
			const warning = await this.detachedCommitsLossWarning(repo, commitHash);
			if (warning !== null) return [warning];
		}

		const args = [];
		if (checkout && !force) {
			args.push('checkout', '-b');
		} else {
			args.push('branch');
			if (force) {
				args.push('-f');
			}
		}
		args.push(branchName, commitHash);

		const statuses: (ErrorInfo | LossWarning)[] = [await this.runGitCommand(args, repo)];
		if (statuses[0] === null && checkout && force) {
			// Already confirmed: the detached-commits guard above has assessed this very checkout
			statuses.push(await this.checkoutBranch(repo, branchName, null, true));
		}
		return statuses;
	}

	/**
	 * Delete a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param force Should force the branch to be deleted (even if not merged).
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteBranch(repo: string, branchName: string, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['branch', force ? '-D' : '-d', branchName], repo);
	}

	/**
	 * Delete a remote branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param remote The name of the remote to delete the branch on.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;

		let remoteStatus = await this.runGitCommand(['push', remote, '--delete', branchName], repo);
		if (remoteStatus !== null && (new RegExp('remote ref does not exist', 'i')).test(remoteStatus)) {
			let trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', remote + '/' + branchName], repo);
			return trackingBranchStatus === null ? null : 'Branch does not exist on the remote, deleting the remote tracking branch ' + remote + '/' + branchName + '.\n' + trackingBranchStatus;
		}
		return remoteStatus;
	}

	/**
	 * Fetch a remote branch into a local branch.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote containing the remote branch.
	 * @param remoteBranch The name of the remote branch.
	 * @param localBranch The name of the local branch.
	 * @param force Force fetch the remote branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['remote', remote, 'ref'], ['remoteBranch', remoteBranch, 'ref'], ['localBranch', localBranch, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;

		const currentBranch = await this.spawnGit(['symbolic-ref', '--short', 'HEAD'], repo, (stdout) => stdout.trim());

		if (currentBranch === localBranch) {
			if (!force) {
				return this.runGitCommand(['pull', remote, remoteBranch], repo);
			}

			const fetchArgs = ['fetch', remote, remoteBranch];
			const fetchResult = await this.runGitCommand(fetchArgs, repo);
			if (fetchResult !== null) {
				return fetchResult;
			}
			return this.runGitCommand(['reset', '--hard', remote + '/' + remoteBranch], repo);
		}

		// If the branch is not checked out, we can use fetch
		const args = ['fetch'];
		if (force) {
			args.push('-f');
		}
		args.push(remote, remoteBranch + ':' + localBranch);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Pull a remote branch into the current branch.
	 * @param repo The path of the repository.
	 * @param branchName The name of the remote branch.
	 * @param remote The name of the remote containing the remote branch.
	 * @param createNewCommit Is `--no-ff` enabled if a merge is required.
	 * @param squash Is `--squash` enabled if a merge is required.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['pull', remote, branchName], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((pullStatus) => {
			return pullStatus === null && squash
				? this.commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, MergeActionOn.Branch, config.squashPullMessageFormat, config.signCommits)
				: pullStatus;
		});
	}

	/**
	 * Rename a branch in a repository.
	 * @param repo The path of the repository.
	 * @param oldName The old name of the branch.
	 * @param newName The new name of the branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public renameBranch(repo: string, oldName: string, newName: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['oldName', oldName, 'ref'], ['newName', newName, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['branch', '-m', oldName, newName], repo);
	}


	/* Git Action Methods - Branches & Commits */

	/**
	 * Merge a branch or commit into the current branch.
	 * @param repo The path of the repository.
	 * @param obj The object to be merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param createNewCommit Is `--no-ff` enabled.
	 * @param squash Is `--squash` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public merge(repo: string, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, squash: boolean, noCommit: boolean) {
		const unsafeArgs = actionOn === MergeActionOn.Commit
			? DataSource.checkUnsafeGitArgs(['obj', obj, 'hash'])
			: DataSource.checkUnsafeGitArgs(['obj', obj, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['merge', obj], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (noCommit) {
			args.push('--no-commit');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((mergeStatus) => {
			return mergeStatus === null && squash && !noCommit
				? this.commitSquashIfStagedChangesExist(repo, obj, actionOn, config.squashMergeMessageFormat, config.signCommits)
				: mergeStatus;
		});
	}

	/**
	 * Rebase the current branch on a branch or commit.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @param ignoreDate Is `--ignore-date` enabled.
	 * @param interactive Should the rebase be performed interactively.
	 * @returns The ErrorInfo from the executed command.
	 */
	public rebase(repo: string, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean) {
		const unsafeArgs = actionOn === RebaseActionOn.Branch
			? DataSource.checkUnsafeGitArgs(['obj', obj, 'ref'])
			: DataSource.checkUnsafeGitArgs(['obj', obj, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		if (interactive) {
			// The object is safely quoted so that it cannot escape the argument in the shell
			// command that is sent to the integrated terminal.
			return this.openGitTerminal(
				repo,
				'rebase --interactive ' + (getConfig().signCommits ? '-S ' : '') + (actionOn === RebaseActionOn.Branch ? quoteShellArg(obj) : obj),
				'Rebase on "' + (actionOn === RebaseActionOn.Branch ? obj : abbrevCommit(obj)) + '"'
			);
		} else {
			const args = ['rebase', obj];
			if (ignoreDate) {
				args.push('--ignore-date');
			}
			if (getConfig().signCommits) {
				args.push('-S');
			}
			return this.runGitCommand(args, repo);
		}
	}


	/* Git Action Methods - Branches & Tags */

	/**
	 * Create an archive of a repository at a specific reference, and save to disk.
	 * @param repo The path of the repository.
	 * @param ref The reference of the revision to archive.
	 * @param outputFilePath The file path that the archive should be saved to.
	 * @param type The type of archive.
	 * @returns The ErrorInfo from the executed command.
	 */
	public archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip') {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['ref', ref, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
	}


	/* Git Action Methods - Commits */

	/**
	 * Checkout a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to check out.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async checkoutCommit(repo: string, commitHash: string, confirmed: boolean = false): Promise<ErrorInfo | LossWarning> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return unsafeArgs;
		if (!confirmed) {
			const warning = await this.detachedCommitsLossWarning(repo);
			if (warning !== null) return warning;
		}

		return this.runGitCommand(['checkout', commitHash], repo);
	}

	/**
	 * Cherrypick a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to be cherry picked.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @param recordOrigin Is `-x` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to drop.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommit(repo: string, commitHash: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['rebase'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push('--onto', commitHash + '^', commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to a specified commit.
	 * @param repo The path of the repository.
	 * @param commit The hash of the commit that the current branch should be reset to.
	 * @param resetMode The mode of the reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetToCommit(repo: string, commit: string, resetMode: GitResetMode) {
		if (commit !== 'HEAD') {
			// 'HEAD' is the sentinel used to reset uncommitted changes, and isn't a commit hash
			const unsafeArgs = DataSource.checkUnsafeGitArgs(['commit', commit, 'hash']);
			if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);
		}

		return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
	}

	/**
	 * Revert a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to revert.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @returns The ErrorInfo from the executed command.
	 */
	public revertCommit(repo: string, commitHash: string, parentIndex: number) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['revert', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Undo the last commit in a repository (soft reset to HEAD^).
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public undoLastCommit(repo: string) {
		return this.runGitCommand(['reset', '--soft', 'HEAD^'], repo);
	}

	/**
	 * Amend the last commit in a repository, keeping the existing commit message and staged changes.
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public amendLastCommit(repo: string): Promise<ErrorInfo> {
		const args = ['commit', '--amend', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to its upstream (remote tracking) branch, keeping all changes staged (soft reset).
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetCurrentBranchToRemote(repo: string): Promise<ErrorInfo> {
		return this.runGitCommand(['reset', '--soft', '@{upstream}'], repo);
	}

	/**
	 * Get the name of the upstream (remote tracking) branch of the current branch, or NULL if it has none.
	 * @param repo The path of the repository.
	 */
	public async getCurrentBranchUpstream(repo: string): Promise<string | null> {
		try {
			return await this.spawnGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repo, (stdout: string) => stdout.trim());
		} catch (_) {
			return null;
		}
	}

	/**
	 * Edit a commit message using git commit --amend.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to edit.
	 * @param message The new commit message.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editCommitMessage(repo: string, commitHash: string, message: string): Promise<ErrorInfo> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return unsafeArgs;

		try {
			const headCommit = await this.spawnGit(['rev-parse', 'HEAD'], repo, (stdout) => stdout.trim());

			if (headCommit === commitHash) {
				const args = ['commit', '--amend', '-m', message];
				if (getConfig().signCommits) {
					args.push('-S');
				}
				return this.runGitCommand(args, repo);
			} else {
				return 'Editing commit messages for non-HEAD commits is not yet supported.';
			}
		} catch (error) {
			return error as ErrorInfo;
		}
	}


	/* Git Action Methods - Config */

	/**
	 * Set a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be set.
	 * @param value The value to be set.
	 * @param location The location where the configuration value should be set.
	 * @returns The ErrorInfo from the executed command.
	 */
	public setConfigValue(repo: string, key: GitConfigKey, value: string, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, key, value], repo);
	}

	/**
	 * Unset a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be unset.
	 * @param location The location where the configuration value should be unset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public unsetConfigValue(repo: string, key: GitConfigKey, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, '--unset-all', key], repo);
	}


	/* Git Action Methods - Uncommitted */

	/**
	 * Clean the untracked files in a repository.
	 * @param repo The path of the repository.
	 * @param directories Is `-d` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cleanUntrackedFiles(repo: string, directories: boolean) {
		return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
	}


	/* Git Action Methods - File */

	/**
	 * Reset a file to the specified revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit to reset the file to.
	 * @param filePath The file to reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['checkout', commitHash, '--', filePath], repo);
	}


	/* Git Action Methods - Stash */

	/**
	 * Apply a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public applyStash(repo: string, selector: string, reinstateIndex: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['stash', 'apply'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch from a stash.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param branchName The name of the branch to be created.
	 * @returns The ErrorInfo from the executed command.
	 */
	public branchFromStash(repo: string, selector: string, branchName: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash'], ['branchName', branchName, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
	}

	/**
	 * Drop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropStash(repo: string, selector: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['stash', 'drop', selector], repo);
	}

	/**
	 * Pop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public popStash(repo: string, selector: string, reinstateIndex: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['stash', 'pop'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push the uncommitted changes to a stash.
	 * @param repo The path of the repository.
	 * @param message The message of the stash.
	 * @param includeUntracked Is `--include-untracked` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
		if (this.gitExecutable === null) {
			return Promise.resolve(UNABLE_TO_FIND_GIT_MSG);
		} else if (!doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.PushStash)) {
			return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.PushStash));
		}

		let args = ['stash', 'push'];
		if (includeUntracked) args.push('--include-untracked');
		if (message !== '') args.push('--message', message);
		return this.runGitCommand(args, repo);
	}


	/* Public Utils */

	/**
	 * Opens an external directory diff for the specified commits.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the diff is from.
	 * @param toHash The commit hash the diff is to.
	 * @param isGui Is the external diff tool GUI based.
	 * @returns The ErrorInfo from the executed command.
	 */
	public openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean) {
		// The hashes are interpolated into a shell command sent to the integrated terminal when the
		// external diff tool is not GUI based, so they must be validated to prevent command injection.
		const unsafeArgs = DataSource.checkUnsafeGitArgs(
			['fromHash', fromHash === UNCOMMITTED ? null : fromHash, 'hash'],
			['toHash', toHash === UNCOMMITTED ? null : toHash, 'hash']
		);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				const args = ['difftool', '--dir-diff'];
				const config = getConfig(repo);
				if (config.extDiffToolArgs && config.extDiffToolArgs.length > 0) {
					args.push(...config.extDiffToolArgs);
				}
				if (isGui) {
					args.push('-g');
				}
				if (fromHash === toHash) {
					if (toHash === UNCOMMITTED) {
						args.push('HEAD');
					} else {
						args.push(toHash + '^..' + toHash);
					}
				} else {
					if (toHash === UNCOMMITTED) {
						args.push(fromHash);
					} else {
						args.push(fromHash + '..' + toHash);
					}
				}
				if (isGui) {
					this.logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
					this.runGitCommand(args, repo).then((errorInfo) => {
						this.logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
						if (errorInfo !== null) {
							const errorMessage = errorInfo.replace(EOL_REGEX, ' ');
							this.logger.logError(errorMessage);
							showErrorMessage(errorMessage);
						}
					});
				} else {
					openGitTerminal(repo, this.gitExecutable.path, args.join(' '), 'Open External Directory Diff');
				}
				setTimeout(() => resolve(null), 1500);
			}
		});
	}

	/**
	 * Open a new terminal, set up the Git executable, and optionally run a command.
	 * @param repo The path of the repository.
	 * @param command The command to run.
	 * @param name The name for the terminal.
	 * @returns The ErrorInfo from opening the terminal.
	 */
	public openGitTerminal(repo: string, command: string | null, name: string) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				openGitTerminal(repo, this.gitExecutable.path, command, name);
				setTimeout(() => resolve(null), 1000);
			}
		});
	}


	/* Private Data Providers */

	/**
	 * Get the full commit message bodies of a batch of commits, on demand (the commit list only
	 * carries subjects, so bodies are only fetched when they are actually displayed).
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits (validated, as they arrive from the webview).
	 * @returns A hash -> full message body mapping.
	 */
	public getCommitBodies(repo: string, commitHashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		const hashes = commitHashes.filter((hash) => isValidCommitHash(hash));
		if (hashes.length === 0) return Promise.resolve({});
		const args = ['-c', 'log.showSignature=false', 'log', '--no-walk', '--format=%H%x1f%B%x1e', ...hashes];
		return this.spawnGit(args, repo, (stdoutBuf) => {
			const bodies: { [hash: string]: string } = {};
			const text = stdoutBuf.toString();
			for (let record of text.split('\x1e')) {
				record = record.replace(/^\n/, ''); // git terminates each formatted entry with a newline
				const sep = record.indexOf('\x1f');
				if (sep <= 0) continue;
				bodies[record.substring(0, sep)] = record.substring(sep + 1).replace(/\n$/, '');
			}
			return bodies;
		});
	}

	/**
	 * Get the base commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @returns The base commit details.
	 */
	private getCommitDetailsBase(repo: string, commitHash: string) {
		return this.spawnGit(['-c', 'log.showSignature=false', 'show', '--quiet', commitHash, '--format=' + this.gitFormatCommitDetails], repo, (stdout): DeepWriteable<GitCommitDetails> => {
			const commitInfo = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: commitInfo[0],
				parents: commitInfo[1] !== '' ? commitInfo[1].split(' ') : [],
				author: commitInfo[2],
				authorEmail: commitInfo[3],
				authorDate: parseInt(commitInfo[4]),
				committer: commitInfo[5],
				committerEmail: commitInfo[6],
				committerDate: parseInt(commitInfo[7]),
				signature: ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(commitInfo[8])
					? {
						key: commitInfo[10].trim(),
						signer: commitInfo[9].trim(),
						status: <GitSignatureStatus>commitInfo[8]
					}
					: null,
				body: removeTrailingBlankLines(commitInfo.slice(11).join(GIT_LOG_SEPARATOR).split(EOL_REGEX)).join('\n'),
				fileChanges: []
			};
		});
	}

	/**
	 * Get the configuration list of a repository.
	 * @param repo The path of the repository.
	 * @param location The location of the configuration to be listed.
	 * @returns A set of key-value pairs of Git configuration records.
	 */
	private getConfigList(repo: string, location?: GitConfigLocation): Promise<GitConfigSet> {
		const args = ['--no-pager', 'config', '--list', '-z', '--includes'];
		if (location) {
			args.push('--' + location);
		}

		return this.spawnGit(args, repo, (stdout) => {
			const configs: GitConfigSet = {}, keyValuePairs = stdout.split('\0');
			const numPairs = keyValuePairs.length - 1;
			let comps, key;
			for (let i = 0; i < numPairs; i++) {
				comps = keyValuePairs[i].split(EOL_REGEX);
				key = comps.shift()!;
				configs[key] = comps.join('\n');
			}
			return configs;
		}).catch((errorMessage) => {
			if (typeof errorMessage === 'string') {
				const message = errorMessage.toLowerCase();
				if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
					// If the Git command failed due to the configuration file not existing, return an empty list instead of throwing the exception
					return {};
				}
			} else {
				errorMessage = 'An unexpected error occurred while spawning the Git child process.';
			}
			throw errorMessage;
		});
	}

	/**
	 * Get the diff `--name-status` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--name-status` records.
	 */
	private getDiffNameStatus(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--name-status', filter).then((output) => {
			let records: DiffNameStatusRecord[] = [], i = 0;
			while (i < output.length && output[i] !== '') {
				let type = <GitFileStatus>output[i][0];
				if (type === GitFileStatus.Added || type === GitFileStatus.Deleted || type === GitFileStatus.Modified) {
					// Add, Modify, or Delete
					let p = getPathFromStr(output[i + 1]);
					records.push({ type: type, oldFilePath: p, newFilePath: p });
					i += 2;
				} else if (type === GitFileStatus.Renamed) {
					// Rename
					records.push({ type: type, oldFilePath: getPathFromStr(output[i + 1]), newFilePath: getPathFromStr(output[i + 2]) });
					i += 3;
				} else {
					break;
				}
			}
			return records;
		});
	}

	/**
	 * Get the diff `--numstat` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--numstat` records.
	 */
	private getDiffNumStat(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--numstat', filter).then((output) => {
			let records: DiffNumStatRecord[] = [], i = 0;
			while (i < output.length && output[i] !== '') {
				let fields = output[i].split('\t');
				if (fields.length !== 3) break;
				// A binary file reports a dash for both counts, which parses to NaN
				const additions = parseInt(fields[0]), deletions = parseInt(fields[1]);
				if (fields[2] !== '') {
					// Add, Modify, or Delete
					records.push({ filePath: getPathFromStr(fields[2]), additions: isNaN(additions) ? null : additions, deletions: isNaN(deletions) ? null : deletions });
					i += 1;
				} else {
					// Rename
					records.push({ filePath: getPathFromStr(output[i + 2]), additions: isNaN(additions) ? null : additions, deletions: isNaN(deletions) ? null : deletions });
					i += 3;
				}
			}
			return records;
		});
	}

	/**
	 * Count the commits reachable from the currently shown refs but NOT from the given hash, i.e.
	 * the number of commits newer than it. Used by the webview to jump directly to a pinned commit
	 * with a single loadCommits request instead of paging through the history. The count
	 * deliberately ignores the author / path filters, so it is an upper bound of the commit's
	 * position in the view — loading this many commits is always sufficient to include it.
	 * @param repo The path of the repository.
	 * @param branches The currently shown branches, or NULL (show all).
	 * @param hash The full hash of the commit to jump to.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Are commits mentioned by reflogs shown.
	 * @returns The number of commits before the hash, or NULL if the hash is unknown to Git.
	 */
	public countCommitsBefore(repo: string, branches: ReadonlyArray<string> | null, hash: string, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean): Promise<number | null> {
		const refs = branches === null ? null : branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
		const args = ['rev-list', '--count'];
		if (refs !== null) {
			args.push(...refs);
		} else {
			args.push('--branches', '--tags');
			if (showRemoteBranches) args.push('--remotes');
			if (includeCommitsMentionedByReflogs) args.push('--reflog');
			args.push('HEAD');
		}
		args.push('^' + hash);
		return this.spawnGit(args, repo, (stdout) => {
			const count = parseInt(stdout.trim(), 10);
			return isNaN(count) ? null : count;
		}).catch(() => <number | null>null);
	}

	/**
	 * Get the raw commits in a repository.
	 * @param repo The path of the repository.
	 * @param refs The list of branch/tag heads to display, or NULL (show all).
	 * @param num The maximum number of commits to return.
	 * @param includeTags Include commits only referenced by tags.
	 * @param includeRemotes Include remote branches.
	 * @param includeCommitsMentionedByReflogs Include commits mentioned by reflogs.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @param remotes An array of the known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param gerritRefs The list of Gerrit change refs allowed into the graph (NULL => Gerrit integration disabled). Only used when showing all refs.
	 * @returns An array of commits.
	 */
	private getLog(repo: string, refs: ReadonlyArray<string> | null, authors: ReadonlyArray<string> | null, num: number, includeTags: boolean, includeRemotes: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, order: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>, gerritRefs: ReadonlyArray<string> | null, filterPath: string | null = null) {
		const args = ['-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + this.gitFormatLog, '--' + order + '-order', '-z'];
		if (onlyFollowFirstParent) {
			args.push('--first-parent');
		}
		if (authors !== null) {
			for (let i = 0; i < authors.length; i++) {
				args.push(`--author=${authors[i]} <`);
			}
		}
		if (refs !== null) {
			for (let i = 0; i < refs.length; i++) {
				args.push(refs[i]);
			}
		} else {
			// Show All
			args.push('--branches');
			if (includeTags) args.push('--tags');
			if (includeCommitsMentionedByReflogs) args.push('--reflog');
			if (includeRemotes) {
				if (hideRemotes.length === 0) {
					// NOTE: --exclude patterns are matched relative to refs/remotes/ when combined with --remotes,
					// so this pattern must NOT include the refs/remotes/ prefix (a trailing /* matches everything below)
					args.push('--exclude=*/changes/*', '--remotes');
				} else {
					remotes.filter((remote) => !hideRemotes.includes(remote)).forEach((remote) => {
						// NOTE: in contrast, --exclude patterns paired with --glob are matched against the full refname
						args.push('--exclude=refs/remotes/' + remote + '/changes/*', '--glob=refs/remotes/' + remote);
					});
				}
			}
			// Add the unique list of base hashes of stashes, so that commits only referenced by stashes are displayed
			const stashBaseHashes = stashes.map((stash) => stash.baseHash);
			stashBaseHashes.filter((hash, index) => stashBaseHashes.indexOf(hash) === index).forEach((hash) => args.push(hash));

			args.push('HEAD');
		}
		// Explicitly allow the (already filtered) Gerrit change refs into the graph,
		// regardless of whether all refs or a specific set of branches is being shown
		if (gerritRefs !== null) {
			for (const ref of gerritRefs) args.push(ref);
		}
		if (filterPath !== null && filterPath !== '') {
			// Show commits that modified the file(s) at the filter path (git pathspec syntax is
			// supported), from all parents across all branches (--full-history). Without
			// --simplify-merges, git's default history simplification prints the ORIGINAL parent
			// hashes of each shown commit (which may refer to commits that are themselves hidden,
			// breaking the graph into disconnected fragments); --simplify-merges instead rewrites
			// each shown commit's parents to its nearest shown ancestors, so the hidden commits
			// are collapsed while the graph stays connected and the branch structure is preserved
			args.push('--full-history', '--simplify-merges');
		}
		args.push('--');
		// The filter paths are already after the `--` pathspec separator, so they cannot be
		// misinterpreted as git options. Multiple comma-separated paths (as produced by filtering
		// by multiple selected files) become separate pathspecs: commits modifying ANY of them are
		// shown. Whitespace around each path is trimmed (e.g. "a, b" typed in the filter dialog)
		if (filterPath !== null && filterPath !== '') {
			args.push(...filterPath.split(',').map((p) => p.trim()).filter((p) => p !== ''));
		}

		return this.spawnGit(args, repo, (stdoutBuf) => {
			const text = stdoutBuf.toString().replace(/\0$/, ''); // trim trailing NUL
			const records = text.split('\0');
			const commits: GitCommitRecord[] = [];
			for (const rec of records) {
				const parts = rec.split(GIT_LOG_SEPARATOR);
				// parts = [hash, parents, author, email, date, subject]
				if (parts.length < 6) continue;
				commits.push({
					hash: parts[0],
					parents: parts[1] ? parts[1].split(' ') : [],
					author: parts[2],
					email: parts[3],
					date: parseInt(parts[4], 10),
					message: parts.slice(5).join(GIT_LOG_SEPARATOR)
				});
			}
			return commits;
		});
	}

	/**
	 * Get the references in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showRemoteHeads Are remote heads shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @param showChangeRefs Should Gerrit change refs (refs/remotes/<remote>/changes/*) be displayed as remote branch refs.
	 * @returns The references data.
	 */
	private getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: ReadonlyArray<string>, showChangeRefs: boolean = false) {
		return this.readRefs(repo, { showRemoteBranches: showRemoteBranches, showRemoteHeads: showRemoteHeads, hideRemotes: hideRemotes, showChangeRefs: showChangeRefs }).then((snapshot) => snapshot.refData);
	}

	/**
	 * Read every ref of a repository that the Git Graph View needs, in a single pass, and cache the
	 * result for a short period so that the `loadRepoInfo` and `loadCommits` requests of one view
	 * load share it instead of each scanning the repository's refs again.
	 *
	 * The refs are the dominant cost of opening the view on a large repository (particularly a
	 * Gerrit one, where `refs/remotes/<remote>/changes/*` can hold tens of thousands of refs), so
	 * the scan is kept as narrow as Git allows - see `loadRefs` for the details.
	 * @param repo The path of the repository.
	 * @param options The options determining which refs are returned.
	 * @returns The refs of the repository.
	 */
	private readRefs(repo: string, options: RefReadOptions): Promise<GitRefSnapshot> {
		const key = JSON.stringify([options.showRemoteBranches, options.showRemoteHeads, options.showChangeRefs, options.hideRemotes]);
		const now = new Date().getTime();
		const cached = this.refSnapshotCache.get(repo);
		if (cached !== undefined && cached.key === key && cached.expiresAt > now) {
			return cached.promise;
		}

		const promise = this.loadRefs(repo, options).catch((error) => {
			// Don't cache failures (they may be transient): allow the next call to retry
			if (this.refSnapshotCache.get(repo)?.promise === promise) this.refSnapshotCache.delete(repo);
			throw error;
		});
		this.refSnapshotCache.set(repo, { key: key, expiresAt: now + REF_SNAPSHOT_CACHE_MS, promise: promise });
		return promise;
	}

	/**
	 * Invalidate the cached refs of a repository (e.g. because a Git action was run, or a file in
	 * its `.git` directory changed), so that the next `readRefs` call reloads them from Git.
	 * @param repo The path of the repository (or NULL to clear the cache of all repositories).
	 */
	public invalidateRefCache(repo: string | null) {
		if (repo === null) {
			this.refSnapshotCache.clear();
		} else {
			this.refSnapshotCache.delete(repo);
		}
	}

	/**
	 * Read every ref of a repository that the Git Graph View needs.
	 *
	 * Git's ref iteration cost is driven by how much of the ref namespace it is asked to walk, and
	 * by whether it has to open the object that each ref points at (peeling). Both are minimised:
	 *
	 * - `show-ref --heads --tags -d --head` reads HEAD, the local branches and the local tags. Even
	 *   in a repository with tens of thousands of refs this stays in the low milliseconds, because
	 *   `refs/heads/` and `refs/tags/` are contiguous prefixes that Git can seek straight to. `-d`
	 *   peels the annotated tags, which is what lets their commits carry the tag label.
	 * - `for-each-ref refs/remotes/` reads the remote-tracking refs WITHOUT peeling. This is the
	 *   one unavoidably broad scan, and not peeling it is what makes it affordable: asking Git to
	 *   peel every remote ref (as a plain `show-ref -d` over the whole namespace does) costs an
	 *   object lookup per ref, which is several times more expensive than the scan itself.
	 * - The rare remote TAG refs (`refs/remotes/<remote>/tags/*`, only created by an explicit fetch
	 *   refspec) are peeled afterwards by a single batched `rev-parse`, so the common case pays
	 *   nothing for them.
	 *
	 * @param repo The path of the repository.
	 * @param options The options determining which refs are returned.
	 * @returns The refs of the repository.
	 */
	private async loadRefs(repo: string, options: RefReadOptions): Promise<GitRefSnapshot> {
		const [local, remoteRefs, branchHead] = await Promise.all([
			// HEAD + the local branches + the (peeled) local tags
			this.spawnGit(['show-ref', '--heads', '--tags', '-d', '--head'], repo, (stdout) => stdout),
			// The remote-tracking refs (unpeeled)
			options.showRemoteBranches
				? this.spawnGit(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/'], repo, (stdout) => stdout)
				: Promise.resolve(''),
			// The name of the checked-out branch (NULL when HEAD is detached). A constant-time
			// lookup that runs in parallel with the ref scans, so it never adds to the wall time.
			this.spawnGit(['symbolic-ref', '-q', '--short', 'HEAD'], repo, (stdout) => stdout.trim() || null).catch(() => null)
		]);

		const refData: GitRefData = { head: null, heads: [], tags: [], remotes: [] };
		const branches: string[] = [];
		const tagNames: string[] = [];

		/* HEAD, the local branches and the local tags */
		const localLines = local.split(EOL_REGEX);
		for (let i = 0; i < localLines.length; i++) {
			const separator = localLines[i].indexOf(' ');
			if (separator === -1) continue;

			const hash = localLines[i].substring(0, separator);
			const ref = localLines[i].substring(separator + 1);

			if (ref.startsWith('refs/heads/')) {
				const name = ref.substring(11);
				refData.heads.push({ hash: hash, name: name });
				branches.push(name);
			} else if (ref.startsWith('refs/tags/')) {
				const annotated = ref.endsWith('^{}');
				const name = annotated ? ref.substring(10, ref.length - 3) : ref.substring(10);
				refData.tags.push({ hash: hash, name: name, annotated: annotated });
				// The peeled record of an annotated tag repeats a name that was already listed
				if (!annotated) tagNames.push(name);
			} else if (ref === 'HEAD') {
				refData.head = hash;
			}
		}

		/* The remote-tracking refs */
		const hideRemotePatterns = options.hideRemotes.map((remote) => 'refs/remotes/' + remote + '/');
		const remoteTagRefs: string[] = [];
		const remoteTagIndexes: number[] = [];
		const remoteLines = remoteRefs.split(EOL_REGEX);
		for (let i = 0; i < remoteLines.length; i++) {
			const separator = remoteLines[i].indexOf(' ');
			if (separator === -1) continue;

			const hash = remoteLines[i].substring(0, separator);
			const ref = remoteLines[i].substring(separator + 1);
			if (!ref.startsWith('refs/remotes/')) continue;
			if (hideRemotePatterns.some((pattern) => ref.startsWith(pattern)) || (!options.showRemoteHeads && ref.endsWith('/HEAD'))) continue;

			const remoteRef = ref.substring(13);
			const tagsIndex = remoteRef.indexOf('/tags/');
			const changesIndex = remoteRef.indexOf('/changes/');
			if (tagsIndex > -1) {
				remoteTagIndexes.push(refData.tags.length);
				remoteTagRefs.push(ref);
				refData.tags.push({ hash: hash, name: remoteRef.substring(0, tagsIndex) + '/' + remoteRef.substring(tagsIndex + 6), annotated: false });
			} else if (changesIndex > -1) {
				// Gerrit change ref (refs/remotes/<remote>/changes/...) - displayed as a remote branch
				// ref when "Show Refs" is enabled (NoteDb meta refs are never displayed). They are
				// never offered as branches: a Gerrit repository can hold tens of thousands of them,
				// which would swamp the Branches dropdown.
				if (options.showChangeRefs && !remoteRef.endsWith('/meta')) refData.remotes.push({ hash: hash, name: remoteRef });
			} else {
				refData.remotes.push({ hash: hash, name: remoteRef });
				branches.push('remotes/' + remoteRef);
			}
		}

		/* Peel the (rare) remote tag refs, so that their commits carry the tag label */
		if (remoteTagRefs.length > 0) {
			const peeled = await this.peelRefs(repo, remoteTagRefs);
			for (let i = 0; i < remoteTagIndexes.length; i++) {
				const tag = refData.tags[remoteTagIndexes[i]], hash = peeled[i];
				if (hash !== null && hash !== tag.hash) {
					refData.tags.push({ hash: hash, name: tag.name, annotated: true });
				}
			}
		}

		/* The checked-out branch is listed first, as `git branch` lists it */
		if (branchHead !== null) {
			const index = branches.indexOf(branchHead);
			if (index > 0) branches.splice(index, 1);
			if (index !== 0) branches.unshift(branchHead);
		}

		return { refData: refData, branches: branches, branchHead: branchHead, tagNames: tagNames.sort() };
	}

	/**
	 * Resolve the commits that a set of refs point at (peeling any annotated tag objects), using a
	 * single `rev-parse` process per batch of refs.
	 * @param repo The path of the repository.
	 * @param refs The full names of the refs to peel.
	 * @returns The peeled hash of each ref, in the order of `refs` (NULL => it couldn't be peeled).
	 */
	private async peelRefs(repo: string, refs: ReadonlyArray<string>): Promise<(string | null)[]> {
		const peeled: (string | null)[] = [];
		for (let i = 0; i < refs.length; i += PEEL_REFS_BATCH_SIZE) {
			const batch = refs.slice(i, i + PEEL_REFS_BATCH_SIZE);
			const hashes = await this.spawnGit(['rev-parse', '--verify', '-q', ...batch.map((ref) => ref + '^{commit}')], repo, (stdout) =>
				stdout.split(EOL_REGEX).filter((hash) => hash !== '')
			).catch(() => <string[]>[]);
			// `rev-parse -q` omits the refs it can't resolve, so the output only lines up with the
			// batch when every ref of the batch resolved
			for (let j = 0; j < batch.length; j++) {
				peeled.push(hashes.length === batch.length ? hashes[j] : null);
			}
		}
		return peeled;
	}

	/**
	 * Get all of the remotes that contain the specified commit hash.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to test.
	 * @param knownRemotes The list of known remotes to check for.
	 * @returns A promise resolving to a list of remote names.
	 */
	private getRemotesContainingCommit(repo: string, commitHash: string, knownRemotes: string[]) {
		return this.spawnGit(['branch', '-r', '--no-color', '--contains=' + commitHash], repo, (stdout) => {
			// Get the names of all known remote branches that contain commitHash
			const branchNames = stdout.split(EOL_REGEX)
				.filter((line) => line.length > 2)
				.map((line) => line.substring(2).split(' -> ')[0])
				.filter((branchName) => !INVALID_BRANCH_REGEXP.test(branchName));

			// Get all the remotes that are the prefix of at least one remote branch name
			return knownRemotes.filter((knownRemote) => {
				const knownRemotePrefix = knownRemote + '/';
				return branchNames.some((branchName) => branchName.startsWith(knownRemotePrefix));
			});
		});
	}

	/**
	 * Get the stashes in a repository.
	 * @param repo The path of the repository.
	 * @returns An array of stashes.
	 */
	private getStashes(repo: string) {
		return this.spawnGit(['reflog', '--format=' + this.gitFormatStash, 'refs/stash', '--'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			let stashes: GitStash[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 7 || line[1] === '') continue;
				let parentHashes = line[1].split(' ');
				stashes.push({
					hash: line[0],
					baseHash: parentHashes[0],
					untrackedFilesHash: parentHashes.length === 3 ? parentHashes[2] : null,
					selector: line[2],
					author: line[3],
					email: line[4],
					date: parseInt(line[5]),
					message: line[6]
				});
			}
			return stashes;
		}).catch(() => <GitStash[]>[]);
	}

	/**
	 * Get the names of the remotes of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of remote names.
	 */
	private getRemotes(repo: string) {
		return this.spawnGit(['remote'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			lines.pop();
			return lines;
		});
	}

	/**
	 * Get the signature of a signed tag.
	 * @param repo The path of the repository.
	 * @param ref The reference identifying the tag.
	 * @returns A Promise resolving to the signature.
	 */
	private getTagSignature(repo: string, ref: string): Promise<GitSignature> {
		return this._spawnGit(['verify-tag', '--raw', ref], repo, (stdout, stderr) => stderr || stdout.toString(), true).then((output) => {
			const records = output.split(EOL_REGEX)
				.filter((line: string) => line.startsWith('[GNUPG:] '))
				.map((line: string) => line.split(' '));

			let signature: Writeable<GitSignature> | null = null, trustLevel: string | null = null, parsingDetails: GpgStatusCodeParsingDetails | undefined;
			for (let i = 0; i < records.length; i++) {
				parsingDetails = GPG_STATUS_CODE_PARSING_DETAILS[records[i][1]];
				if (parsingDetails) {
					if (signature !== null) {
						throw new Error('Multiple Signatures Exist: As Git currently doesn\'t support them, nor does Git Graph (for consistency).');
					} else {
						signature = {
							status: parsingDetails.status,
							key: records[i][2],
							signer: parsingDetails.uid ? records[i].slice(3).join(' ') : '' // When parsingDetails.uid === TRUE, the signer is the rest of the record (so join the remaining arguments)
						};
					}
				} else if (records[i][1].startsWith('TRUST_')) {
					trustLevel = records[i][1];
				}
			}

			if (signature !== null && signature.status === GitSignatureStatus.GoodAndValid && (trustLevel === 'TRUST_UNDEFINED' || trustLevel === 'TRUST_NEVER')) {
				signature.status = GitSignatureStatus.GoodWithUnknownValidity;
			}

			if (signature !== null) {
				return signature;
			} else {
				throw new Error('No Signature could be parsed.');
			}
		}).catch(() => ({
			status: GitSignatureStatus.CannotBeChecked,
			key: '',
			signer: ''
		}));
	}

	/**
	 * Get the number of uncommitted changes in a repository.
	 * @param repo The path of the repository.
	 * @returns The number of uncommitted changes.
	 */
	public getUncommittedChanges(repo: string) {
		return this.spawnGit(['status', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain'], repo, (stdout) => {
			// An output without a trailing newline (the last entry of a truncated status) must
			// still count as a line
			return stdout.split(EOL_REGEX).filter((line) => line !== '').length;
		});
	}

	/**
	 * Get the untracked and deleted files that are not staged or committed.
	 * @param repo The path of the repository.
	 * @returns The untracked and deleted files.
	 */
	private getStatus(repo: string) {
		return this.spawnGit(['status', '-s', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain', '-z'], repo, (stdout) => {
			let output = stdout.split('\0'), i = 0;
			let status: GitStatusFiles = { deleted: [], untracked: [] };
			let path = '', c1 = '', c2 = '';
			while (i < output.length && output[i] !== '') {
				if (output[i].length < 4) break;
				path = output[i].substring(3);
				c1 = output[i].substring(0, 1);
				c2 = output[i].substring(1, 2);
				if (c1 === 'D' || c2 === 'D') status.deleted.push(path);
				else if (c1 === '?' || c2 === '?') status.untracked.push(path);

				if (c1 === 'R' || c2 === 'R' || c1 === 'C' || c2 === 'C') {
					// Renames or copies
					i += 2;
				} else {
					i += 1;
				}
			}
			return status;
		});
	}


	/* Private Utils */

	/**
	 * Check if there are staged changes that resulted from a squash merge, and if so, commit them.
	 * @param repo The path of the repository.
	 * @param obj The object being squash merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param squashMessageFormat The format to be used in the commit message of the squash.
	 * @returns The ErrorInfo from the executed command.
	 */
	private commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: MergeActionOn, squashMessageFormat: SquashMessageFormat, signCommits: boolean): Promise<ErrorInfo> {
		return this.areStagedChanges(repo).then((changes) => {
			if (changes) {
				const args = ['commit'];
				if (signCommits) {
					args.push('-S');
				}
				if (squashMessageFormat === SquashMessageFormat.Default) {
					args.push('-m', 'Merge ' + actionOn.toLowerCase() + ' \'' + obj + '\'');
				} else {
					args.push('--no-edit');
				}
				return this.runGitCommand(args, repo);
			} else {
				return null;
			}
		});
	}

	/**
	 * Get the diff between two revisions.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param arg Sets the data reported from the diff.
	 * @param filter The types of file changes to retrieve.
	 * @returns The diff output.
	 */
	private execDiff(repo: string, fromHash: string, toHash: string, arg: '--numstat' | '--name-status', filter: string) {
		let args: string[];
		if (fromHash === toHash) {
			args = ['diff-tree', arg, '-r', '--root', '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
		} else {
			args = ['diff', arg, '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
			if (toHash !== '') args.push(toHash);
		}

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split('\0');
			if (fromHash === toHash) lines.shift();
			return lines;
		});
	}

	/**
	 * Run a Git command (typically for a Git Graph View action).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Graph View).
	 */
	public runGitCommand(args: string[], repo: string): Promise<ErrorInfo> {
		// Any of these commands may change the repository's refs, so the cached ref read is dropped
		this.invalidateRefCache(repo);
		return this._spawnGit(args, repo, () => null).catch((errorMessage: string) => errorMessage);
	}

	/**
	 * Run a Git command that reads a command stream from its standard input (e.g.
	 * `git update-ref --stdin`, used to batch many ref updates into a single Git process).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param input The command stream to write to the standard input of the Git process.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Graph View).
	 */
	public runGitCommandWithInput(args: string[], repo: string, input: string): Promise<ErrorInfo> {
		// Any of these commands may change the repository's refs, so the cached ref read is dropped
		this.invalidateRefCache(repo);
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				return resolve(UNABLE_TO_FIND_GIT_MSG);
			}

			const cmd = cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv)
			});
			let stderr = '';
			cmd.stderr.on('data', (d: Buffer) => { stderr += d; });
			cmd.on('error', (error) => resolve(error.message));
			cmd.on('close', (code) => resolve(code === 0 ? null : getErrorMessage(null, Buffer.alloc(0), stderr)));
			cmd.stdin.on('error', () => { /* ignore EPIPE: the command already failed */ });
			cmd.stdin.end(input);

			this.logger.logCmd('git', args);
		});
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string (public wrapper used by `GerritDataSource`).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	public gitOutput<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this._spawnGit(args, repo, (stdout) => resolveValue(stdout.toString()));
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	private spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this.gitOutput(args, repo, resolveValue);
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a buffer.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout` and `stderr`.
	 * @param ignoreExitCode Ignore the exit code returned by Git (default: `FALSE`).
	 */
	private _spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: Buffer, stderr: string): T }, ignoreExitCode: boolean = false) {
		return new Promise<T>((resolve, reject) => {
			if (this.gitExecutable === null) {
				return reject(UNABLE_TO_FIND_GIT_MSG);
			}

			resolveSpawnOutput(cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv)
			})).then((values) => {
				const status = values[0], stdout = values[1], stderr = values[2];
				if (status.code === 0 || ignoreExitCode) {
					resolve(resolveValue(stdout, stderr));
				} else {
					reject(getErrorMessage(status.error, stdout, stderr));
				}
			});

			this.logger.logCmd('git', args);
		});
	}
}


/**
 * Generates the file changes from the diff output and status information.
 * @param nameStatusRecords The `--name-status` records.
 * @param numStatRecords The `--numstat` records.
 * @param status The deleted and untracked files.
 * @returns An array of file changes.
 */
function generateFileChanges(nameStatusRecords: DiffNameStatusRecord[], numStatRecords: DiffNumStatRecord[], status: GitStatusFiles | null) {
	let fileChanges: Writeable<GitFileChange>[] = [], fileLookup: { [file: string]: number } = {}, i = 0;

	for (i = 0; i < nameStatusRecords.length; i++) {
		fileLookup[nameStatusRecords[i].newFilePath] = fileChanges.length;
		fileChanges.push({ oldFilePath: nameStatusRecords[i].oldFilePath, newFilePath: nameStatusRecords[i].newFilePath, type: nameStatusRecords[i].type, additions: null, deletions: null });
	}

	if (status !== null) {
		let filePath;
		for (i = 0; i < status.deleted.length; i++) {
			filePath = getPathFromStr(status.deleted[i]);
			if (typeof fileLookup[filePath] === 'number') {
				fileChanges[fileLookup[filePath]].type = GitFileStatus.Deleted;
			} else {
				fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Deleted, additions: null, deletions: null });
			}
		}
		for (i = 0; i < status.untracked.length; i++) {
			filePath = getPathFromStr(status.untracked[i]);
			fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Untracked, additions: null, deletions: null });
		}
	}

	for (i = 0; i < numStatRecords.length; i++) {
		if (typeof fileLookup[numStatRecords[i].filePath] === 'number') {
			fileChanges[fileLookup[numStatRecords[i].filePath]].additions = numStatRecords[i].additions;
			fileChanges[fileLookup[numStatRecords[i].filePath]].deletions = numStatRecords[i].deletions;
		}
	}

	return fileChanges;
}

/**
 * Get the specified config value from a set of key-value config pairs.
 * @param configs A set key-value pairs of Git configuration records.
 * @param key The key of the desired config.
 * @returns The value for `key` if it exists, otherwise NULL.
 */
function getConfigValue(configs: GitConfigSet, key: string) {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * Produce a suitable error message from a spawned Git command that terminated with an erroneous status code.
 * @param error An error generated by JavaScript (optional).
 * @param stdoutBuffer A buffer containing the data outputted to `stdout`.
 * @param stderr A string containing the data outputted to `stderr`.
 * @returns A suitable error message.
 */
function getErrorMessage(error: Error | null, stdoutBuffer: Buffer, stderr: string) {
	let stdout = stdoutBuffer.toString(), lines: string[];
	if (stdout !== '' || stderr !== '') {
		lines = (stderr + stdout).split(EOL_REGEX);
		lines.pop();
	} else if (error) {
		lines = error.message.split(EOL_REGEX);
	} else {
		lines = [];
	}
	return lines.join('\n');
}

/**
 * Remove trailing blank lines from an array of lines.
 * @param lines The array of lines.
 * @returns The same array.
 */
function removeTrailingBlankLines(lines: string[]) {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Get all the unique strings from an array of strings.
 * @param items The array of strings with duplicates.
 * @returns An array of unique strings.
 */
function unique(items: ReadonlyArray<string>) {
	const uniqueItems: { [item: string]: true } = {};
	items.forEach((item) => uniqueItems[item] = true);
	return Object.keys(uniqueItems);
}


/* Types */

interface DiffNameStatusRecord {
	type: GitFileStatus;
	oldFilePath: string;
	newFilePath: string;
}

interface DiffNumStatRecord {
	filePath: string;
	additions: number | null;
	deletions: number | null;
}

interface GitBranchData {
	branches: string[];
	head: string | null;
	error: ErrorInfo;
}

interface GitCommitRecord {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	date: number;
	message: string;
}

export interface GitCommitData {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	error: ErrorInfo;
}

export interface GitCommitDetailsData {
	commitDetails: GitCommitDetails | null;
	error: ErrorInfo;
}

export interface GitCommitFileCountsData {
	counts: { [path: string]: GitLineCounts };
	error: ErrorInfo;
}

interface GitCommitComparisonData {
	fileChanges: GitFileChange[];
	error: ErrorInfo;
}

type GitConfigSet = { [key: string]: string };

interface GitRef {
	hash: string;
	name: string;
}

interface GitRefTag extends GitRef {
	annotated: boolean;
}

interface GitRefData {
	head: string | null;
	heads: GitRef[];
	tags: GitRefTag[];
	remotes: GitRef[];
}

/** The options that determine which refs a ref read returns (and therefore its cache key). */
interface RefReadOptions {
	showRemoteBranches: boolean;
	showRemoteHeads: boolean;
	hideRemotes: ReadonlyArray<string>;
	showChangeRefs: boolean;
}

/**
 * The refs of a repository, read in a single pass, in both of the forms the Git Graph View needs:
 * the refs annotated onto the commits of the graph (`getCommits`), and the branch & tag names
 * offered by the view's dropdowns (`getRepoInfo`).
 */
interface GitRefSnapshot {
	refData: GitRefData;
	/** The branch names, in the order `git branch` lists them (the checked-out branch first). */
	branches: string[];
	/** The name of the checked-out branch, or NULL when HEAD is detached. */
	branchHead: string | null;
	/** The names of the local tags, sorted. */
	tagNames: string[];
}

interface GitRepoInfo extends GitBranchData {
	remotes: string[];
	stashes: GitStash[];
	tags: string[];
}

interface GitRepoConfigData {
	config: GitRepoConfig | null;
	error: ErrorInfo;
}

interface GitStatusFiles {
	deleted: string[];
	untracked: string[];
}

interface GitTagDetailsData {
	details: GitTagDetails | null;
	error: ErrorInfo;
}

interface GpgStatusCodeParsingDetails {
	readonly status: GitSignatureStatus,
	readonly uid: boolean
}
