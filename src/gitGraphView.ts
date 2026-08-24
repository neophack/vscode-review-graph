import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Cache-busting version appended to the webview media URIs.
 * Must be bumped whenever web/ sources change, so that already-open webviews
 * don't keep serving a stale cached out.min.js / out.min.css after an update.
 */
const MEDIA_CACHE_VERSION = '1.39.1';

import { AvatarManager } from './avatarManager';
import { getConfig } from './config';
import { CommitComparisonView } from './comparisonView';
import { DataSource, GitCommitData, GitCommitDetailsData, GitConfigKey } from './dataSource';
import { ExtensionState } from './extensionState';
import { buildFetchRefspecs, changeShard, extractChangeId, filterChangeStates, generateChangeId, hasChangeId, limitChanges, normalizeGerritFetchLimit, parseChangeRef, parseLsRemoteChanges } from './gerrit';
import { Logger } from './logger';
import { PullRequestDataSource } from './pullRequests';
import { RepoFileWatcher } from './repoFileWatcher';
import { RepoManager } from './repoManager';
import { ErrorInfo, GerritChangeState, GerritStatusFilter, GitConfigLocation, GitGraphViewInitialState, GitPushBranchMode, GitRepoSet, LoadGitGraphViewTo, RequestLoadCommits, RequestMessage, ResponseMessage, TabIconColourTheme } from './types';
import { UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED, archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, encodeJsonForInlineScript, getNonce, isSafeRefName, isValidCommitHash, openExtensionSettings, openExternalUrl, openFile, showErrorMessage, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm } from './utils';
import { Disposable, toDisposable } from './utils/disposable';

/**
 * The cached Gerrit data of a repository: every change state returned by the refresh pipeline,
 * regardless of the status filter, together with the patchsets needed to build the change refs.
 * The status filter is applied when the cache is served, so that switching filters is instant.
 */
interface GerritCacheEntry {
	states: GerritChangeState[];
	patchsets: Map<number, number[]>;
}

/**
 * The Global (User) Settings that the Settings Widget is allowed to write, and the validator of
 * each value. Requests naming a setting that isn't a key of this record are rejected, so a
 * compromised webview can't write arbitrary VS Code settings.
 */
const WRITABLE_GLOBAL_SETTINGS: { readonly [setting: string]: (value: any) => boolean } = {
	/* Graph & Display */
	'graph.style': isOneOf('rounded', 'angular'),
	'graph.rowHeight': isIntegerInRange(16, 48),
	'graph.fontSize': isIntegerInRange(8, 24),
	'date.type': isOneOf('Author Date', 'Commit Date'),
	'date.format': isOneOf('Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'),
	'referenceLabels.combineLocalAndRemoteBranchLabels': isBoolean,
	'stickyHeader': isBoolean,
	'markdown': isBoolean,

	/* Commit Loading */
	'repository.commits.initialLoad': isIntegerInRange(1, 100000),
	'repository.commits.loadMore': isIntegerInRange(1, 100000),
	'repository.commits.loadMoreAutomatically': isBoolean,
	'repository.commits.order': isOneOf('date', 'author-date', 'topo'),
	'repository.commits.fetchAvatars': isBoolean,
	'repository.showUncommittedChanges': isBoolean,
	'repository.showUntrackedFiles': isBoolean,

	/* Remotes & Fetching */
	'repository.fetchAndPrune': isBoolean,
	'repository.fetchAndPruneTags': isBoolean,
	'repository.trackRemoteTags': isBoolean,
	'repository.showRemoteBranches': isBoolean,
	'repository.showRemoteHeads': isBoolean,

	/* Review Integration */
	'gerrit.enabled': isBoolean,
	'gerrit.autoFetch': isBoolean,
	'gerrit.showReviewProgress': isBoolean,
	'gerrit.showChangeRefs': isBoolean,
	'gerrit.showPushButton': isBoolean,
	'gerrit.statusFilter': isGerritStatusFilter,
	'pullRequests.enabled': isBoolean
};

function isBoolean(value: any) {
	return typeof value === 'boolean';
}

function isOneOf(...allowed: string[]) {
	return (value: any) => typeof value === 'string' && allowed.includes(value);
}

function isIntegerInRange(min: number, max: number) {
	return (value: any) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isGerritStatusFilter(value: any) {
	return value !== null && typeof value === 'object' && !Array.isArray(value) &&
		Object.keys(value).length === 4 &&
		isBoolean(value.new) && isBoolean(value.merged) && isBoolean(value.abandoned) && isBoolean(value.wip);
}

/**
 * Manages the Git Graph View.
 */
export class GitGraphView extends Disposable {
	public static currentPanel: GitGraphView | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionPath: string;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly repoFileWatcher: RepoFileWatcher;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private isGraphViewLoaded: boolean = false;
	private isPanelVisible: boolean = true;
	private currentRepo: string | null = null;
	private loadViewTo: LoadGitGraphViewTo = null; // Is used by the next call to getHtmlForWebview, and is then reset to null

	private loadRepoInfoRefreshId: number = 0;
	private loadCommitsRefreshId: number = 0;

	private gerritFetchModeRestore: 'latest' | 'all' = 'latest'; // the fetch mode active before "Clear Refs" turned Gerrit change fetching off
	private gerritCache: Map<string, GerritCacheEntry> = new Map();
	private gerritFetches: Map<string, Promise<GerritCacheEntry | null>> = new Map();
	private gerritCacheGeneration: number = 0; // incremented whenever the Gerrit fetch settings change, so stale in-flight fetches don't repopulate the cache
	private gerritStaleRepos: Set<string> = new Set(); // repos whose cached Gerrit data must be re-fetched from the remote on the next load

	private readonly pullRequests: PullRequestDataSource = new PullRequestDataSource();

	/**
	 * Cache of recently loaded commit data, keyed by the full request signature. getCommits
	 * dominates the load time on large repositories (multiple Git spawns), and many consecutive
	 * requests are identical (Gerrit follow-up stages, filter toggles back and forth): those are
	 * served from the cache instead of re-running Git. In-flight promises are cached too, so
	 * concurrent identical requests share a single Git run. Invalidated whenever the
	 * RepoFileWatcher observes a change in the repository, bypassed by forced refreshes.
	 */
	private readonly commitCache: Map<string, Promise<GitCommitData>> = new Map();
	private static readonly COMMIT_CACHE_LIMIT = 32;
	/**
	 * Commands whose handlers can modify the repository (its HEAD, refs, stash, index, working tree
	 * or Git config). They run with the RepoFileWatcher muted, so the watcher-based commit cache
	 * invalidation never fires for changes the view makes itself: these commands must invalidate
	 * the cache directly (see `respondToMessage`), otherwise the `loadCommits` request of the
	 * webview's post-action refresh is served pre-action data - e.g. a stale HEAD after a checkout,
	 * leaving the current-position marker on the previously checked-out commit.
	 */
	private static readonly REPO_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
		'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit', 'cherrypickCommit',
		'cleanUntrackedFiles', 'createBranch', 'createPullRequest', 'deleteBranch', 'deleteRemote', 'deleteRemoteBranch',
		'deleteTag', 'dropCommit', 'dropStash', 'editRemote', 'editUserDetails', 'fetch', 'fetchIntoLocalBranch', 'merge',
		'popStash', 'pruneRemote', 'pullBranch', 'pushBranch', 'pushStash', 'pushTag', 'rebase', 'renameBranch',
		'resetFileToRevision', 'resetToCommit', 'revertCommit', 'editCommitMessage', 'undoLastCommit',
		'gerritSubmitReview', 'gerritFetchChange', 'gerritClearRefs', 'gerritInstallHook', 'gerritAmendChangeId', 'gerritAutosquash'
	]);

	/**
	 * If a Git Graph View already exists, show and update it. Otherwise, create a Git Graph View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Graph DataSource instance.
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param logger The Git Graph Logger instance.
	 * @param loadViewTo What to load the view to.
	 */
	public static createOrShow(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (GitGraphView.currentPanel) {
			// If Git Graph panel already exists
			if (GitGraphView.currentPanel.isPanelVisible) {
				// If the Git Graph panel is visible
				if (loadViewTo !== null) {
					GitGraphView.currentPanel.respondLoadRepos(repoManager.getRepos(), loadViewTo);
				}
			} else {
				// If the Git Graph panel is not visible
				GitGraphView.currentPanel.loadViewTo = loadViewTo;
			}
			GitGraphView.currentPanel.panel.reveal(column);
		} else {
			// If Git Graph panel doesn't already exist
			GitGraphView.currentPanel = new GitGraphView(extensionPath, dataSource, extensionState, avatarManager, repoManager, logger, loadViewTo, column);
		}
	}

	/**
	 * Creates a Git Graph View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Graph DataSource instance.
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param logger The Git Graph Logger instance.
	 * @param loadViewTo What to load the view to.
	 * @param column The column the view should be loaded in.
	 */
	private constructor(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo, column: vscode.ViewColumn | undefined) {
		super();
		this.extensionPath = extensionPath;
		this.avatarManager = avatarManager;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.repoManager = repoManager;
		this.logger = logger;
		this.loadViewTo = loadViewTo;

		const config = getConfig();
		this.panel = vscode.window.createWebviewPanel('review-graph', 'Review Graph', column || vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))],
			retainContextWhenHidden: config.retainContextWhenHidden
		});
		this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
			? this.getResourcesUri('review-graph-webview-icon.svg')
			: {
				light: this.getResourcesUri('review-graph-webview-icon-light.svg'),
				dark: this.getResourcesUri('review-graph-webview-icon-dark.svg')
			};


		this.registerDisposables(
			// Dispose Git Graph View resources when disposed
			toDisposable(() => {
				GitGraphView.currentPanel = undefined;
				this.repoFileWatcher.stop();
			}),

			// Dispose this Git Graph View when the Webview Panel is disposed
			this.panel.onDidDispose(() => this.dispose()),

			// Register a callback that is called when the view is shown or hidden
			this.panel.onDidChangeViewState(() => {
				if (this.panel.visible !== this.isPanelVisible) {
					if (this.panel.visible) {
						this.update();
					} else {
						this.currentRepo = null;
						this.repoFileWatcher.stop();
					}
					this.isPanelVisible = this.panel.visible;
				}
			}),

			// Subscribe to events triggered when a repository is added or deleted from Git Graph
			repoManager.onDidChangeRepos((event) => {
				if (!this.panel.visible) return;
				const loadViewTo = event.loadRepo !== null ? { repo: event.loadRepo } : null;
				if ((event.numRepos === 0 && this.isGraphViewLoaded) || (event.numRepos > 0 && !this.isGraphViewLoaded)) {
					this.loadViewTo = loadViewTo;
					this.update();
				} else {
					this.respondLoadRepos(event.repos, loadViewTo);
				}
			}),

			// Subscribe to events triggered when an avatar is available
			avatarManager.onAvatar((event) => {
				this.sendMessage({
					command: 'fetchAvatar',
					email: event.email,
					image: event.image
				});
			}),

			// Respond to messages sent from the Webview
			this.panel.webview.onDidReceiveMessage((msg) => this.respondToMessage(msg)),

			// Dispose the Webview Panel when disposed
			this.panel,

			// Update the Git Graph View when the configuration changes
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('review-graph')) {
					const config = getConfig();
					// Cached commit data also depends on settings that aren't part of the cache key
					// (e.g. showCommitsOnlyReferencedByTags, showRemoteHeads): the webview re-requests
					// with an identical key, so drop the cache to avoid serving stale commits
					this.commitCache.clear();
					this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
						? this.getResourcesUri('review-graph-webview-icon.svg')
						: {
							light: this.getResourcesUri('review-graph-webview-icon-light.svg'),
							dark: this.getResourcesUri('review-graph-webview-icon-dark.svg')
						};
					this.update();
				}
			})
		);

		// Instantiate a RepoFileWatcher that watches for file changes in the repository currently open in the Git Graph View
		this.repoFileWatcher = new RepoFileWatcher(logger, () => {
			if (this.panel.visible) {
				// The repository changed on disk: any cached commit data is now stale
				this.commitCache.clear();
				this.sendMessage({ command: 'refresh' });
			}
		}, () => {
			// The repository's Git config changed: drop the cached config data so the next load is fresh
			this.dataSource.invalidateConfigCache(this.repoFileWatcher.getRepo());
		});

		// Render the content of the Webview
		this.update();

		this.logger.log('Created Git Graph View' + (loadViewTo !== null ? ' (active repo: ' + loadViewTo.repo + ')' : ''));
	}

	/**
	 * Respond to a message sent from the front-end.
	 * @param msg The message that was received.
	 */
	private async respondToMessage(msg: RequestMessage) {
		this.repoFileWatcher.mute();

		try {
			await this.handleMessage(msg);
		} catch (error) {
			this.logger.logError('Failed to handle "' + msg.command + '" message: ' + error);
			showErrorMessage('Review Graph encountered an error while handling this action.');
		} finally {
			this.repoFileWatcher.unmute();
			if (GitGraphView.REPO_MUTATING_COMMANDS.has(msg.command)) {
				// The handler ran with the RepoFileWatcher muted, so any repository change it made
				// bypassed the watcher-based cache invalidation. Drop the cached commit data even
				// when the action failed: a partially completed action (e.g. a conflicted merge)
				// may still have moved refs, and the cost of re-running Git once is negligible.
				this.commitCache.clear();
			}
		}
	}

	/**
	 * Handle a message sent from the front-end.
	 * Any error thrown by a handler is caught and logged by `respondToMessage`.
	 * @param msg The message that was received.
	 */
	private async handleMessage(msg: RequestMessage) {
		let errorInfos: ErrorInfo[];

		switch (msg.command) {
			case 'addRemote':
				this.sendMessage({
					command: 'addRemote',
					error: await this.dataSource.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch)
				});
				break;
			case 'addTag':
				errorInfos = [await this.dataSource.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force)];
				if (errorInfos[0] === null && msg.pushToRemote !== null) {
					errorInfos.push(...await this.dataSource.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck));
				}
				this.sendMessage({
					command: 'addTag',
					repo: msg.repo,
					tagName: msg.tagName,
					pushToRemote: msg.pushToRemote,
					commitHash: msg.commitHash,
					errors: errorInfos
				});
				break;
			case 'applyStash':
				this.sendMessage({
					command: 'applyStash',
					error: await this.dataSource.applyStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'branchFromStash':
				this.sendMessage({
					command: 'branchFromStash',
					error: await this.dataSource.branchFromStash(msg.repo, msg.selector, msg.branchName)
				});
				break;
			case 'checkoutBranch':
				errorInfos = [await this.dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch)];
				if (errorInfos[0] === null && msg.pullAfterwards !== null) {
					errorInfos.push(await this.dataSource.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash));
				}
				this.sendMessage({
					command: 'checkoutBranch',
					pullAfterwards: msg.pullAfterwards,
					errors: errorInfos
				});
				break;
			case 'checkoutCommit':
				this.sendMessage({
					command: 'checkoutCommit',
					error: await this.dataSource.checkoutCommit(msg.repo, msg.commitHash)
				});
				break;
			case 'cherrypickCommit':
				errorInfos = [await this.dataSource.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)];
				if (errorInfos[0] === null && msg.noCommit) {
					errorInfos.push(await viewScm());
				}
				this.sendMessage({ command: 'cherrypickCommit', errors: errorInfos });
				break;
			case 'cleanUntrackedFiles':
				this.sendMessage({
					command: 'cleanUntrackedFiles',
					error: await this.dataSource.cleanUntrackedFiles(msg.repo, msg.directories)
				});
				break;
			case 'commitDetails': {
				const data = await Promise.all<GitCommitDetailsData, string | null>([
					msg.commitHash === UNCOMMITTED
						? this.dataSource.getUncommittedDetails(msg.repo)
						: msg.stash === null
							? this.dataSource.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents)
							: this.dataSource.getStashDetails(msg.repo, msg.commitHash, msg.stash),
					msg.avatarEmail !== null ? this.avatarManager.getAvatarImage(msg.avatarEmail) : Promise.resolve(null)
				]);
				this.sendMessage({
					command: 'commitDetails',
					...data[0],
					avatar: data[1],
					codeReview: msg.commitHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.commitHash) : null,
					refresh: msg.refresh
				});
				break;
			}
			case 'commitBodies': {
				let bodies: { [hash: string]: string } = {};
				try {
					bodies = await this.dataSource.getCommitBodies(msg.repo, msg.commitHashes);
				} catch (error) {
					this.logger.logError('Failed to load commit bodies: ' + error);
				}
				this.sendMessage({ command: 'commitBodies', bodies: bodies });
				break;
			}
			case 'compareCommits':
				this.sendMessage({
					command: 'compareCommits',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.dataSource.getCommitComparison(msg.repo, msg.fromHash, msg.toHash),
					codeReview: msg.toHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.fromHash + '-' + msg.toHash) : null,
					refresh: msg.refresh
				});
				break;
			case 'copyFilePath':
				this.sendMessage({
					command: 'copyFilePath',
					error: await copyFilePathToClipboard(msg.repo, msg.filePath, msg.absolute)
				});
				break;
			case 'copyToClipboard':
				this.sendMessage({
					command: 'copyToClipboard',
					type: msg.type,
					error: await copyToClipboard(msg.data)
				});
				break;
			case 'createArchive':
				this.sendMessage({
					command: 'createArchive',
					error: await archive(msg.repo, msg.ref, this.dataSource)
				});
				break;
			case 'createBranch':
				this.sendMessage({
					command: 'createBranch',
					errors: await this.dataSource.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force)
				});
				break;
			case 'createPullRequest':
				errorInfos = [msg.push ? await this.dataSource.pushBranch(msg.repo, msg.sourceBranch, msg.sourceRemote, true, GitPushBranchMode.Normal) : null];
				if (errorInfos[0] === null) {
					errorInfos.push(await createPullRequest(msg.config, msg.sourceOwner, msg.sourceRepo, msg.sourceBranch));
				}
				this.sendMessage({
					command: 'createPullRequest',
					push: msg.push,
					errors: errorInfos
				});
				break;
			case 'deleteBranch':
				errorInfos = [await this.dataSource.deleteBranch(msg.repo, msg.branchName, msg.forceDelete)];
				if (errorInfos[0] === null) {
					for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
						errorInfos.push(await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
					}
				}
				this.sendMessage({
					command: 'deleteBranch',
					repo: msg.repo,
					branchName: msg.branchName,
					deleteOnRemotes: msg.deleteOnRemotes,
					errors: errorInfos
				});
				break;
			case 'deleteRemote':
				this.sendMessage({
					command: 'deleteRemote',
					error: await this.dataSource.deleteRemote(msg.repo, msg.name)
				});
				break;
			case 'deleteRemoteBranch':
				this.sendMessage({
					command: 'deleteRemoteBranch',
					error: await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote)
				});
				break;
			case 'deleteTag':
				this.sendMessage({
					command: 'deleteTag',
					error: await this.dataSource.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote)
				});
				break;
			case 'deleteUserDetails':
				errorInfos = [];
				if (msg.name) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, msg.location));
				}
				if (msg.email) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, msg.location));
				}
				this.sendMessage({
					command: 'deleteUserDetails',
					errors: errorInfos
				});
				break;
			case 'dropCommit':
				this.sendMessage({
					command: 'dropCommit',
					error: await this.dataSource.dropCommit(msg.repo, msg.commitHash)
				});
				break;
			case 'dropStash':
				this.sendMessage({
					command: 'dropStash',
					error: await this.dataSource.dropStash(msg.repo, msg.selector)
				});
				break;
			case 'editRemote':
				this.sendMessage({
					command: 'editRemote',
					error: await this.dataSource.editRemote(msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew)
				});
				break;
			case 'editUserDetails':
				errorInfos = [
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserName, msg.name, msg.location),
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserEmail, msg.email, msg.location)
				];
				if (errorInfos[0] === null && errorInfos[1] === null) {
					if (msg.deleteLocalName) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, GitConfigLocation.Local));
					}
					if (msg.deleteLocalEmail) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, GitConfigLocation.Local));
					}
				}
				this.sendMessage({
					command: 'editUserDetails',
					errors: errorInfos
				});
				break;
			case 'endCodeReview':
				this.extensionState.endCodeReview(msg.repo, msg.id);
				break;
			case 'exportRepoConfig':
				this.sendMessage({
					command: 'exportRepoConfig',
					error: await this.repoManager.exportRepoConfig(msg.repo)
				});
				break;
			case 'fetch':
				this.sendMessage({
					command: 'fetch',
					error: await this.dataSource.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags)
				});
				break;
			case 'fetchAvatar':
				this.avatarManager.fetchAvatarImage(msg.email, msg.repo, msg.remote, msg.commits);
				break;
			case 'fetchIntoLocalBranch':
				this.sendMessage({
					command: 'fetchIntoLocalBranch',
					error: await this.dataSource.fetchIntoLocalBranch(msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force)
				});
				break;
			case 'countCommitsBefore':
				this.sendMessage({
					command: 'countCommitsBefore',
					hash: msg.hash,
					count: await this.dataSource.countCommitsBefore(msg.repo, msg.branches, msg.hash, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs)
				});
				break;
			case 'loadCommits': {
				this.loadCommitsRefreshId = msg.refreshId;
				const config = getConfig().gerrit;
				const gerritShowChangeRefs = config.showChangeRefs;
				// A forced refresh (the Refresh button) must observe fresh repository state: bypass the commit cache
				const forceFresh = msg.gerritForceRefresh === true;
				if (!this.isGerritEnabled() || config.fetchMode === 'off') {
					// Gerrit integration disabled: load the commits without any Gerrit data
					const commitData = await this.getCommitsCached(msg, null, gerritShowChangeRefs, true, forceFresh);
					this.sendMessage({
						command: 'loadCommits',
						refreshId: msg.refreshId,
						onlyFollowFirstParent: msg.onlyFollowFirstParent,
						gerritStates: null,
						uncommittedPending: true,
						...commitData
					});
					this.sendUncommittedChangesFollowUp(msg, commitData, null); // runs asynchronously (never awaited)
				} else if (this.gerritCache.has(msg.repo) && msg.gerritForceRefresh !== true && !this.gerritStaleRepos.has(msg.repo)) {
					// The Gerrit data is already cached: serve it instantly from the cache
					const gerritData = await this.loadGerritData(msg.repo, msg.gerritStatusFilter, false);
					const commitData = await this.getCommitsCached(msg, gerritData !== null ? gerritData.refs : null, gerritShowChangeRefs, true, forceFresh);
					this.sendMessage({
						command: 'loadCommits',
						refreshId: msg.refreshId,
						onlyFollowFirstParent: msg.onlyFollowFirstParent,
						gerritStates: gerritData !== null ? gerritData.states : null,
						uncommittedPending: true,
						...commitData
					});
					this.sendUncommittedChangesFollowUp(msg, commitData, gerritData !== null ? gerritData.states : null); // runs asynchronously (never awaited)
				} else {
					// The Gerrit cache is empty (e.g. the extension just started): rebuild it from the
					// locally cached change refs WITHOUT any network access first, so when local refs
					// exist the Gerrit data is part of the FIRST response (no pending round-trips that
					// each re-run getCommits, which dominates the load time on large repositories)
					if (!this.gerritCache.has(msg.repo)) {
						const local = await this.buildLocalGerritEntry(msg.repo);
						if (local !== null) this.gerritCache.set(msg.repo, local);
					}
					if (this.gerritCache.has(msg.repo) && msg.gerritForceRefresh !== true && !this.gerritStaleRepos.has(msg.repo)) {
						// Locally rebuilt Gerrit data: serve it instantly, exactly like the cache branch above
						const gerritData = await this.loadGerritData(msg.repo, msg.gerritStatusFilter, false);
						const commitData = await this.getCommitsCached(msg, gerritData !== null ? gerritData.refs : null, gerritShowChangeRefs, true, forceFresh);
						this.sendMessage({
							command: 'loadCommits',
							refreshId: msg.refreshId,
							onlyFollowFirstParent: msg.onlyFollowFirstParent,
							gerritStates: gerritData !== null ? gerritData.states : null,
							uncommittedPending: true,
							...commitData
						});
						this.sendUncommittedChangesFollowUp(msg, commitData, gerritData !== null ? gerritData.states : null); // runs asynchronously (never awaited)
					} else {
					// No Gerrit data at all, or a forced refresh was requested: render the branch
					// graph IMMEDIATELY with the stale cached Gerrit data (if any), and complete the
					// Gerrit pipeline asynchronously. This response is marked `gerritPending`, so the
					// Git Graph View keeps its loading indicator running until the final response with
					// the fresh Gerrit data arrives.
						const staleGerritData = this.peekCachedGerritData(msg.repo, msg.gerritStatusFilter);
						const staleRefs = staleGerritData !== null ? staleGerritData.refs : null;
						const commitData = await this.getCommitsCached(msg, staleRefs, gerritShowChangeRefs, false, forceFresh);
						this.sendMessage({
							command: 'loadCommits',
							refreshId: msg.refreshId,
							onlyFollowFirstParent: msg.onlyFollowFirstParent,
							gerritPending: true,
							gerritStates: staleGerritData !== null ? staleGerritData.states : null,
							...commitData
						});
						this.loadCommitsGerritFollowUp(msg, gerritShowChangeRefs, staleRefs, commitData); // runs asynchronously (never awaited)
					}
				}
				break;
			}
			case 'fetchPullRequest': {
				this.sendMessage({
					command: 'pullRequestStatus',
					branch: msg.branch,
					pr: await this.fetchPullRequest(msg.repo, msg.branch)
				});
				break;
			}
			case 'setInterfaceLanguage': {
				this.sendMessage({
					command: 'setInterfaceLanguage',
					error: await this.setInterfaceLanguage(msg.language)
				});
				break;
			}
			case 'setGlobalSetting': {
				this.sendMessage({
					command: 'setGlobalSetting',
					setting: msg.setting,
					error: await this.setGlobalSetting(msg.setting, msg.value)
				});
				break;
			}
			case 'gerritSubmitReview':
				this.sendMessage({
					command: 'gerritSubmitReview',
					...await this.gerritSubmitReview(msg.repo, msg.hash, msg.branch)
				});
				break;
			case 'gerritFetchChange':
				this.sendMessage({
					command: 'gerritFetchChange',
					change: msg.change,
					error: await this.gerritFetchChange(msg.repo, msg.change)
				});
				break;
			case 'gerritSaveFetchConfig':
				this.sendMessage({
					command: 'gerritSaveFetchConfig',
					error: await this.gerritSaveFetchConfig(msg.fetchMode, msg.fetchLimit)
				});
				break;
			case 'gerritSetControlsBar':
				this.sendMessage({
					command: 'gerritSetControlsBar',
					error: await this.gerritSetControlsBar(msg.repo, msg.enabled)
				});
				break;
			case 'gerritClearRefs':
				this.sendMessage({
					command: 'gerritClearRefs',
					...await this.gerritClearRefs(msg.repo)
				});
				break;
			case 'gerritEnableFetching':
				this.sendMessage({
					command: 'gerritEnableFetching',
					error: await this.gerritEnableFetching()
				});
				break;
			case 'gerritGetHookStatus':
				this.sendMessage({
					command: 'gerritGetHookStatus',
					...await this.gerritGetHookStatus(msg.repo)
				});
				break;
			case 'gerritInstallHook':
				this.sendMessage({
					command: 'gerritInstallHook',
					hook: msg.hook,
					...await this.gerritInstallHook(msg.repo, msg.hook)
				});
				break;
			case 'gerritAmendChangeId':
				this.sendMessage({
					command: 'gerritAmendChangeId',
					...await this.gerritAmendChangeId(msg.repo)
				});
				break;
			case 'gerritAutosquash':
				this.sendMessage({
					command: 'gerritAutosquash',
					error: await this.gerritAutosquash(msg.repo, msg.commitHash, msg.mode)
				});
				break;
			case 'loadConfig':
				this.sendMessage({
					command: 'loadConfig',
					repo: msg.repo,
					...await this.dataSource.getConfig(msg.repo, msg.remotes)
				});
				break;
			case 'loadRepoInfo': {
				this.loadRepoInfoRefreshId = msg.refreshId;
				let repoInfo = await this.dataSource.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes), isRepo = true;
				if (repoInfo.error) {
					// If an error occurred, check to make sure the repo still exists
					isRepo = (await this.dataSource.repoRoot(msg.repo)) !== null;
					if (!isRepo) repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
				}
				this.sendMessage({
					command: 'loadRepoInfo',
					refreshId: msg.refreshId,
					...repoInfo,
					isRepo: isRepo
				});
				if (msg.repo !== this.currentRepo) {
					this.currentRepo = msg.repo;
					this.extensionState.setLastActiveRepo(msg.repo);
					this.repoFileWatcher.start(msg.repo);
				}
				break;
			}
			case 'loadRepos':
				if (!msg.check || !await this.repoManager.checkReposExist()) {
					// If not required to check repos, or no changes were found when checking, respond with repos
					this.respondLoadRepos(this.repoManager.getRepos(), null);
				}
				break;
			case 'merge':
				this.sendMessage({
					command: 'merge',
					actionOn: msg.actionOn,
					error: await this.dataSource.merge(msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.squash, msg.noCommit)
				});
				break;
			case 'openExtensionSettings':
				this.sendMessage({
					command: 'openExtensionSettings',
					error: await openExtensionSettings()
				});
				break;
			case 'openExternalDirDiff':
				this.sendMessage({
					command: 'openExternalDirDiff',
					error: await this.dataSource.openExternalDirDiff(msg.repo, msg.fromHash, msg.toHash, msg.isGui)
				});
				break;
			case 'openCompareTab':
				CommitComparisonView.open(this.dataSource, msg.repo, msg.fromHash, msg.toHash);
				break;
			case 'openExternalUrl':
				this.sendMessage({
					command: 'openExternalUrl',
					error: await openExternalUrl(msg.url)
				});
				break;
			case 'openFile':
				this.sendMessage({
					command: 'openFile',
					error: await openFile(msg.repo, msg.filePath, msg.hash, this.dataSource)
				});
				break;
			case 'openTerminal':
				this.sendMessage({
					command: 'openTerminal',
					error: await this.dataSource.openGitTerminal(msg.repo, null, msg.name)
				});
				break;
			case 'popStash':
				this.sendMessage({
					command: 'popStash',
					error: await this.dataSource.popStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'pruneRemote':
				this.sendMessage({
					command: 'pruneRemote',
					error: await this.dataSource.pruneRemote(msg.repo, msg.name)
				});
				break;
			case 'pullBranch':
				this.sendMessage({
					command: 'pullBranch',
					error: await this.dataSource.pullBranch(msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash)
				});
				break;
			case 'pushBranch':
				this.sendMessage({
					command: 'pushBranch',
					willUpdateBranchConfig: msg.willUpdateBranchConfig,
					errors: await this.dataSource.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode)
				});
				break;
			case 'pushStash':
				this.sendMessage({
					command: 'pushStash',
					error: await this.dataSource.pushStash(msg.repo, msg.message, msg.includeUntracked)
				});
				break;
			case 'pushTag':
				this.sendMessage({
					command: 'pushTag',
					repo: msg.repo,
					tagName: msg.tagName,
					remotes: msg.remotes,
					commitHash: msg.commitHash,
					errors: await this.dataSource.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck)
				});
				break;
			case 'rebase':
				this.sendMessage({
					command: 'rebase',
					actionOn: msg.actionOn,
					interactive: msg.interactive,
					error: await this.dataSource.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive)
				});
				break;
			case 'renameBranch':
				this.sendMessage({
					command: 'renameBranch',
					error: await this.dataSource.renameBranch(msg.repo, msg.oldName, msg.newName)
				});
				break;
			case 'rescanForRepos':
				if (!(await this.repoManager.searchWorkspaceForRepos())) {
					showErrorMessage('No Git repositories were found in the current workspace.');
				}
				break;
			case 'resetFileToRevision':
				this.sendMessage({
					command: 'resetFileToRevision',
					error: await this.dataSource.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath)
				});
				break;
			case 'resetToCommit':
				this.sendMessage({
					command: 'resetToCommit',
					error: await this.dataSource.resetToCommit(msg.repo, msg.commit, msg.resetMode)
				});
				break;
			case 'revertCommit':
				this.sendMessage({
					command: 'revertCommit',
					error: await this.dataSource.revertCommit(msg.repo, msg.commitHash, msg.parentIndex)
				});
				break;
			case 'editCommitMessage':
				this.sendMessage({
					command: 'editCommitMessage',
					error: await this.dataSource.editCommitMessage(msg.repo, msg.commitHash, msg.message)
				});
				break;

			case 'undoLastCommit':
				this.sendMessage({
					command: 'undoLastCommit',
					error: await this.dataSource.undoLastCommit(msg.repo)
				});
				break;

			case 'setGlobalViewState':
				this.sendMessage({
					command: 'setGlobalViewState',
					error: await this.extensionState.setGlobalViewState(msg.state)
				});
				break;
			case 'setRepoState':
				this.repoManager.setRepoState(msg.repo, msg.state);
				break;
			case 'setWorkspaceViewState':
				this.sendMessage({
					command: 'setWorkspaceViewState',
					error: await this.extensionState.setWorkspaceViewState(msg.state)
				});
				break;
			case 'showErrorMessage':
				showErrorMessage(msg.message);
				break;
			case 'startCodeReview':
				this.sendMessage({
					command: 'startCodeReview',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.extensionState.startCodeReview(msg.repo, msg.id, msg.files, msg.lastViewedFile)
				});
				break;
			case 'tagDetails':
				this.sendMessage({
					command: 'tagDetails',
					tagName: msg.tagName,
					commitHash: msg.commitHash,
					...await this.dataSource.getTagDetails(msg.repo, msg.tagName)
				});
				break;
			case 'updateCodeReview':
				this.sendMessage({
					command: 'updateCodeReview',
					error: await this.extensionState.updateCodeReview(msg.repo, msg.id, msg.remainingFiles, msg.lastViewedFile)
				});
				break;
			case 'viewDiff':
				this.sendMessage({
					command: 'viewDiff',
					error: await viewDiff(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type)
				});
				break;
			case 'viewDiffWithWorkingFile':
				this.sendMessage({
					command: 'viewDiffWithWorkingFile',
					error: await viewDiffWithWorkingFile(msg.repo, msg.hash, msg.filePath, this.dataSource)
				});
				break;
			case 'viewFileAtRevision':
				this.sendMessage({
					command: 'viewFileAtRevision',
					error: await viewFileAtRevision(msg.repo, msg.hash, msg.filePath)
				});
				break;
			case 'viewScm':
				this.sendMessage({
					command: 'viewScm',
					error: await viewScm()
				});
				break;
		}
	}

	/**
	 * Send a message to the front-end.
	 * @param msg The message to be sent.
	 */
	private sendMessage(msg: ResponseMessage) {
		if (this.isDisposed()) {
			this.logger.log('The Git Graph View has already been disposed, ignored sending "' + msg.command + '" message.');
		} else {
			this.panel.webview.postMessage(msg).then(
				() => { },
				() => {
					if (this.isDisposed()) {
						this.logger.log('The Git Graph View was disposed while sending "' + msg.command + '" message.');
					} else {
						this.logger.logError('Unable to send "' + msg.command + '" message to the Git Graph View.');
					}
				}
			);
		}
	}

	/**
	 * Update the HTML document loaded in the Webview.
	 */
	private update() {
		this.panel.webview.html = this.getHtmlForWebview();
	}

	/**
	 * Get the HTML document to be loaded in the Webview.
	 * @returns The HTML.
	 */
	private getHtmlForWebview() {
		const config = getConfig(), nonce = getNonce();
		const initialState: GitGraphViewInitialState = {
			config: {
				commitDetailsView: config.commitDetailsView,
				commitOrdering: config.commitOrder,
				contextMenuActionsVisibility: config.contextMenuActionsVisibility,
				customBranchGlobPatterns: config.customBranchGlobPatterns,
				customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
				customPullRequestProviders: config.customPullRequestProviders,
				dateFormat: config.dateFormat,
				dateType: config.dateType,
				defaultColumnVisibility: config.defaultColumnVisibility,
				stickyHeader: config.stickyHeader,
				dialogDefaults: config.dialogDefaults,
				enhancedAccessibility: config.enhancedAccessibility,
				fetchAndPrune: config.fetchAndPrune,
				fetchAndPruneTags: config.fetchAndPruneTags,
				fetchAvatars: config.fetchAvatars && this.extensionState.isAvatarStorageAvailable(),
				gerrit: config.gerrit,
				graph: config.graph,
				interfaceLanguage: config.interfaceLanguage,
				includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
				initialLoadCommits: config.initialLoadCommits,
				keybindings: config.keybindings,
				loadMoreCommits: config.loadMoreCommits,
				loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
				markdown: config.markdown,
				mute: config.muteCommits,
				showBodyInline: config.showCommitBodyInline,

				onlyFollowFirstParent: config.onlyFollowFirstParent,
				onRepoLoad: config.onRepoLoad,
				pullRequests: config.pullRequests,
				referenceLabels: config.referenceLabels,
				repoDropdownOrder: config.repoDropdownOrder,
				showCommitBodyInline: config.showCommitBodyInline,
				showRemoteBranches: config.showRemoteBranches,
				showRemoteHeads: config.showRemoteHeads,
				showStashes: config.showStashes,
				showTags: config.showTags,
				showUncommittedChanges: config.showUncommittedChanges,
				showUntrackedFiles: config.showUntrackedFiles,
				trackRemoteTags: config.trackRemoteTags
			},
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: this.loadViewTo,
			repos: this.repoManager.getRepos(),
			loadRepoInfoRefreshId: this.loadRepoInfoRefreshId,
			loadCommitsRefreshId: this.loadCommitsRefreshId
		};
		const globalState = this.extensionState.getGlobalViewState();
		const workspaceState = this.extensionState.getWorkspaceViewState();

		let body, numRepos = Object.keys(initialState.repos).length, colorVars = '', colorParams = '';
		for (let i = 0; i < initialState.config.graph.colours.length; i++) {
			colorVars += '--git-graph-color' + i + ':' + initialState.config.graph.colours[i] + '; ';
			colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ');} ';
		}

		if (this.dataSource.isGitExecutableUnknown()) {
			body = `<body class="unableToLoad">
			<h2>Unable to load Review Graph</h2>
			<p class="unableToLoadMessage">${UNABLE_TO_FIND_GIT_MSG}</p>
			</body>`;
		} else if (numRepos > 0) {
			const stickyClassAttr = initialState.config.stickyHeader ? ' class="sticky"' : '';
			body = `<body>
			<div id="view" tabindex="-1">
				<div id="headerRow"${stickyClassAttr}>
					<div id="controls">
						<span id="repoControl"><span id="repoControlLabel" class="unselectable"></span><div id="repoDropdown" class="dropdown"></div></span>
						<span id="branchControl"><span id="branchControlLabel" class="unselectable"></span><div id="branchDropdown" class="dropdown"></div></span>
						<span id="authorControl"><span id="authorControlLabel" class="unselectable"></span><div id="authorDropdown" class="dropdown"></div></span>

					<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span><span id="showRemoteBranchesLabel"></span></label>
					<div id="currentBtn"></div>
						<div id="findBtn"></div>
						<div id="filterBtn"></div>
						<div id="terminalBtn"></div>
						<div id="settingsBtn"></div>
						<div id="fetchBtn"></div>
						<div id="refreshBtn"></div>
					</div>
					<div id="gerritControls">
						<span id="gerritRowLabel" class="unselectable gerritRowLabel"></span>
						<span id="gerritFilterControl"></span>
						<div id="gerritAmendBtn"></div>
						<div id="gerritSubmitBtn"></div>
						<div id="gerritClearRefsBtn"></div>
						<div id="gerritHooksBtn"></div>
					</div>
					<div id="prStatus" style="display:none"></div>
					<div id="pinnedControls" style="display:none">
						<span id="pinnedRowLabel" class="unselectable pinnedRowLabel"></span>
					</div>
				</div>
				<div id="content">
					<div id="commitGraph"></div>
					<div id="commitTable"></div>
				</div>
				<div id="footer"></div>
			</div>
			<script nonce="${nonce}">var initialState = ${encodeJsonForInlineScript(JSON.stringify(initialState))}, globalState = ${encodeJsonForInlineScript(JSON.stringify(globalState))}, workspaceState = ${encodeJsonForInlineScript(JSON.stringify(workspaceState))};</script>
			<script nonce="${nonce}" src="${this.getMediaUri('out.min.js')}?v=${MEDIA_CACHE_VERSION}"></script>
			</body>`;
		} else {
			body = `<body class="unableToLoad">
			<h2>Unable to load Review Graph</h2>
			<p class="unableToLoadMessage">No Git repositories were found in the current workspace when it was last scanned by Git Graph.</p>
			<p>If your repositories are in subfolders of the open workspace folder(s), make sure you have set the Git Graph Setting "review-graph.maxDepthOfRepoSearch" appropriately (read the <a href="https://github.com/mhutchie/vscode-git-graph/wiki/Extension-Settings#max-depth-of-repo-search" target="_blank">documentation</a> for more information).</p>
			<p><div id="rescanForReposBtn" class="roundedBtn">Re-scan the current workspace for repositories</div></p>
			<script nonce="${nonce}">(function(){ var api = acquireVsCodeApi(); document.getElementById('rescanForReposBtn').addEventListener('click', function(){ api.postMessage({command: 'rescanForRepos'}); }); })();</script>
			</body>`;
		}
		this.isGraphViewLoaded = numRepos > 0;
		this.loadViewTo = null;

		return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(this.panel.webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" href="${this.getMediaUri('out.min.css')}?v=${MEDIA_CACHE_VERSION}">
				<title>Git Graph</title>
				<style>body{${colorVars}} ${colorParams}</style>
			</head>
			${body}
		</html>`;
	}


	/* Pull Request Methods */

	/**
	 * Get the pull/merge request whose source branch matches the checked-out branch of a repository.
	 * Degrades to NULL whenever the integration is disabled, the remote isn't hosted on GitHub or
	 * GitLab, or the API request fails (any failure is silent).
	 * @param repo The path of the repository.
	 * @param branch The branch name.
	 */
	private async fetchPullRequest(repo: string, branch: string) {
		if (!getConfig().pullRequests.enabled) return null;
		try {
			const remoteUrl = await this.dataSource.gitOutput(['remote', 'get-url', 'origin'], repo, (stdout) => stdout.trim());
			return await this.pullRequests.getPullRequestForBranch(remoteUrl, branch);
		} catch (_) {
			return null;
		}
	}


	/**
	 * Save the `review-graph.interfaceLanguage` setting to the Global User Settings. The
	 * onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
	 * with the new language (the settings page is restored from the persisted webview state).
	 * @param language The interface language.
	 * @returns The ErrorInfo of the failure (NULL => saved successfully).
	 */
	private async setInterfaceLanguage(language: 'en' | 'zh-cn'): Promise<ErrorInfo> {
		if (language !== 'en' && language !== 'zh-cn') return 'The interface language must be either "en" or "zh-cn".';
		try {
			await vscode.workspace.getConfiguration('review-graph').update('interfaceLanguage', language, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Saving the interface language failed: ' + message);
			return message;
		}
		return null;
	}

	/**
	 * Save a Global (User) Setting on behalf of the Settings Widget. Only the settings named by
	 * WRITABLE_GLOBAL_SETTINGS can be written, and only with a value their validator accepts.
	 * The onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
	 * with the new value (the settings page is restored from the persisted webview state).
	 * @param setting The key of the setting, relative to the `review-graph` section.
	 * @param value The new value of the setting.
	 * @returns The ErrorInfo of the failure (NULL => saved successfully).
	 */
	private async setGlobalSetting(setting: string, value: any): Promise<ErrorInfo> {
		const isValid = Object.prototype.hasOwnProperty.call(WRITABLE_GLOBAL_SETTINGS, setting)
			? WRITABLE_GLOBAL_SETTINGS[setting]
			: null;
		if (isValid === null) {
			this.logger.log('Rejected a request to save the setting "' + setting + '" (not a writable Global Setting).');
			return 'The setting "' + setting + '" cannot be changed from the Settings page.';
		}
		if (!isValid(value)) {
			return 'The value provided for the setting "' + setting + '" is invalid.';
		}
		try {
			await vscode.workspace.getConfiguration('review-graph').update(setting, value, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Saving the setting "' + setting + '" failed: ' + message);
			return message;
		}
		return null;
	}

	/* Gerrit Methods */

	/**
	 * Whether Gerrit integration is active: the global `gerrit.enabled` setting must be on, and the
	 * Gerrit controls bar must not be hidden (the "Show Gerrit Bar" toggle of the Repository Settings,
	 * which applies globally to every repository on this machine).
	 */
	private isGerritEnabled(): boolean {
		const config = getConfig().gerrit;
		return config.enabled && config.showControlsBar;
	}

	/**
	 * Load the Gerrit change states of a repository with the status filter applied.
	 * The unfiltered Gerrit data of each repository is cached, so that switching the status filter
	 * (or re-loading the Git Graph View) is displayed instantly. The cache is only refreshed when
	 * `forceRefresh` is set (the Refresh / Fetch actions), or after a Gerrit action invalidated it.
	 * Any failure degrades to NULL (the original Git Graph view without Gerrit data).
	 * @param repo The path of the repository.
	 * @param statusFilter The session status filter from the Git Graph View, or NULL to use the configured default.
	 * @param forceRefresh Whether the Gerrit data must be re-fetched from the remote, ignoring the cache.
	 */
	private async loadGerritData(repo: string, statusFilter: GerritStatusFilter | null, forceRefresh: boolean): Promise<{ states: GerritChangeState[], refs: string[] } | null> {
		const config = getConfig().gerrit;
		if (!this.isGerritEnabled() || config.fetchMode === 'off') return null;

		let cache = this.gerritCache.get(repo) || null;
		if (cache === null) {
			// No cached data (e.g. the extension just started): rebuild the cache from the locally
			// cached change refs, WITHOUT any network access, so the Gerrit data is displayed
			// instantly and works offline
			cache = await this.buildLocalGerritEntry(repo);
			if (cache !== null) this.gerritCache.set(repo, cache);
		}
		if (forceRefresh || this.gerritStaleRepos.has(repo) || cache === null) {
			// Reuse a fetch that is already in progress for this repository
			let fetch = this.gerritFetches.get(repo);
			if (fetch === undefined) {
				fetch = this.fetchGerritChanges(repo).then((entry) => {
					this.gerritFetches.delete(repo);
					return entry;
				});
				this.gerritFetches.set(repo, fetch);
			}
			const fetched = await fetch;
			if (fetched !== null) {
				this.gerritStaleRepos.delete(repo);
				cache = fetched;
			} // on failure, fall back to the local cache (if any) and keep the stale flag so the next load retries the fetch
		}
		if (cache === null) return null;
		return this.buildGerritViewData(cache, statusFilter);
	}

	/**
	 * Build a Gerrit cache entry from the locally cached change refs
	 * (`refs/remotes/<remote>/changes/*`) of a repository, WITHOUT any network access. This makes
	 * Gerrit data fetched previously available instantly (and offline), until the next refresh
	 * re-fetches it from the remote.
	 * @param repo The path of the repository.
	 * @returns The cache entry, or NULL if the repository has no local change refs.
	 */
	private async buildLocalGerritEntry(repo: string): Promise<GerritCacheEntry | null> {
		const config = getConfig().gerrit;
		const remote = config.remote, gerrit = this.dataSource.gerrit;
		try {
			const changes = new Map<number, number[]>();
			for (const ref of await gerrit.listLocalChangeRefs(repo, remote)) {
				const parsed = parseChangeRef(ref);
				if (parsed === null || parsed.meta || parsed.patchset === undefined) continue;
				const patchsets = changes.get(parsed.change);
				if (patchsets === undefined) changes.set(parsed.change, [parsed.patchset]);
				else if (!patchsets.includes(parsed.patchset)) patchsets.push(parsed.patchset);
			}
			if (changes.size === 0) return null;
			for (const patchsets of changes.values()) patchsets.sort((a, b) => a - b);

			// Both of these only read the local repository (git for-each-ref / git log / git config)
			const urlBase = await gerrit.getChangeUrlBase(repo, remote);
			const statesByChange = await gerrit.parseMetas(repo, remote, Array.from(changes.keys()), urlBase);
			const entry: GerritCacheEntry = { states: [], patchsets: new Map() };
			for (const [change, patchsets] of changes) {
				const state = statesByChange.get(change);
				if (state === undefined || state === null) continue; // meta ref not available locally
				entry.states.push(state);
				entry.patchsets.set(change, patchsets);
			}
			return entry.states.length > 0 ? entry : null;
		} catch (errorMessage) {
			this.logger.log('Building the Gerrit data from the local change refs failed: ' + errorMessage);
			return null;
		}
	}

	/**
	 * Get the Gerrit view data (filtered states + change refs to inject into the commit log) of a
	 * repository's cache WITHOUT triggering a fetch.
	 * @param repo The path of the repository.
	 * @param statusFilter The session status filter from the Git Graph View, or NULL to use the configured default.
	 * @returns The view data, or NULL if the repository has no Gerrit cache yet.
	 */
	private peekCachedGerritData(repo: string, statusFilter: GerritStatusFilter | null): { states: GerritChangeState[], refs: string[] } | null {
		const cache = this.gerritCache.get(repo);
		return cache !== undefined ? this.buildGerritViewData(cache, statusFilter) : null;
	}

	/**
	 * Derive the Gerrit view data of a cache entry: all cached states (the Webview applies the
	 * status filter locally, so toggling the filter chips re-renders instantly without a reload),
	 * and the change refs to inject into the commit log (built from the states passing the filter).
	 * @param cache The cache entry of the repository.
	 * @param statusFilter The session status filter from the Git Graph View, or NULL to use the configured default.
	 */
	private buildGerritViewData(cache: GerritCacheEntry, statusFilter: GerritStatusFilter | null): { states: GerritChangeState[], refs: string[] } {
		const config = getConfig().gerrit;
		const filter = statusFilter !== null ? statusFilter : config.statusFilter;
		const refs: string[] = [];
		if (config.includeChangeCommits) {
			for (const state of filterChangeStates(cache.states, filter)) {
				// Merged changes are already part of the target branch's history (their content was
				// submitted, possibly re-hashed by a cherry-pick/rebase submit strategy). Injecting their
				// patchset refs would add duplicate floating chains to the graph and push branch commits
				// out of the loaded commits window, so the "Merged" chip must only affect the review
				// info displayed, never the commits in the graph.
				if (state.status === 'merged') continue;
				const patchsets = cache.patchsets.get(state.change);
				if (patchsets === undefined) continue;
				const keep = config.patchsets === 'all' ? patchsets : [patchsets[patchsets.length - 1]];
				for (const patchset of keep) {
					refs.push('refs/remotes/' + config.remote + '/changes/' + changeShard(state.change) + '/' + state.change + '/' + patchset);
				}
			}
		}
		return { states: cache.states, refs: refs };
	}

	/**
	 * Complete a `loadCommits` request that was already answered without waiting for the
	 * uncommitted changes status (a `git status` that can be slow on large working trees, so it's
	 * deliberately excluded from the initial response). Fetches the status and sends the final
	 * `loadCommits` response marked `uncommittedPending: false`, prepending the synthetic
	 * "Uncommitted Changes" row to the SAME commit list already sent when there are uncommitted
	 * changes, so no Git commands (log/refs) are re-run. The Git Graph View keeps the previously
	 * rendered row (with its stale count) until this response arrives, so the row never flickers
	 * away and back on a refresh - only its count is updated.
	 * @param msg The original `loadCommits` request message.
	 * @param commitData The commit data already sent in the initial response.
	 * @param gerritStates The Gerrit states already sent in the initial response (unaffected by this follow-up).
	 */
	private async sendUncommittedChangesFollowUp(msg: RequestLoadCommits, commitData: GitCommitData, gerritStates: GerritChangeState[] | null) {
		// Match dataSource.getCommits: only prepend the row when HEAD is among the loaded commits
		// (with a filter or cutoff excluding HEAD, the row would have no parent in the graph).
		if (!getConfig().showUncommittedChanges || commitData.head === null || commitData.error !== null) return;
		if (!commitData.commits.some((commit) => commit.hash === commitData.head)) return;

		let numUncommittedChanges = 0;
		try {
			numUncommittedChanges = await this.dataSource.getUncommittedChanges(msg.repo);
		} catch (_) {
			numUncommittedChanges = 0;
		}
		if (this.loadCommitsRefreshId !== msg.refreshId) return; // superseded by a newer load request

		this.sendMessage({
			command: 'loadCommits',
			refreshId: msg.refreshId,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			gerritStates: gerritStates,
			commits: numUncommittedChanges > 0
				? [{
					hash: UNCOMMITTED,
					parents: [commitData.head],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: 'Uncommitted Changes (' + numUncommittedChanges + ')',
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				}, ...commitData.commits]
				: commitData.commits,
			head: commitData.head,
			tags: commitData.tags,
			moreCommitsAvailable: commitData.moreCommitsAvailable,
			error: null
		});
	}

	/**
	 * Load the commits of a `loadCommits` request, serving identical requests from the commit cache
	 * instead of re-running Git (see `commitCache`).
	 * @param msg The `loadCommits` request message.
	 * @param gerritRefs The list of Gerrit change refs allowed into the graph (NULL => Gerrit integration disabled).
	 * @param gerritShowChangeRefs Should the Gerrit change refs be displayed as remote branch refs.
	 * @param deferUncommittedChanges Skip computing the "Uncommitted Changes" row in the initial response.
	 * @param forceFresh Bypass the cache (forced refresh) and refresh the cached entry.
	 * @returns The commits in the repository.
	 */
	private async getCommitsCached(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, gerritShowChangeRefs: boolean, deferUncommittedChanges: boolean, forceFresh: boolean): Promise<GitCommitData> {
		const key = JSON.stringify([msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, gerritRefs, gerritShowChangeRefs, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges]);
		if (!forceFresh) {
			const cached = this.commitCache.get(key);
			if (cached !== undefined) return cached;
		}
		const promise: Promise<GitCommitData> = this.dataSource.getCommits(msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, gerritRefs, gerritShowChangeRefs, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges).then((commitData) => {
			if (commitData.error !== null && this.commitCache.get(key) === promise) {
				// Don't cache error results (they may be transient): allow the next call to retry
				this.commitCache.delete(key);
			}
			return commitData;
		});
		if (this.commitCache.size >= GitGraphView.COMMIT_CACHE_LIMIT) {
			this.commitCache.delete(this.commitCache.keys().next().value!); // evict the oldest entry
		}
		this.commitCache.set(key, promise);
		return promise;
	}

	/**
	 * Complete an asynchronous Gerrit load started by a `loadCommits` request that was already
	 * answered with the branch graph (marked `gerritPending`), and send the final `loadCommits`
	 * responses once the fresh Gerrit data is available. The update is delivered in stages, so
	 * each part of the view refreshes as soon as its data is ready:
	 *  1. meta: the fresh Gerrit states (review info), on the still unchanged commit graph;
	 *  2. branches: the commit graph, updated with the change refs of the fresh states;
	 *  3. refs: the change refs displayed as remote branch ref labels (only if enabled).
	 * A response is skipped when a newer load request supersedes it (the Git Graph View also
	 * guards this by the refresh id).
	 * @param msg The original `loadCommits` request message.
	 * @param gerritShowChangeRefs Should the Gerrit change refs be displayed as remote branch refs.
	 * @param previousRefs The change refs the pending response was rendered with (NULL => none).
	 * @param pendingCommitData The commit data already sent in the pending response (reused for stage 1,
	 * which only updates the Gerrit states - the commit graph itself is unchanged).
	 */
	private async loadCommitsGerritFollowUp(msg: RequestLoadCommits, gerritShowChangeRefs: boolean, previousRefs: string[] | null, pendingCommitData: GitCommitData) {
		const gerritData = await this.loadGerritData(msg.repo, msg.gerritStatusFilter, msg.gerritForceRefresh === true);
		if (this.loadCommitsRefreshId !== msg.refreshId) return; // superseded by a newer load request
		const getCommits = (refs: string[] | null, showChangeRefs: boolean) => this.getCommitsCached(msg, refs, showChangeRefs, false, false);
		const sendStage = async (states: GerritChangeState[] | null, refs: string[] | null, showChangeRefs: boolean) => {
			this.sendMessage({
				command: 'loadCommits',
				refreshId: msg.refreshId,
				onlyFollowFirstParent: msg.onlyFollowFirstParent,
				gerritStates: states,
				...await getCommits(refs, showChangeRefs)
			});
		};

		if (gerritData === null) {
			// The Gerrit pipeline failed: degrade to the plain view (as before)
			await sendStage(null, null, gerritShowChangeRefs);
			return;
		}

		// Stage 1 (meta): the fresh review info arrives first, on the unchanged commit graph. The
		// pending response already rendered that exact graph, so only the Gerrit states are swapped
		// in - no getCommits round-trip (which dominates the load time on large repositories) is run.
		if (previousRefs !== null) {
			this.sendMessage({
				command: 'loadCommits',
				refreshId: msg.refreshId,
				onlyFollowFirstParent: msg.onlyFollowFirstParent,
				gerritStates: gerritData.states,
				...pendingCommitData
			});
		} else {
			// The pending response was rendered without Gerrit refs: the graph must still be loaded
			await sendStage(gerritData.states, gerritData.refs, false);
			if (this.loadCommitsRefreshId !== msg.refreshId) return; // superseded by a newer load request
			if (gerritShowChangeRefs) await sendStage(gerritData.states, gerritData.refs, true);
			return;
		}
		if (this.loadCommitsRefreshId !== msg.refreshId) return; // superseded by a newer load request

		// The change refs are unchanged (e.g. a refresh that brought no new changes): the commit
		// graph of stages 2 and 3 would be identical, so skip their getCommits round-trips entirely
		if (previousRefs.length === gerritData.refs.length && previousRefs.every((ref, i) => ref === gerritData.refs[i])) return;

		// Stage 2 (branches): the commit graph is updated with the change refs of the fresh states
		await sendStage(gerritData.states, gerritData.refs, false);
		if (this.loadCommitsRefreshId !== msg.refreshId) return; // superseded by a newer load request

		// Stage 3 (refs): display the change refs as remote branch ref labels
		if (gerritShowChangeRefs) await sendStage(gerritData.states, gerritData.refs, true);
	}

	/**
	 * Run the Gerrit refresh pipeline: ls-remote probe, targeted fetch, prune and meta parsing.
	 * The unfiltered result is stored in the Gerrit cache of the repository.
	 * @param repo The path of the repository.
	 * @returns The cache entry, or NULL if the pipeline failed (the previously cached data is kept).
	 */
	private async fetchGerritChanges(repo: string): Promise<GerritCacheEntry | null> {
		const config = getConfig().gerrit, generation = this.gerritCacheGeneration;
		const remote = config.remote, gerrit = this.dataSource.gerrit;
		try {
			const changes = config.fetchMode === 'all'
				? await gerrit.listRemoteChanges(repo, remote)
				: limitChanges(await gerrit.listRemoteChanges(repo, remote), config.fetchLimit);
			if (changes.size === 0 && (await gerrit.listLocalChangeRefs(repo, remote)).length > 0) {
				// ls-remote returned nothing while local change refs exist: the remote is unreachable
				// (a timeout resolves with an empty map). Fail, so the previously cached (or locally
				// rebuilt) Gerrit data keeps being displayed instead of an empty view.
				this.logger.log('Gerrit ls-remote returned no changes while local change refs exist (remote unreachable?), keeping the local Gerrit data.');
				return null;
			}
			const entry: GerritCacheEntry = { states: [], patchsets: new Map() };
			if (changes.size > 0) {
				// Resolve the change URL base concurrently with the fetch (it doesn't depend on it)
				const urlBasePromise = gerrit.getChangeUrlBase(repo, remote);
				const fetchError = await gerrit.fetchChanges(repo, remote, buildFetchRefspecs(changes, remote, config.patchsets));
				if (fetchError !== null) {
					this.logger.log('Gerrit fetch failed: ' + fetchError);
					return null;
				}
				const pruneError = await gerrit.pruneLocalChanges(repo, remote, Array.from(changes.keys()));
				if (pruneError !== null) this.logger.log('Gerrit ref pruning failed (stale change refs may accumulate): ' + pruneError);

				// Parse the NoteDb meta histories of all changes concurrently: a single Git command
				// resolves every meta ref hash (so unchanged metas are served from the cache), and
				// the remaining histories are parsed by a pool of concurrent Git commands
				const urlBase = await urlBasePromise;
				const statesByChange = await gerrit.parseMetas(repo, remote, Array.from(changes.keys()), urlBase);
				for (const [change, patchsets] of changes) {
					const state = statesByChange.get(change);
					if (state === undefined || state === null) continue; // meta ref not available locally
					entry.states.push(state);
					entry.patchsets.set(change, patchsets);
				}
			}
			// Only cache the result if the fetch settings didn't change while the pipeline was running
			if (generation === this.gerritCacheGeneration) this.gerritCache.set(repo, entry);
			return entry;
		} catch (errorMessage) {
			this.logger.log('Gerrit refresh pipeline failed: ' + errorMessage);
			return null;
		}
	}

	/**
	 * Mark the cached Gerrit data of a repository as stale, so that the next load re-fetches it
	 * from the remote (falling back to the locally cached change refs if the remote is unreachable).
	 * @param repo The path of the repository.
	 */
	private invalidateGerritCache(repo: string) {
		this.gerritStaleRepos.add(repo);
	}

	/**
	 * Save the Gerrit change refs cache configuration (cache all open changes, or only the latest N
	 * changes) to the global User Settings, and invalidate the Gerrit cache so that the new
	 * configuration takes effect on the next load of the Git Graph View.
	 * @param fetchMode Should all open changes be cached, or only the latest N changes.
	 * @param fetchLimit The number of latest changes to cache (only used in 'latest' fetch mode).
	 * @returns The ErrorInfo of the failure (NULL => saved successfully).
	 */
	private async gerritSaveFetchConfig(fetchMode: 'latest' | 'all', fetchLimit: number): Promise<ErrorInfo> {
		if (fetchMode !== 'latest' && fetchMode !== 'all') {
			return 'The Gerrit change refs cache mode must be either "All open changes" or "Latest changes only".';
		}
		let limit = normalizeGerritFetchLimit(fetchLimit);
		if (limit === null) {
			if (fetchMode === 'latest') {
				return 'The number of changes to cache must be a whole number between 1 and 10000.';
			}
			// The limit isn't used in 'all' fetch mode: keep the currently configured value
			limit = getConfig().gerrit.fetchLimit;
		}

		const config = vscode.workspace.getConfiguration('review-graph');
		try {
			await config.update('gerrit.fetchMode', fetchMode, vscode.ConfigurationTarget.Global);
			await config.update('gerrit.fetchLimit', limit, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Saving Gerrit fetch settings failed: ' + message);
			return message;
		}

		// Invalidate the cached Gerrit data and any in-flight fetches (which used the previous
		// settings): the onDidChangeConfiguration listener reloads the Git Graph View, causing the
		// next load to fetch exactly the configured number of changes (pruning any surplus local refs)
		for (const repo of this.gerritCache.keys()) this.gerritStaleRepos.add(repo);
		this.gerritCache.clear();
		this.gerritFetches.clear();
		this.gerritCacheGeneration++;
		return null;
	}

	/**
	 * Show or hide the Gerrit controls bar (saved to the Global User Settings, so it applies to every
	 * repository on this machine). Hiding it also deletes the repository's locally cached Gerrit
	 * change refs and invalidates all cached Gerrit data, so nothing is fetched or displayed.
	 * @param repo The path of the repository the setting was toggled in.
	 * @param enabled Whether the Gerrit controls bar should be shown.
	 * @returns The ErrorInfo of the failure (NULL => saved successfully).
	 */
	private async gerritSetControlsBar(repo: string, enabled: boolean): Promise<ErrorInfo> {
		try {
			await vscode.workspace.getConfiguration('review-graph').update('gerrit.showControlsBar', enabled, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Saving the Gerrit controls bar setting failed: ' + message);
			return message;
		}

		if (!enabled) {
			// The Gerrit bar was hidden: delete the locally cached change refs of the repository, so
			// they are not served (offline) either, and drop all cached Gerrit data of every repository
			const result = await this.dataSource.gerrit.clearLocalChanges(repo, getConfig().gerrit.remote);
			if (result.error !== null) this.logger.log('Clearing the Gerrit change refs failed: ' + result.error);
		}
		this.gerritStaleRepos.clear();
		this.gerritCache.clear();
		this.gerritFetches.clear();
		this.gerritCacheGeneration++;
		return null;
	}

	/**
	 * Push a commit to `refs/for/<branch>` for review, amending a Change-Id onto HEAD if required.
	 */
	private async gerritSubmitReview(repo: string, hash: string | null, branch: string) {
		// Validate the untrusted hash and branch before they are passed to git
		if (hash !== null && !isValidCommitHash(hash)) return { error: 'Invalid commit hash was provided', url: <string | null>null };
		if (!isSafeRefName(branch)) return { error: 'Invalid reference name was provided', url: <string | null>null };

		const config = getConfig().gerrit, revision = hash !== null ? hash : 'HEAD';
		try {
			if (revision === 'HEAD') {
				const amendError = await this.ensureChangeId(repo);
				if (amendError !== null) return { error: amendError, url: <string | null>null };
			} else if (!hasChangeId(await this.dataSource.gitOutput(['log', '-1', '--format=%B', revision, '--'], repo, (stdout) => stdout))) {
				return { error: 'The commit doesn\'t have a Change-Id footer. Rebase it onto HEAD and use "Submit for Review" from HEAD, or add the Change-Id manually.', url: <string | null>null };
			}

			const url = await this.dataSource.gitOutput(
				['push', config.remote, revision + ':refs/for/' + branch],
				repo,
				(stdout) => {
					const match = /(https?:\/\/\S*\/c\/\S*\/\+?\/?\d+)/.exec(stdout.replace(/\r?\n/g, ' '));
					return match !== null ? match[1] : null;
				}
			).catch((errorMessage: string) => {
				throw errorMessage;
			});

			if (url !== null) {
				vscode.window.showInformationMessage('Successfully submitted for review: ' + url, 'Open Change').then((action) => {
					if (action === 'Open Change') openExternalUrl(url);
				});
			}
			this.invalidateGerritCache(repo); // the new change must be picked up by the next load
			return { error: <ErrorInfo>null, url: url };
		} catch (errorMessage) {
			return { error: errorMessage, url: <string | null>null };
		}
	}

	/**
	 * Ensure that HEAD has a Change-Id footer, amending the commit if (and only if) it is safe to do so.
	 * @returns The ErrorInfo from the operation (NULL => HEAD already had a Change-Id, or one was amended).
	 */
	private ensureChangeId(repo: string): Promise<ErrorInfo> {
		return this.resolveHeadChangeId(repo, true).then((result) => result.error);
	}

	/**
	 * Amend a newly generated Gerrit Change-Id onto HEAD (the "Amend Change-Id" action).
	 * HEAD is only amended when it has no Change-Id yet, and hasn't been pushed to any remote.
	 * @returns The ErrorInfo of the operation, the Change-Id of HEAD and whether it was newly amended.
	 */
	private gerritAmendChangeId(repo: string): Promise<{ error: ErrorInfo, changeId: string | null, amended: boolean }> {
		return this.resolveHeadChangeId(repo, false);
	}

	/**
	 * Shared implementation of `ensureChangeId` and `gerritAmendChangeId`: ensure that HEAD has a
	 * Change-Id footer, amending the commit if (and only if) it is safe to do so.
	 * @param repo The path of the repository.
	 * @param confirm Ask the user to confirm the amend before performing it (used by the "Submit for
	 * Review" flow, where amending is a side effect of another action, rather than the action itself).
	 * @returns The ErrorInfo of the operation, the Change-Id of HEAD and whether it was newly amended.
	 */
	private async resolveHeadChangeId(repo: string, confirm: boolean): Promise<{ error: ErrorInfo, changeId: string | null, amended: boolean }> {
		try {
			const message = await this.getHeadCommitMessage(repo);
			const existing = extractChangeId(message);
			if (existing !== null) return { error: null, changeId: existing, amended: false }; // nothing to amend

			const remotes = await this.getHeadContainingRemotes(repo);
			if (remotes.length > 0) return { error: this.getPushedChangeIdError(remotes[0]), changeId: null, amended: false };

			const changeId = await this.generateHeadChangeId(repo);
			if (confirm) {
				const action = await vscode.window.showInformationMessage(
					'HEAD doesn\'t have a Gerrit Change-Id. Amend it with Change-Id ' + changeId.substring(0, 12) + '... before submitting for review?',
					'Yes, amend and push',
					'No, cancel'
				);
				if (action !== 'Yes, amend and push') return { error: 'Aborted: HEAD has no Change-Id.', changeId: null, amended: false };
			}

			const error = await this.amendHeadWithChangeId(repo, message, changeId);
			return { error: error, changeId: changeId, amended: error === null };
		} catch (errorMessage) {
			return { error: errorMessage, changeId: null, amended: false };
		}
	}

	/**
	 * Get the full commit message of HEAD.
	 */
	private getHeadCommitMessage(repo: string) {
		return this.dataSource.gitOutput(['log', '-1', '--format=%B', 'HEAD', '--'], repo, (stdout) => stdout);
	}

	/**
	 * Get the remote branches that contain HEAD (used to check whether HEAD has already been pushed).
	 */
	private getHeadContainingRemotes(repo: string) {
		return this.dataSource.gitOutput(['branch', '-r', '--contains=HEAD'], repo, (stdout) =>
			stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
		);
	}

	private getPushedChangeIdError(remote: string) {
		return 'HEAD doesn\'t have a Change-Id, but has already been pushed to a remote (' + remote + '). Add the Change-Id manually (e.g. with the Gerrit commit-msg hook) and try again.';
	}

	/**
	 * Generate the Change-Id Gerrit would assign to HEAD (same construction as the commit-msg hook).
	 */
	private generateHeadChangeId(repo: string) {
		return this.dataSource.gitOutput(['show', '-s', '--format=%T%n%P%n%an <%ae> %at%n%cn <%ce> %ct%n%B', 'HEAD'], repo, (stdout) => {
			const lines = stdout.split(/\r?\n/);
			return generateChangeId(lines[0], lines[1], lines[2], lines[3], lines.slice(4).join('\n'));
		});
	}

	/**
	 * Amend HEAD with the given message, appending the given Change-Id as a footer.
	 * @returns The ErrorInfo of the amend command (NULL => success).
	 */
	private amendHeadWithChangeId(repo: string, message: string, changeId: string): Promise<ErrorInfo> {
		return this.dataSource.runGitCommand(['commit', '--amend', '-m', message.replace(/\s+$/, '') + '\n\nChange-Id: ' + changeId], repo);
	}

	/**
	 * Fetch the latest patchset (and meta ref) of a single change.
	 */
	private async gerritFetchChange(repo: string, change: number): Promise<ErrorInfo> {
		// The change number is received from the webview and interpolated into refs, so it must be
		// validated to be a positive integer
		if (typeof change !== 'number' || !isFinite(change) || change < 1 || Math.floor(change) !== change) {
			return 'Invalid change number was provided';
		}

		const config = getConfig().gerrit;
		try {
			const output = await this.dataSource.gitOutput(['ls-remote', config.remote, 'refs/changes/' + changeShard(change) + '/' + change + '/*'], repo, (stdout) => stdout);
			const patchsets = parseLsRemoteChanges(output).get(change);
			if (patchsets === undefined) return 'Change ' + change + ' was not found on the remote "' + config.remote + '".';
			const changes = new Map([[change, patchsets]]);
			const error = await this.dataSource.gerrit.fetchChanges(repo, config.remote, buildFetchRefspecs(changes, config.remote, 'latest'));
			if (error === null) this.invalidateGerritCache(repo); // the fetched patchset must be picked up by the next load
			return error;
		} catch (errorMessage) {
			return errorMessage;
		}
	}

	/**
	 * Delete every locally downloaded Gerrit change ref (refs/remotes/<remote>/changes/*) of a repository,
	 * and turn Gerrit change fetching off so a refresh doesn't immediately re-download the deleted refs
	 * (where they would clutter other Git graph views reading the repository's refs).
	 */
	private async gerritClearRefs(repo: string): Promise<{ error: ErrorInfo; cleared: number }> {
		const config = getConfig().gerrit;
		const result = await this.dataSource.gerrit.clearLocalChanges(repo, config.remote);
		if (result.error !== null) return result;

		if (config.fetchMode !== 'off') this.gerritFetchModeRestore = config.fetchMode === 'all' ? 'all' : 'latest';
		try {
			await vscode.workspace.getConfiguration('review-graph').update('gerrit.fetchMode', 'off', vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Turning Gerrit change fetching off failed: ' + message);
			return { error: <ErrorInfo>message, cleared: result.cleared };
		}

		// Drop all cached Gerrit data, so the deleted refs are not served (offline) either; the
		// onDidChangeConfiguration listener reloads the Git Graph View with fetching disabled
		this.gerritStaleRepos.clear();
		this.gerritCache.clear();
		this.gerritFetches.clear();
		this.gerritCacheGeneration++;
		return result;
	}

	/**
	 * Re-enable Gerrit change fetching (which the "Clear Refs" action turned off), restoring the
	 * fetch mode that was active before. The configuration change reloads the Git Graph View, which
	 * re-downloads the change refs.
	 */
	private async gerritEnableFetching(): Promise<ErrorInfo> {
		try {
			await vscode.workspace.getConfiguration('review-graph').update('gerrit.fetchMode', this.gerritFetchModeRestore, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Turning Gerrit change fetching back on failed: ' + message);
			return message;
		}

		// Drop all cached Gerrit data, so the change refs are freshly fetched on the next load
		this.gerritStaleRepos.clear();
		this.gerritCache.clear();
		this.gerritFetches.clear();
		this.gerritCacheGeneration++;
		return null;
	}

	/**
	 * Get the status of the tracked Git hooks of a repository.
	 */
	private async gerritGetHookStatus(repo: string): Promise<{ error: ErrorInfo; hooks: { name: string; installed: boolean; installable: boolean }[] }> {
		return this.dataSource.gerrit.getHookStatus(repo);
	}

	/**
	 * Download a Git hook from the Gerrit server and install it into the repository's hooks directory.
	 */
	private async gerritInstallHook(repo: string, hook: string): Promise<{ error: ErrorInfo; installed: boolean }> {
		return this.dataSource.gerrit.installHook(repo, getConfig().gerrit.remote, hook);
	}

	/**
	 * Create a fixup/squash commit for the target commit and autosquash it via a non-interactive rebase.
	 */
	private async gerritAutosquash(repo: string, commitHash: string, mode: 'fixup' | 'squash'): Promise<ErrorInfo> {
		// The commit hash is passed to git rebase as a bare argument (commitHash + '^'), so it must
		// be validated to prevent it from being misinterpreted as a git option (e.g. `--exec`)
		if (!isValidCommitHash(commitHash)) return 'Invalid commit hash was provided';

		let error = await this.dataSource.runGitCommand(['commit', '--' + mode + '=' + commitHash], repo);
		if (error !== null) return error;
		error = await this.dataSource.runGitCommand(['-c', 'sequence.editor=true', 'rebase', '-i', '--autosquash', '--autostash', commitHash + '^'], repo);
		if (error !== null) {
			// Abort the rebase so the repository isn't left in a conflicting state
			await this.dataSource.runGitCommand(['rebase', '--abort'], repo);
			return 'The ' + mode + ' rebase encountered conflicts and was aborted. Please resolve the changes manually.';
		}
		this.invalidateGerritCache(repo); // the rewritten commits must be re-matched with the Gerrit changes
		return null;
	}

	/* URI Manipulation Methods */

	/**
	 * Get a WebviewUri for a media file included in the extension.
	 * @param file The file name in the `media` directory.
	 * @returns The WebviewUri.
	 */
	private getMediaUri(file: string) {
		return this.panel.webview.asWebviewUri(this.getUri('media', file));
	}

	/**
	 * Get a File Uri for a resource file included in the extension.
	 * @param file The file name in the `resource` directory.
	 * @returns The Uri.
	 */
	private getResourcesUri(file: string) {
		return this.getUri('resources', file);
	}

	/**
	 * Get a File Uri for a file included in the extension.
	 * @param pathComps The path components relative to the root directory of the extension.
	 * @returns The File Uri.
	 */
	private getUri(...pathComps: string[]) {
		return vscode.Uri.file(path.join(this.extensionPath, ...pathComps));
	}


	/* Response Construction Methods */

	/**
	 * Send the known repositories to the front-end.
	 * @param repos The set of known repositories.
	 * @param loadViewTo What to load the view to.
	 */
	private respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitGraphViewTo) {
		this.sendMessage({
			command: 'loadRepos',
			repos: repos,
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo
		});
	}
}

/**
 * Standardise the CSP Source provided by Visual Studio Code for use with the Webview. It is idempotent unless called with http/https URI's, in which case it keeps only the authority portion of the http/https URI. This is necessary to be compatible with some web browser environments.
 * @param cspSource The value provide by Visual Studio Code.
 * @returns The standardised CSP Source.
 */
export function standardiseCspSource(cspSource: string) {
	if (cspSource.startsWith('http://') || cspSource.startsWith('https://')) {
		const pathIndex = cspSource.indexOf('/', 8), queryIndex = cspSource.indexOf('?', 8), fragmentIndex = cspSource.indexOf('#', 8);
		let endOfAuthorityIndex = pathIndex;
		if (queryIndex > -1 && (queryIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = queryIndex;
		if (fragmentIndex > -1 && (fragmentIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = fragmentIndex;
		return endOfAuthorityIndex > -1 ? cspSource.substring(0, endOfAuthorityIndex) : cspSource;
	} else {
		return cspSource;
	}
}
