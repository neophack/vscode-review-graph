import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/avatarManager');
jest.mock('../src/dataSource');
jest.mock('../src/extensionState');
jest.mock('../src/logger');
jest.mock('../src/repoManager');

import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { AvatarEvent, AvatarManager } from '../src/avatarManager';
import { DataSource } from '../src/dataSource';
import { ExtensionState } from '../src/extensionState';
import { GitGraphView, standardiseCspSource } from '../src/gitGraphView';
import { Logger } from '../src/logger';
import { RepoChangeEvent, RepoManager } from '../src/repoManager';
import { CodeReview, CommitOrdering, GitCommitStash, GitConfigLocation, GitFileStatus, GitGraphViewGlobalState, GitGraphViewWorkspaceState, GitPushBranchMode, GitResetMode, MergeActionOn, PullRequestConfig, PullRequestProvider, RebaseActionOn, RequestMessage, ResponseMessage, TagType } from '../src/types';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';

import { waitForExpect } from './helpers/expectations';
import { mockRepoState } from './helpers/utils';

describe('GitGraphView', () => {
	let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
	let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
	let onDidChangeRepos: EventEmitter<RepoChangeEvent>;
	let onAvatar: EventEmitter<AvatarEvent>;

	let logger: Logger;
	let dataSource: DataSource;
	let extensionState: ExtensionState;
	let avatarManager: AvatarManager;
	let repoManager: RepoManager;

	let spyOnLog: jest.SpyInstance;
	let spyOnLogError: jest.SpyInstance;
	let spyOnGetRepos: jest.SpyInstance;
	let spyOnIsGitExecutableUnknown: jest.SpyInstance;

	beforeAll(() => {
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
		onDidChangeRepos = new EventEmitter<RepoChangeEvent>();
		onAvatar = new EventEmitter<AvatarEvent>();

		logger = new Logger();
		dataSource = new DataSource({ path: '/path/to/git', version: '2.25.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		extensionState = new ExtensionState(vscode.mocks.extensionContext, onDidChangeGitExecutable.subscribe);
		avatarManager = new AvatarManager(dataSource, extensionState, logger);
		repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration.subscribe, logger);

		spyOnLog = jest.spyOn(logger, 'log');
		spyOnLogError = jest.spyOn(logger, 'logError');
		spyOnGetRepos = jest.spyOn(repoManager, 'getRepos');
		spyOnIsGitExecutableUnknown = jest.spyOn(dataSource, 'isGitExecutableUnknown');

		spyOnGetRepos.mockReturnValue({ '/path/to/repo': mockRepoState() });
		spyOnIsGitExecutableUnknown.mockReturnValue(false);
		Object.defineProperty(repoManager, 'onDidChangeRepos', {
			get: () => onDidChangeRepos.subscribe
		});
		Object.defineProperty(avatarManager, 'onAvatar', {
			get: () => onAvatar.subscribe
		});
		jest.spyOn(extensionState, 'getLastActiveRepo').mockReturnValue(null);
		jest.spyOn(extensionState, 'getGlobalViewState').mockReturnValue({
			alwaysAcceptCheckoutCommit: true,
			issueLinkingConfig: null,
			pushTagSkipRemoteCheck: false
		});
		jest.spyOn(extensionState, 'getWorkspaceViewState').mockReturnValue({ findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false });
	});

	afterAll(() => {
		repoManager.dispose();
		avatarManager.dispose();
		extensionState.dispose();
		dataSource.dispose();
		logger.dispose();
		onAvatar.dispose();
		onDidChangeRepos.dispose();
		onDidChangeGitExecutable.dispose();
		onDidChangeConfiguration.dispose();
	});

	afterEach(() => {
		if (GitGraphView.currentPanel) {
			GitGraphView.currentPanel.dispose();
		}
	});

	describe('WebviewPanel Construction', () => {
		it('Should construct a new WebviewPanel', () => {
			// Setup
			vscode.window.activeTextEditor = {
				document: {
					uri: vscode.Uri.file('/path/to/workspace-folder/active-file.txt')
				},
				viewColumn: vscode.ViewColumn.Two
			};

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('review-graph', 'Review Graph', vscode.ViewColumn.Two, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: true
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Graph View');
		});

		it('Should reveal the existing WebviewPanel (when one exists)', () => {
			// Setup
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
		});

		it('Should reveal the existing WebviewPanel (when one exists, but it isn\'t visible)', () => {
			// Setup
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			mockedWebviewPanel.mocks.panel.setVisibility(false);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([]);
		});

		it('Should reveal the existing WebviewPanel (when one exists), and send loadViewTo', () => {
			// Setup
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
				{
					command: 'loadRepos',
					lastActiveRepo: null,
					loadViewTo: { repo: '/path/to/repo' },
					repos: {
						'/path/to/repo': mockRepoState()
					}
				}
			]);
		});

		it('Should construct a new WebviewPanel, providing loadViewTo', () => {
			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Graph View (active repo: /path/to/repo)');
			expect(mockedWebviewPanel.panel.webview.html).toContain('"loadViewTo":{"repo":"/path/to/repo"}');
		});

		it('Should construct a new WebviewPanel (no active text editor)', () => {
			// Setup
			vscode.window.activeTextEditor = undefined;

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('review-graph', 'Review Graph', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: true
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Graph View');
		});

		it('Should construct a WebviewPanel with retainContextWhenHidden set to TRUE', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('retainContextWhenHidden', true);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('review-graph', 'Review Graph', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: true
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Graph View');
		});

		it('Should construct a WebviewPanel with retainContextWhenHidden set to FALSE', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('retainContextWhenHidden', false);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('review-graph', 'Review Graph', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: false
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Graph View');
		});

		it('Should construct a WebviewPanel with a colour icon', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('tabIconColourTheme', 'colour');

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.iconPath).toStrictEqual(vscode.Uri.file(path.join('/path/to/extension', 'resources', 'gerrit-webview-icon.svg')));
		});

		it('Should construct a WebviewPanel with a grey icon', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('tabIconColourTheme', 'grey');

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.iconPath).toStrictEqual({
				light: vscode.Uri.file(path.join('/path/to/extension', 'resources', 'gerrit-webview-icon-light.svg')),
				dark: vscode.Uri.file(path.join('/path/to/extension', 'resources', 'gerrit-webview-icon-dark.svg'))
			});
		});

		describe('WebviewPanel.onDidDispose', () => {
			it('Should dispose the GitGraphView when the WebviewPanel is disposed', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.onDidDispose();

				// Asset
				expect(GitGraphView.currentPanel).toBeUndefined();
			});
		});

		describe('WebviewPanel.onDidChangeViewState', () => {
			it('Should transition from visible to not-visible correctly', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				const spyOnRepoFileWatcherStop = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'stop');

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(false);

				// Assert
				expect(GitGraphView.currentPanel!['currentRepo']).toBeNull();
				expect(spyOnRepoFileWatcherStop).toHaveBeenCalledTimes(1);
				expect(GitGraphView.currentPanel!['isPanelVisible']).toBe(false);
			});

			it('Should transition from not-visible to visible correctly', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				GitGraphView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).not.toBe('');
				expect(GitGraphView.currentPanel!['isPanelVisible']).toBe(true);
			});

			it('Should ignore events if they have no effect', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				GitGraphView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).toBe('');
				expect(GitGraphView.currentPanel!['isPanelVisible']).toBe(true);
			});
		});

		describe('RepoManager.onDidChangeRepos', () => {
			it('Should send the updated repositories to the front-end when the view is already loaded', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: null
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'loadRepos',
						lastActiveRepo: null,
						loadViewTo: null,
						repos: {
							'/path/to/repo': mockRepoState()
						}
					}
				]);
			});

			it('Should send the updated repositories to the front-end when the view is already loaded (with loadViewTo)', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: '/path/to/repo'
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'loadRepos',
						lastActiveRepo: null,
						loadViewTo: {
							repo: '/path/to/repo'
						},
						repos: {
							'/path/to/repo': mockRepoState()
						}
					}
				]);
			});

			it('Shouldn\'t send the updated repositories to the front-end when the view is not visible', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);

				// Run
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: null
				});

				// Assert
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
			});

			it('Should transition to no repositories correctly', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				spyOnGetRepos.mockReturnValueOnce({});

				// Run
				onDidChangeRepos.emit({
					repos: {},
					numRepos: 0,
					loadRepo: null
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
				expect(mockedWebviewPanel.panel.webview.html).toContain('No Git repositories were found');
			});

			it('Should transition from no repositories correctly', () => {
				// Setup
				spyOnGetRepos.mockReturnValueOnce({});
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onDidChangeRepos.emit({
					repos: {
						'/path/to/repo': mockRepoState()
					},
					numRepos: 1,
					loadRepo: '/path/to/repo'
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
				expect(mockedWebviewPanel.panel.webview.html).toContain('"loadViewTo":{"repo":"/path/to/repo"}');
			});
		});

		describe('AvatarManager.onAvatar', () => {
			it('Should send the avatar', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onAvatar.emit({
					email: 'user1@mhutchie.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'fetchAvatar',
						email: 'user1@mhutchie.com',
						image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
					}
				]);
			});
		});

		describe('RepoFileWatcher.repoChangeCallback', () => {
			it('Should refresh the view when it\'s visible', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				GitGraphView.currentPanel!['repoFileWatcher']['repoChangeCallback']();

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'refresh'
					}
				]);
			});

			it('Shouldn\'t refresh the view when it isn\'t visible', () => {
				// Setup
				GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);

				// Run
				GitGraphView.currentPanel!['repoFileWatcher']['repoChangeCallback']();

				// Assert
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
			});
		});
	});

	describe('respondToMessage', () => {
		let onDidReceiveMessage: (msg: RequestMessage) => void;
		let messages: ResponseMessage[];

		let spyOnRepoFileWatcherMute: jest.SpyInstance;
		let spyOnRepoFileWatcherUnmute: jest.SpyInstance;
		beforeEach(() => {
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);

			onDidReceiveMessage = mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage;
			messages = mockedWebviewPanel.mocks.messages;

			spyOnRepoFileWatcherMute = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'mute');
			spyOnRepoFileWatcherUnmute = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'unmute');
		});

		afterEach(() => {
			expect(spyOnRepoFileWatcherMute).toHaveBeenCalledWith();
			expect(spyOnRepoFileWatcherUnmute).toHaveBeenCalledWith();
		});

		describe('addRemote', () => {
			it('Should add a remote', async () => {
				// Setup
				const addRemoteResolvedValue = null;
				const spyOnAddRemote = jest.spyOn(dataSource, 'addRemote');
				spyOnAddRemote.mockResolvedValueOnce(addRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addRemote',
					repo: '/path/to/repo',
					name: 'origin',
					url: 'url',
					pushUrl: 'pushUrl',
					fetch: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddRemote).toHaveBeenCalledWith('/path/to/repo', 'origin', 'url', 'pushUrl', true);
					expect(messages).toStrictEqual([
						{
							command: 'addRemote',
							error: addRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('addTag', () => {
			it('Should add a tag', async () => {
				// Setup
				const addTagResolvedValue = null;
				const spyOnAddTag = jest.spyOn(dataSource, 'addTag');
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnAddTag.mockResolvedValueOnce(addTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addTag',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					tagName: 'name',
					type: TagType.Annotated,
					message: 'message',
					pushToRemote: null,
					pushSkipRemoteCheck: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddTag).toHaveBeenCalledWith('/path/to/repo', 'name', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', TagType.Annotated, 'message', false);
					expect(spyOnPushTag).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'addTag',
							repo: '/path/to/repo',
							tagName: 'name',
							pushToRemote: null,
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: [addTagResolvedValue]
						}
					]);
				});
			});

			it('Should add a tag, and then push the tag to a remote', async () => {
				// Setup
				const addTagResolvedValue = null;
				const spyOnPushTagResolvedValue = [null];
				const spyOnAddTag = jest.spyOn(dataSource, 'addTag');
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnAddTag.mockResolvedValueOnce(addTagResolvedValue);
				spyOnPushTag.mockResolvedValueOnce(spyOnPushTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addTag',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					tagName: 'name',
					type: TagType.Annotated,
					message: 'message',
					pushToRemote: 'origin',
					pushSkipRemoteCheck: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddTag).toHaveBeenCalledWith('/path/to/repo', 'name', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', TagType.Annotated, 'message', false);
					expect(spyOnPushTag).toHaveBeenCalledWith('/path/to/repo', 'name', ['origin'], '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true);
					expect(messages).toStrictEqual([
						{
							command: 'addTag',
							repo: '/path/to/repo',
							tagName: 'name',
							pushToRemote: 'origin',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: [addTagResolvedValue, spyOnPushTagResolvedValue[0]]
						}
					]);
				});
			});

			it('Shouldn\'t push the tag if an error occurred when adding the tag', async () => {
				// Setup
				const addTagResolvedValue = 'error message';
				const spyOnAddTag = jest.spyOn(dataSource, 'addTag');
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnAddTag.mockResolvedValueOnce(addTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addTag',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					tagName: 'name',
					type: TagType.Annotated,
					message: 'message',
					pushToRemote: 'origin',
					pushSkipRemoteCheck: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddTag).toHaveBeenCalledWith('/path/to/repo', 'name', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', TagType.Annotated, 'message', false);
					expect(spyOnPushTag).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'addTag',
							repo: '/path/to/repo',
							tagName: 'name',
							pushToRemote: 'origin',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: [addTagResolvedValue]
						}
					]);
				});
			});
		});

		describe('applyStash', () => {
			it('Should apply a stash', async () => {
				// Setup
				const applyStashResolvedValue = null;
				const spyOnApplyStash = jest.spyOn(dataSource, 'applyStash');
				spyOnApplyStash.mockResolvedValueOnce(applyStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'applyStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}',
					reinstateIndex: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnApplyStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}', true);
					expect(messages).toStrictEqual([
						{
							command: 'applyStash',
							error: applyStashResolvedValue
						}
					]);
				});
			});
		});

		describe('branchFromStash', () => {
			it('Should create a branch from a stash', async () => {
				// Setup
				const branchFromStashResolvedValue = null;
				const spyOnBranchFromStash = jest.spyOn(dataSource, 'branchFromStash');
				spyOnBranchFromStash.mockResolvedValueOnce(branchFromStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'branchFromStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}',
					branchName: 'new-branch'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnBranchFromStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}', 'new-branch');
					expect(messages).toStrictEqual([
						{
							command: 'branchFromStash',
							error: branchFromStashResolvedValue
						}
					]);
				});
			});
		});

		describe('checkoutBranch', () => {
			it('Should check out a branch', async () => {
				// Setup
				const checkoutBranchResolvedValue = null;
				const spyOnCheckoutBranch = jest.spyOn(dataSource, 'checkoutBranch');
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnCheckoutBranch.mockResolvedValueOnce(checkoutBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remoteBranch: 'origin/develop',
					pullAfterwards: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', 'origin/develop');
					expect(spyOnPullBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'checkoutBranch',
							pullAfterwards: null,
							errors: [checkoutBranchResolvedValue]
						}
					]);
				});
			});

			it('Should check out a branch, and then pull the branch from a remote', async () => {
				// Setup
				const checkoutBranchResolvedValue = null;
				const pullBranchResolvedValue = null;
				const spyOnCheckoutBranch = jest.spyOn(dataSource, 'checkoutBranch');
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnCheckoutBranch.mockResolvedValueOnce(checkoutBranchResolvedValue);
				spyOnPullBranch.mockResolvedValueOnce(pullBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remoteBranch: null,
					pullAfterwards: {
						branchName: 'develop',
						remote: 'origin',
						createNewCommit: true,
						squash: false
					}
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', null);
					expect(spyOnPullBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', 'origin', true, false);
					expect(messages).toStrictEqual([
						{
							command: 'checkoutBranch',
							pullAfterwards: {
								branchName: 'develop',
								remote: 'origin',
								createNewCommit: true,
								squash: false
							},
							errors: [checkoutBranchResolvedValue, pullBranchResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t pull the branch if an error occurred when checking out the branch', async () => {
				// Setup
				const checkoutBranchResolvedValue = 'error message';
				const spyOnCheckoutBranch = jest.spyOn(dataSource, 'checkoutBranch');
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnCheckoutBranch.mockResolvedValueOnce(checkoutBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remoteBranch: null,
					pullAfterwards: {
						branchName: 'develop',
						remote: 'origin',
						createNewCommit: true,
						squash: false
					}
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', null);
					expect(spyOnPullBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'checkoutBranch',
							pullAfterwards: {
								branchName: 'develop',
								remote: 'origin',
								createNewCommit: true,
								squash: false
							},
							errors: [checkoutBranchResolvedValue]
						}
					]);
				});
			});
		});

		describe('checkoutCommit', () => {
			it('Should check out a commit', async () => {
				// Setup
				const checkoutCommitResolvedValue = null;
				const spyOnCheckoutCommit = jest.spyOn(dataSource, 'checkoutCommit');
				spyOnCheckoutCommit.mockResolvedValueOnce(checkoutCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'checkoutCommit',
							error: checkoutCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('cleanUntrackedFiles', () => {
			it('Should clean the untracked files', async () => {
				// Setup
				const cleanUntrackedFilesResolvedValue = null;
				const spyOnCleanUntrackedFiles = jest.spyOn(dataSource, 'cleanUntrackedFiles');
				spyOnCleanUntrackedFiles.mockResolvedValueOnce(cleanUntrackedFilesResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'cleanUntrackedFiles',
					repo: '/path/to/repo',
					directories: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCleanUntrackedFiles).toHaveBeenCalledWith('/path/to/repo', true);
					expect(messages).toStrictEqual([
						{
							command: 'cleanUntrackedFiles',
							error: cleanUntrackedFilesResolvedValue
						}
					]);
				});
			});
		});

		describe('commitDetails', () => {
			it('Should get the message bodies of a batch of commits (fetched on demand for the commit list)', async () => {
				// Setup
				const bodies = { '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': 'Subject\n\nFull body' };
				const spyOnGetCommitBodies = jest.spyOn(dataSource, 'getCommitBodies');
				spyOnGetCommitBodies.mockResolvedValueOnce(bodies);

				// Run
				onDidReceiveMessage({
					command: 'commitBodies',
					repo: '/path/to/repo',
					commitHashes: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitBodies).toHaveBeenCalledWith('/path/to/repo', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);
					expect(messages).toStrictEqual([{ command: 'commitBodies', bodies: bodies }]);
				});
			});

			it('Should get the data for the Commit Details View', async () => {
				// Setup
				const getCommitDetailsResolvedValue = { commitDetails: null, error: null };
				const getAvatarImageResolvedValue = 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE=';
				const getCodeReviewResolvedValue: CodeReview = {
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					lastActive: 1587559258000,
					lastViewedFile: 'file1.txt',
					remainingFiles: ['file2.txt', 'file3.txt']
				};
				const spyOnGetCommitDetails = jest.spyOn(dataSource, 'getCommitDetails');
				const spyOnGetAvatarImage = jest.spyOn(avatarManager, 'getAvatarImage');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetCommitDetails.mockResolvedValueOnce(getCommitDetailsResolvedValue);
				spyOnGetAvatarImage.mockResolvedValueOnce(getAvatarImageResolvedValue);
				spyOnGetCodeReview.mockReturnValueOnce(getCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'commitDetails',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					hasParents: true,
					stash: null,
					avatarEmail: 'user@mhutchie.com',
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitDetails).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true);
					expect(spyOnGetAvatarImage).toHaveBeenCalledWith('user@mhutchie.com');
					expect(spyOnGetCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'commitDetails',
							commitDetails: null,
							avatar: getAvatarImageResolvedValue,
							codeReview: getCodeReviewResolvedValue,
							refresh: false,
							error: null
						}
					]);
				});
			});

			it('Should get the data for the Commit Details View (Uncommitted Changes)', async () => {
				// Setup
				const getUncommittedDetailsResolvedValue = { commitDetails: null, error: null };
				const spyOnGetUncommittedDetails = jest.spyOn(dataSource, 'getUncommittedDetails');
				const spyOnGetAvatarImage = jest.spyOn(avatarManager, 'getAvatarImage');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetUncommittedDetails.mockResolvedValueOnce(getUncommittedDetailsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'commitDetails',
					repo: '/path/to/repo',
					commitHash: utils.UNCOMMITTED,
					hasParents: true,
					stash: null,
					avatarEmail: null,
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetUncommittedDetails).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnGetAvatarImage).not.toHaveBeenCalled();
					expect(spyOnGetCodeReview).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'commitDetails',
							commitDetails: null,
							avatar: null,
							codeReview: null,
							refresh: false,
							error: null
						}
					]);
				});
			});

			it('Should get the data for the Commit Details View (Stash)', async () => {
				// Setup
				const stash: GitCommitStash = {
					selector: 'refs/stash@{0}',
					baseHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					untrackedFilesHash: null
				};
				const getStashDetailsResolvedValue = { commitDetails: null, error: null };
				const getCodeReviewResolvedValue = null;
				const spyOnGetStashDetails = jest.spyOn(dataSource, 'getStashDetails');
				const spyOnGetAvatarImage = jest.spyOn(avatarManager, 'getAvatarImage');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetStashDetails.mockResolvedValueOnce(getStashDetailsResolvedValue);
				spyOnGetCodeReview.mockReturnValueOnce(getCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'commitDetails',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					hasParents: true,
					stash: stash,
					avatarEmail: null,
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetStashDetails).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', stash);
					expect(spyOnGetAvatarImage).not.toHaveBeenCalled();
					expect(spyOnGetCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'commitDetails',
							commitDetails: null,
							avatar: null,
							codeReview: getCodeReviewResolvedValue,
							refresh: false,
							error: null
						}
					]);
				});
			});
		});

		describe('compareCommits', () => {
			it('Should get the data for the Commit Details View (Comparison)', async () => {
				// Setup
				const getCommitComparisonResolvedValue = { fileChanges: [], error: null };
				const getCodeReviewResolvedValue: CodeReview = {
					id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					lastActive: 1587559258000,
					lastViewedFile: 'file1.txt',
					remainingFiles: ['file2.txt', 'file3.txt']
				};
				const spyOnGetCommitComparison = jest.spyOn(dataSource, 'getCommitComparison');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetCommitComparison.mockResolvedValueOnce(getCommitComparisonResolvedValue);
				spyOnGetCodeReview.mockReturnValueOnce(getCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'compareCommits',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					fromHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					toHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitComparison).toHaveBeenCalledWith('/path/to/repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(spyOnGetCodeReview).toHaveBeenCalledWith('/path/to/repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'compareCommits',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
							fileChanges: [],
							codeReview: getCodeReviewResolvedValue,
							refresh: false,
							error: null
						}
					]);
				});
			});

			it('Should get the data for the Commit Details View (Comparison with the Uncommitted Changes)', async () => {
				// Setup
				const getCommitComparisonResolvedValue = { fileChanges: [], error: null };
				const spyOnGetCommitComparison = jest.spyOn(dataSource, 'getCommitComparison');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetCommitComparison.mockResolvedValueOnce(getCommitComparisonResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'compareCommits',
					repo: '/path/to/repo',
					commitHash: utils.UNCOMMITTED,
					compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					fromHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					toHash: utils.UNCOMMITTED,
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitComparison).toHaveBeenCalledWith('/path/to/repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', utils.UNCOMMITTED);
					expect(spyOnGetCodeReview).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'compareCommits',
							commitHash: utils.UNCOMMITTED,
							compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
							fileChanges: [],
							codeReview: null,
							refresh: false,
							error: null
						}
					]);
				});
			});
		});

		describe('copyFilePath', () => {
			it('Should copy a file path to the clipboard', async () => {
				// Setup
				const copyFilePathToClipboardResolvedValue = null;
				const spyOnCopyFilePathToClipboard = jest.spyOn(utils, 'copyFilePathToClipboard');
				spyOnCopyFilePathToClipboard.mockResolvedValueOnce(copyFilePathToClipboardResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'copyFilePath',
					repo: '/path/to/repo',
					filePath: 'file.txt',
					absolute: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCopyFilePathToClipboard).toHaveBeenCalledWith('/path/to/repo', 'file.txt', true);
					expect(messages).toStrictEqual([
						{
							command: 'copyFilePath',
							error: copyFilePathToClipboardResolvedValue
						}
					]);
				});
			});
		});

		describe('copyToClipboard', () => {
			it('Should copy text to the clipboard', async () => {
				// Setup
				const copyToClipboardResolvedValue = null;
				const spyOnCopyToClipboard = jest.spyOn(utils, 'copyToClipboard');
				spyOnCopyToClipboard.mockResolvedValueOnce(copyToClipboardResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'copyToClipboard',
					type: 'Branch Name',
					data: 'master'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCopyToClipboard).toHaveBeenCalledWith('master');
					expect(messages).toStrictEqual([
						{
							command: 'copyToClipboard',
							type: 'Branch Name',
							error: copyToClipboardResolvedValue
						}
					]);
				});
			});
		});

		describe('createArchive', () => {
			it('Should create an archive', async () => {
				// Setup
				const archiveResolvedValue = null;
				const spyOnArchive = jest.spyOn(utils, 'archive');
				spyOnArchive.mockResolvedValueOnce(archiveResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createArchive',
					repo: '/path/to/repo',
					ref: 'master'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnArchive).toHaveBeenCalledWith('/path/to/repo', 'master', dataSource);
					expect(messages).toStrictEqual([
						{
							command: 'createArchive',
							error: archiveResolvedValue
						}
					]);
				});
			});
		});

		describe('createBranch', () => {
			it('Should create a branch', async () => {
				// Setup
				const createBranchResolvedValue = [null];
				const spyOnCreateBranch = jest.spyOn(dataSource, 'createBranch');
				spyOnCreateBranch.mockResolvedValueOnce(createBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createBranch',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					branchName: 'feature-1',
					checkout: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCreateBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true, false);
					expect(messages).toStrictEqual([
						{
							command: 'createBranch',
							errors: createBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('createPullRequest', () => {
			it('Should create a pull request', async () => {
				// Setup
				const pullRequestConfig: PullRequestConfig = {
					provider: PullRequestProvider.Bitbucket,
					custom: null,
					hostRootUrl: 'https://bitbucket.org',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceRemote: 'sourceRemote',
					destOwner: 'destOwner',
					destRepo: 'destRepo',
					destBranch: 'destBranch',
					destRemote: 'destRemote',
					destProjectId: 'destProjectId'
				};
				const createPullRequestResolvedValue = null;
				const spyOnPushBranch = jest.spyOn(dataSource, 'pushBranch');
				const spyOnCreatePullRequest = jest.spyOn(utils, 'createPullRequest');
				spyOnCreatePullRequest.mockResolvedValueOnce(createPullRequestResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createPullRequest',
					repo: '/path/to/repo',
					config: pullRequestConfig,
					sourceRemote: 'origin',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceBranch: 'sourceBranch',
					push: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranch).not.toHaveBeenCalled();
					expect(spyOnCreatePullRequest).toHaveBeenCalledWith(pullRequestConfig, 'sourceOwner', 'sourceRepo', 'sourceBranch');
					expect(messages).toStrictEqual([
						{
							command: 'createPullRequest',
							push: false,
							errors: [null, createPullRequestResolvedValue]
						}
					]);
				});
			});

			it('Should push the branch, and then create a pull request', async () => {
				// Setup
				const pullRequestConfig: PullRequestConfig = {
					provider: PullRequestProvider.Bitbucket,
					custom: null,
					hostRootUrl: 'https://bitbucket.org',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceRemote: 'sourceRemote',
					destOwner: 'destOwner',
					destRepo: 'destRepo',
					destBranch: 'destBranch',
					destRemote: 'destRemote',
					destProjectId: 'destProjectId'
				};
				const pushBranchResolvedValue = null;
				const createPullRequestResolvedValue = null;
				const spyOnPushBranch = jest.spyOn(dataSource, 'pushBranch');
				const spyOnCreatePullRequest = jest.spyOn(utils, 'createPullRequest');
				spyOnPushBranch.mockResolvedValueOnce(pushBranchResolvedValue);
				spyOnCreatePullRequest.mockResolvedValueOnce(createPullRequestResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createPullRequest',
					repo: '/path/to/repo',
					config: pullRequestConfig,
					sourceRemote: 'origin',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceBranch: 'sourceBranch',
					push: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranch).toHaveBeenCalledWith('/path/to/repo', 'sourceBranch', 'origin', true, GitPushBranchMode.Normal);
					expect(spyOnCreatePullRequest).toHaveBeenCalledWith(pullRequestConfig, 'sourceOwner', 'sourceRepo', 'sourceBranch');

					expect(messages).toStrictEqual([
						{
							command: 'createPullRequest',
							push: true,
							errors: [pushBranchResolvedValue, createPullRequestResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t create a pull request if an error occurred when pushing the branch', async () => {
				// Setup
				const pullRequestConfig: PullRequestConfig = {
					provider: PullRequestProvider.Bitbucket,
					custom: null,
					hostRootUrl: 'https://bitbucket.org',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceRemote: 'sourceRemote',
					destOwner: 'destOwner',
					destRepo: 'destRepo',
					destBranch: 'destBranch',
					destRemote: 'destRemote',
					destProjectId: 'destProjectId'
				};
				const pushBranchResolvedValue = 'error message';
				const spyOnPushBranch = jest.spyOn(dataSource, 'pushBranch');
				const spyOnCreatePullRequest = jest.spyOn(utils, 'createPullRequest');
				spyOnPushBranch.mockResolvedValueOnce(pushBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createPullRequest',
					repo: '/path/to/repo',
					config: pullRequestConfig,
					sourceRemote: 'origin',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceBranch: 'sourceBranch',
					push: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranch).toHaveBeenCalledWith('/path/to/repo', 'sourceBranch', 'origin', true, GitPushBranchMode.Normal);
					expect(spyOnCreatePullRequest).not.toHaveBeenCalled();

					expect(messages).toStrictEqual([
						{
							command: 'createPullRequest',
							push: true,
							errors: [pushBranchResolvedValue]
						}
					]);
				});
			});
		});

		describe('deleteBranch', () => {
			it('Should delete a branch', async () => {
				// Setup
				const deleteBranchResolvedValue = null;
				const spyOnDeleteBranch = jest.spyOn(dataSource, 'deleteBranch');
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteBranch.mockResolvedValueOnce(deleteBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					forceDelete: false,
					deleteOnRemotes: []
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', false);
					expect(spyOnDeleteRemoteBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'deleteBranch',
							repo: '/path/to/repo',
							branchName: 'feature-1',
							deleteOnRemotes: [],
							errors: [deleteBranchResolvedValue]
						}
					]);
				});
			});

			it('Should delete a branch, and then delete the branch on the specified remotes', async () => {
				// Setup
				const deleteBranchResolvedValue = null;
				const deleteRemoteBranchResolvedValue1 = null;
				const deleteRemoteBranchResolvedValue2 = null;
				const spyOnDeleteBranch = jest.spyOn(dataSource, 'deleteBranch');
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteBranch.mockResolvedValueOnce(deleteBranchResolvedValue);
				spyOnDeleteRemoteBranch.mockResolvedValueOnce(deleteRemoteBranchResolvedValue1);
				spyOnDeleteRemoteBranch.mockResolvedValueOnce(deleteRemoteBranchResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'deleteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					forceDelete: false,
					deleteOnRemotes: ['origin', 'upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', false);
					expect(spyOnDeleteRemoteBranch).toHaveBeenNthCalledWith(1, '/path/to/repo', 'feature-1', 'origin');
					expect(spyOnDeleteRemoteBranch).toHaveBeenNthCalledWith(2, '/path/to/repo', 'feature-1', 'upstream');
					expect(messages).toStrictEqual([
						{
							command: 'deleteBranch',
							repo: '/path/to/repo',
							branchName: 'feature-1',
							deleteOnRemotes: ['origin', 'upstream'],
							errors: [deleteBranchResolvedValue, deleteRemoteBranchResolvedValue1, deleteRemoteBranchResolvedValue2]
						}
					]);
				});
			});

			it('Shouldn\'t delete a branch on a remote if an error occurred when deleting the local branch', async () => {
				// Setup
				const deleteBranchResolvedValue = 'error message';
				const spyOnDeleteBranch = jest.spyOn(dataSource, 'deleteBranch');
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteBranch.mockResolvedValueOnce(deleteBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					forceDelete: false,
					deleteOnRemotes: ['origin', 'upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', false);
					expect(spyOnDeleteRemoteBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'deleteBranch',
							repo: '/path/to/repo',
							branchName: 'feature-1',
							deleteOnRemotes: ['origin', 'upstream'],
							errors: [deleteBranchResolvedValue]
						}
					]);
				});
			});
		});

		describe('deleteRemote', () => {
			it('Should delete a remote', async () => {
				// Setup
				const deleteRemoteResolvedValue = null;
				const spyOnDeleteRemote = jest.spyOn(dataSource, 'deleteRemote');
				spyOnDeleteRemote.mockResolvedValueOnce(deleteRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteRemote',
					repo: '/path/to/repo',
					name: 'origin'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteRemote).toHaveBeenCalledWith('/path/to/repo', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'deleteRemote',
							error: deleteRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('deleteRemoteBranch', () => {
			it('Should delete a remote branch', async () => {
				// Setup
				const deleteRemoteBranchResolvedValue = null;
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteRemoteBranch.mockResolvedValueOnce(deleteRemoteBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteRemoteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					remote: 'origin'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteRemoteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'deleteRemoteBranch',
							error: deleteRemoteBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('deleteTag', () => {
			it('Should delete a tag', async () => {
				// Setup
				const deleteTagResolvedValue = null;
				const spyOnDeleteTag = jest.spyOn(dataSource, 'deleteTag');
				spyOnDeleteTag.mockResolvedValueOnce(deleteTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteTag',
					repo: '/path/to/repo',
					tagName: 'v1.0',
					deleteOnRemote: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteTag).toHaveBeenCalledWith('/path/to/repo', 'v1.0', null);
					expect(messages).toStrictEqual([
						{
							command: 'deleteTag',
							error: deleteTagResolvedValue
						}
					]);
				});
			});
		});

		describe('deleteUserDetails', () => {
			it('Should delete user.name and user.email', async () => {
				// Setup
				const unsetConfigValueResolvedValue1 = null;
				const unsetConfigValueResolvedValue2 = null;
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue1);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'deleteUserDetails',
					repo: '/path/to/repo',
					name: true,
					email: true,
					location: GitConfigLocation.Local
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', GitConfigLocation.Local);
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'deleteUserDetails',
							errors: [unsetConfigValueResolvedValue1, unsetConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Should only delete user.name', async () => {
				// Setup
				const unsetConfigValueResolvedValue = null;
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteUserDetails',
					repo: '/path/to/repo',
					name: true,
					email: false,
					location: GitConfigLocation.Global
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.name', GitConfigLocation.Global);
					expect(messages).toStrictEqual([
						{
							command: 'deleteUserDetails',
							errors: [unsetConfigValueResolvedValue]
						}
					]);
				});
			});

			it('Should only delete user.email', async () => {
				// Setup
				const unsetConfigValueResolvedValue = null;
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteUserDetails',
					repo: '/path/to/repo',
					name: false,
					email: true,
					location: GitConfigLocation.Global
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.email', GitConfigLocation.Global);
					expect(messages).toStrictEqual([
						{
							command: 'deleteUserDetails',
							errors: [unsetConfigValueResolvedValue]
						}
					]);
				});
			});
		});

		describe('dropCommit', () => {
			it('Should drop a commit', async () => {
				// Setup
				const dropCommitResolvedValue = null;
				const spyOnDropCommit = jest.spyOn(dataSource, 'dropCommit');
				spyOnDropCommit.mockResolvedValueOnce(dropCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'dropCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDropCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'dropCommit',
							error: dropCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('dropStash', () => {
			it('Should drop a stash', async () => {
				// Setup
				const dropStashResolvedValue = null;
				const spyOnDropStash = jest.spyOn(dataSource, 'dropStash');
				spyOnDropStash.mockResolvedValueOnce(dropStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'dropStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDropStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}');
					expect(messages).toStrictEqual([
						{
							command: 'dropStash',
							error: dropStashResolvedValue
						}
					]);
				});
			});
		});

		describe('editRemote', () => {
			it('Should edit a remote', async () => {
				// Setup
				const editRemoteResolvedValue = null;
				const spyOnEditRemote = jest.spyOn(dataSource, 'editRemote');
				spyOnEditRemote.mockResolvedValueOnce(editRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'editRemote',
					repo: '/path/to/repo',
					nameOld: 'old-origin',
					nameNew: 'new-origin',
					urlOld: 'https://github.com/mhutchie/old.git',
					urlNew: 'https://github.com/mhutchie/new.git',
					pushUrlOld: 'https://github.com/mhutchie/old-push.git',
					pushUrlNew: 'https://github.com/mhutchie/new-push.git'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnEditRemote).toHaveBeenCalledWith('/path/to/repo', 'old-origin', 'new-origin', 'https://github.com/mhutchie/old.git', 'https://github.com/mhutchie/new.git', 'https://github.com/mhutchie/old-push.git', 'https://github.com/mhutchie/new-push.git');
					expect(messages).toStrictEqual([
						{
							command: 'editRemote',
							error: editRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('editUserDetails', () => {
			it('Should edit the local user.name and user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@mhutchie.com',
					location: GitConfigLocation.Local,
					deleteLocalName: false,
					deleteLocalEmail: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Local);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@mhutchie.com', GitConfigLocation.Local);
					expect(spyOnUnsetConfigValue).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Should edit the global user.name and user.email, and delete the local user.name and user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const unsetConfigValueResolvedValue1 = null;
				const unsetConfigValueResolvedValue2 = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue1);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@mhutchie.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@mhutchie.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', GitConfigLocation.Local);
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2, unsetConfigValueResolvedValue1, unsetConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Should edit the global user.name and user.email, and only delete the local user.name', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const unsetConfigValueResolvedValue = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@mhutchie.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@mhutchie.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.name', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2, unsetConfigValueResolvedValue]
						}
					]);
				});
			});

			it('Should edit the global user.name and user.email, and only delete the local user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const unsetConfigValueResolvedValue = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@mhutchie.com',
					location: GitConfigLocation.Global,
					deleteLocalName: false,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@mhutchie.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.email', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2, unsetConfigValueResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t delete the local user.name or user.email if an error occurred when editing the global user.name', async () => {
				// Setup
				const setConfigValueResolvedValue1 = 'error message';
				const setConfigValueResolvedValue2 = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@mhutchie.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@mhutchie.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Shouldn\'t delete the local user.name or user.email if an error occurred when editing the global user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = 'error message';
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@mhutchie.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@mhutchie.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2]
						}
					]);
				});
			});
		});

		describe('endCodeReview', () => {
			it('Should end a code review', async () => {
				// Setup
				const spyOnEndCodeReview = jest.spyOn(extensionState, 'endCodeReview');
				spyOnEndCodeReview.mockResolvedValueOnce(null);

				// Run
				onDidReceiveMessage({
					command: 'endCodeReview',
					repo: '/path/to/repo',
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnEndCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('exportRepoConfig', () => {
			it('Should export the repository configuration', async () => {
				// Setup
				const exportRepoConfigResolvedValue = null;
				const spyOnExportRepoConfig = jest.spyOn(repoManager, 'exportRepoConfig');
				spyOnExportRepoConfig.mockResolvedValueOnce(exportRepoConfigResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'exportRepoConfig',
					repo: '/path/to/repo'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnExportRepoConfig).toHaveBeenCalledWith('/path/to/repo');
					expect(messages).toStrictEqual([
						{
							command: 'exportRepoConfig',
							error: exportRepoConfigResolvedValue
						}
					]);
				});
			});
		});

		describe('error isolation', () => {
			it('Should not crash on a message for an unknown repository (malformed webview message)', async () => {
				// Setup: exportRepoConfig throws for an unknown repository (the repo state is undefined)
				const spyOnExportRepoConfig = jest.spyOn(repoManager, 'exportRepoConfig');
				spyOnExportRepoConfig.mockImplementation(() => { throw new Error('unknown repository'); });
				vscode.window.showErrorMessage.mockResolvedValue(null);
				const spyOnLogError = jest.spyOn(logger, 'logError');

				// Run
				onDidReceiveMessage({
					command: 'exportRepoConfig',
					repo: '/path/to/unknown-repo'
				});

				// Assert: the error is logged and shown, no response is sent, and (via the
				// afterEach assertions) the repo file watcher was unmuted despite the error
				await waitForExpect(() => {
					expect(spyOnLogError).toHaveBeenCalled();
					expect(vscode.window.showErrorMessage).toHaveBeenCalled();
				});
				expect(messages).toStrictEqual([]);
			});

			it('Should unmute the repo file watcher when a handler rejects', async () => {
				// Setup: the fetch handler rejects
				const spyOnFetch = jest.spyOn(dataSource, 'fetch');
				spyOnFetch.mockRejectedValueOnce(new Error('git failed'));
				vscode.window.showErrorMessage.mockResolvedValue(null);

				// Run
				onDidReceiveMessage({
					command: 'fetch',
					repo: '/path/to/repo',
					name: null,
					prune: false,
					pruneTags: false
				});

				// Assert: the rejection is caught and shown, and the watcher is unmuted (afterEach)
				await waitForExpect(() => {
					expect(vscode.window.showErrorMessage).toHaveBeenCalled();
				});
			});
		});

		describe('fetch', () => {
			it('Should fetch a remote, and prune it', async () => {
				// Setup
				const fetchResolvedValue = null;
				const spyOnFetch = jest.spyOn(dataSource, 'fetch');
				spyOnFetch.mockResolvedValueOnce(fetchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'fetch',
					repo: '/path/to/repo',
					name: null,
					prune: true,
					pruneTags: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnFetch).toHaveBeenCalledWith('/path/to/repo', null, true, false);
					expect(messages).toStrictEqual([
						{
							command: 'fetch',
							error: fetchResolvedValue
						}
					]);
				});
			});
		});

		describe('fetchAvatar', () => {
			it('Should fetch an avatar', async () => {
				// Setup
				const spyOnFetchAvatarImage = jest.spyOn(avatarManager, 'fetchAvatarImage');
				spyOnFetchAvatarImage.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'fetchAvatar',
					repo: '/path/to/repo',
					remote: 'origin',
					email: 'user@mhutchie.com',
					commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnFetchAvatarImage).toHaveBeenCalledWith('user@mhutchie.com', '/path/to/repo', 'origin', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('gerritSaveFetchConfig', () => {
			it('Should save the fetch mode and limit to the global User Settings', async () => {
				// Run
				onDidReceiveMessage({
					command: 'gerritSaveFetchConfig',
					repo: '/path/to/repo',
					fetchMode: 'latest',
					fetchLimit: 50
				});

				// Assert
				await waitForExpect(() => {
					expect(vscode.mocks.workspaceConfiguration.update).toHaveBeenCalledWith('gerrit.fetchMode', 'latest', vscode.ConfigurationTarget.Global);
					expect(vscode.mocks.workspaceConfiguration.update).toHaveBeenCalledWith('gerrit.fetchLimit', 50, vscode.ConfigurationTarget.Global);
					expect(messages).toStrictEqual([
						{
							command: 'gerritSaveFetchConfig',
							error: null
						}
					]);
				});
			});

			it('Should reject an invalid limit in latest fetch mode without saving', async () => {
				// Run
				onDidReceiveMessage({
					command: 'gerritSaveFetchConfig',
					repo: '/path/to/repo',
					fetchMode: 'latest',
					fetchLimit: -3
				});

				// Assert
				await waitForExpect(() => {
					expect(vscode.mocks.workspaceConfiguration.update).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'gerritSaveFetchConfig',
							error: 'The number of changes to cache must be a whole number between 1 and 10000.'
						}
					]);
				});
			});

			it('Should keep the currently configured limit when saving all fetch mode with an invalid limit', async () => {
				// Setup
				vscode.mockExtensionSettingReturnValue('gerrit.fetchLimit', 20);

				// Run
				onDidReceiveMessage({
					command: 'gerritSaveFetchConfig',
					repo: '/path/to/repo',
					fetchMode: 'all',
					fetchLimit: NaN
				});

				// Assert
				await waitForExpect(() => {
					expect(vscode.mocks.workspaceConfiguration.update).toHaveBeenCalledWith('gerrit.fetchMode', 'all', vscode.ConfigurationTarget.Global);
					expect(vscode.mocks.workspaceConfiguration.update).toHaveBeenCalledWith('gerrit.fetchLimit', 20, vscode.ConfigurationTarget.Global);
					expect(messages).toStrictEqual([
						{
							command: 'gerritSaveFetchConfig',
							error: null
						}
					]);
				});
			});
		});

		describe('gerritClearRefs', () => {
			it('Should delete all local Gerrit change refs of the configured remote', async () => {
				// Setup (the auto-mocked DataSource doesn't construct GerritDataSource, so inject a mock)
				const spyOnClearLocalChanges = jest.fn().mockResolvedValueOnce({ error: null, cleared: 3 });
				const previousGerrit = (<any>dataSource).gerrit;
				(<any>dataSource).gerrit = { clearLocalChanges: spyOnClearLocalChanges };

				// Run
				onDidReceiveMessage({
					command: 'gerritClearRefs',
					repo: '/path/to/repo'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnClearLocalChanges).toHaveBeenCalledWith('/path/to/repo', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'gerritClearRefs',
							error: null,
							cleared: 3
						}
					]);
				});
				(<any>dataSource).gerrit = previousGerrit;
			});
		});

		describe('gerritGetHookStatus', () => {
			it('Should respond with the status of the tracked Git hooks', async () => {
				const spyOnGetHookStatus = jest.fn().mockResolvedValueOnce({
					error: null,
					hooks: [
						{ name: 'pre-commit', installed: true, installable: false },
						{ name: 'commit-msg', installed: false, installable: true },
						{ name: 'post-commit', installed: false, installable: false }
					]
				});
				const previousGerrit = (<any>dataSource).gerrit;
				(<any>dataSource).gerrit = { getHookStatus: spyOnGetHookStatus };

				onDidReceiveMessage({ command: 'gerritGetHookStatus', repo: '/path/to/repo' });

				await waitForExpect(() => {
					expect(spyOnGetHookStatus).toHaveBeenCalledWith('/path/to/repo');
					expect(messages).toStrictEqual([
						{
							command: 'gerritGetHookStatus',
							error: null,
							hooks: [
								{ name: 'pre-commit', installed: true, installable: false },
								{ name: 'commit-msg', installed: false, installable: true },
								{ name: 'post-commit', installed: false, installable: false }
							]
						}
					]);
				});
				(<any>dataSource).gerrit = previousGerrit;
			});
		});

		describe('gerritInstallHook', () => {
			it('Should install the requested hook of the configured remote and respond with the result', async () => {
				const spyOnInstallHook = jest.fn().mockResolvedValueOnce({ error: null, installed: true });
				const previousGerrit = (<any>dataSource).gerrit;
				(<any>dataSource).gerrit = { installHook: spyOnInstallHook };

				onDidReceiveMessage({ command: 'gerritInstallHook', repo: '/path/to/repo', hook: 'commit-msg' });

				await waitForExpect(() => {
					expect(spyOnInstallHook).toHaveBeenCalledWith('/path/to/repo', 'origin', 'commit-msg');
					expect(messages).toStrictEqual([
						{
							command: 'gerritInstallHook',
							hook: 'commit-msg',
							error: null,
							installed: true
						}
					]);
				});
				(<any>dataSource).gerrit = previousGerrit;
			});
		});

		describe('gerritAmendChangeId', () => {
			let spyOnGitOutput: jest.SpyInstance, spyOnRunGitCommand: jest.SpyInstance;
			const TREE_HASH = '0123456789abcdef0123456789abcdef01234567', PARENT_HASH = 'fedcba9876543210fedcba9876543210fedcba98';

			/** Mock the Git outputs used by the amend pipeline: HEAD message, containing remotes and the HEAD commit metadata. */
			const mockAmendGitOutputs = (headMessage: string, containingRemotes: string) => {
				spyOnGitOutput.mockImplementation((<any>function (args: string[], _repo: string, resolveValue: { (stdout: string): any }) {
					if (args[0] === 'log') return Promise.resolve(resolveValue(headMessage));
					if (args[0] === 'branch') return Promise.resolve(resolveValue(containingRemotes));
					if (args[0] === 'show') return Promise.resolve(resolveValue([TREE_HASH, PARENT_HASH, 'Dev <dev@example.com> 1755000000', 'Dev <dev@example.com> 1755000000', 'Add feature', ''].join('\n')));
					return Promise.resolve(resolveValue(''));
				}));
			};

			beforeEach(() => {
				spyOnGitOutput = jest.spyOn(dataSource, 'gitOutput');
				spyOnRunGitCommand = jest.spyOn(dataSource, 'runGitCommand');
				spyOnRunGitCommand.mockResolvedValue(null);
			});
			afterEach(() => {
				spyOnGitOutput.mockRestore();
				spyOnRunGitCommand.mockRestore();
			});

			it('Should report the existing Change-Id of HEAD without amending anything', async () => {
				// Setup
				const existingId = 'I' + '1'.repeat(40);
				mockAmendGitOutputs('Add feature\n\nChange-Id: ' + existingId + '\n', '');

				// Run
				onDidReceiveMessage({ command: 'gerritAmendChangeId', repo: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([
						{ command: 'gerritAmendChangeId', error: null, changeId: existingId, amended: false }
					]);
				});
				expect(spyOnRunGitCommand).not.toHaveBeenCalled();
			});

			it('Should generate and amend a Change-Id onto HEAD when it has none and was never pushed', async () => {
				// Setup
				mockAmendGitOutputs('Add feature\n', '');

				// Run
				onDidReceiveMessage({ command: 'gerritAmendChangeId', repo: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toHaveLength(1);
				});
				expect(spyOnRunGitCommand).toHaveBeenCalledTimes(1);
				const amendArgs = spyOnRunGitCommand.mock.calls[0][0];
				expect(amendArgs.slice(0, 3)).toEqual(['commit', '--amend', '-m']);
				expect(amendArgs[3]).toMatch(/^Add feature\n\nChange-Id: I[0-9a-f]{40}$/);
				expect(spyOnRunGitCommand.mock.calls[0][1]).toBe('/path/to/repo');
				expect(messages[0]).toMatchObject({ command: 'gerritAmendChangeId', error: null, amended: true, changeId: amendArgs[3].substring(amendArgs[3].lastIndexOf(' ') + 1) });
			});

			it('Should refuse to amend when HEAD has no Change-Id but was already pushed to a remote', async () => {
				// Setup
				mockAmendGitOutputs('Add feature\n', 'origin/develop\n');

				// Run
				onDidReceiveMessage({ command: 'gerritAmendChangeId', repo: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toHaveLength(1);
				});
				const response = <any>messages[0];
				expect(response.error).toContain('already been pushed to a remote (origin/develop)');
				expect(response.amended).toBe(false);
				expect(spyOnRunGitCommand).not.toHaveBeenCalled();
			});

			it('Should surface Git failures as the response error', async () => {
				// Setup
				spyOnGitOutput.mockRejectedValue('fatal: not a git repository');

				// Run
				onDidReceiveMessage({ command: 'gerritAmendChangeId', repo: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([
						{ command: 'gerritAmendChangeId', error: 'fatal: not a git repository', changeId: null, amended: false }
					]);
				});
			});
		});

		describe('loadCommits (Gerrit cache)', () => {
			const CHANGE_OPEN = { change: 100, patchset: 1, codeReview: 0, verified: 0, status: 'new', wip: false, headHash: 'aaaa', events: [], url: null };
			const CHANGE_MERGED = { change: 200, patchset: 2, codeReview: 2, verified: 1, status: 'merged', wip: false, headHash: 'bbbb', events: [], url: null };
			const loadCommitsBase = {
				command: 'loadCommits',
				repo: '/path/to/repo',
				branches: null,
				authors: null,
				maxCommits: 300,
				showTags: false,
				showRemoteBranches: false,
				includeCommitsMentionedByReflogs: false,
				onlyFollowFirstParent: false,
				commitOrdering: CommitOrdering.Date,
				remotes: ['origin'],
				hideRemotes: [],
				stashes: []
			} as const;

			let spyOnListRemoteChanges: jest.SpyInstance, spyOnListLocalChangeRefs: jest.SpyInstance, spyOnGetCommits: jest.SpyInstance, previousGerrit: any;
			beforeEach(() => {
				// Setup (the auto-mocked DataSource doesn't construct GerritDataSource, so inject a mock;
				// clear the Gerrit cache and the commit cache so every test starts from a cold cache)
				GitGraphView.currentPanel!['gerritCache'].clear();
				GitGraphView.currentPanel!['gerritStaleRepos'].clear();
				GitGraphView.currentPanel!['commitCache'].clear();
				spyOnListRemoteChanges = jest.fn().mockResolvedValue(new Map([[100, [1]], [200, [1, 2]]]));
				spyOnListLocalChangeRefs = jest.fn().mockResolvedValue([]);
				previousGerrit = (<any>dataSource).gerrit;
				(<any>dataSource).gerrit = {
					listRemoteChanges: spyOnListRemoteChanges,
					listLocalChangeRefs: spyOnListLocalChangeRefs,
					fetchChanges: jest.fn().mockResolvedValue(null),
					pruneLocalChanges: jest.fn().mockResolvedValue(undefined),
					getChangeUrlBase: jest.fn().mockResolvedValue(null),
					parseMetas: jest.fn().mockImplementation((_repo: string, _remote: string, changes: number[]) => {
						const states = new Map<number, any>();
						for (const change of changes) states.set(change, change === 100 ? CHANGE_OPEN : CHANGE_MERGED);
						return Promise.resolve(states);
					})
				};
				spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValue({ commits: [], head: null, tags: [], moreCommitsAvailable: false, error: null });
			});
			afterEach(() => {
				(<any>dataSource).gerrit = previousGerrit;
				spyOnGetCommits.mockRestore();
			});

			it('Should render the branch graph IMMEDIATELY on a cold cache, then deliver the Gerrit data asynchronously', async () => {
				// Run (cold cache: the request must be answered in phases)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false } });

				// Assert (phase 1: the branch graph arrives at once, marked gerritPending, WITHOUT Gerrit refs)
				await waitForExpect(() => {
					expect(messages[0]).toMatchObject({ command: 'loadCommits', refreshId: 2, gerritPending: true, gerritStates: null });
				});
				expect(spyOnGetCommits).toHaveBeenNthCalledWith(1, '/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], null, false, null, false);

				// Assert (phase 2: the fresh Gerrit data arrives on the commit graph WITH the change refs
				// injected - a meta-only stage on the ref-less pending graph is skipped, since its graph
				// is immediately superseded by the refs stage)
				await waitForExpect(() => {
					expect(messages[1]).toMatchObject({ command: 'loadCommits', refreshId: 2, gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
					expect((<any>messages[1]).gerritPending).toBeUndefined();
				});
				expect(spyOnGetCommits).toHaveBeenNthCalledWith(2, '/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], ['refs/remotes/origin/changes/00/100/1'], false, null, false);
				expect(messages).toHaveLength(2);
			});

			it('Should skip the pending Gerrit follow-up when a newer load request supersedes it', async () => {
				// Setup: a Gerrit pipeline that stays in-flight until the test releases it (mimicking
				// a slow remote, so the newer load request definitely arrives while it is running)
				let releasePipeline: () => void;
				const pipelineGate = new Promise<void>((resolve) => { releasePipeline = resolve; });
				(<any>dataSource).gerrit.parseMetas = jest.fn().mockImplementation(() => pipelineGate.then(() => {
					const states = new Map<number, any>();
					states.set(100, CHANGE_OPEN);
					states.set(200, CHANGE_MERGED);
					return states;
				}));

				// Run (request 2: cold cache -> answered immediately, the Gerrit follow-up runs asynchronously)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false } });
				await waitForExpect(() => {
					expect(messages[0]).toMatchObject({ command: 'loadCommits', refreshId: 2, gerritPending: true });
				});

				// Run (request 3 arrives while the Gerrit pipeline is still running)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 3, gerritStatusFilter: { new: true, merged: true, abandoned: false, wip: false } });

				// Run (the pipeline completes: request 3 is served; the stale follow-up of request 2 is never sent)
				releasePipeline!();
				await waitForExpect(() => {
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', refreshId: 3, gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
				});
				expect(messages.filter((m: any) => m.command === 'loadCommits' && m.refreshId === 2)).toHaveLength(1);
			});

			it('Should rebuild the Gerrit data from the LOCAL change refs on a cold cache, without any network access', async () => {
				// Setup (the repository holds locally cached change refs from a previous fetch)
				spyOnListLocalChangeRefs.mockResolvedValue([
					'refs/remotes/origin/changes/00/100/1',
					'refs/remotes/origin/changes/00/200/2',
					'refs/remotes/origin/changes/00/200/meta',
					'refs/remotes/origin/changes/00/100/meta'
				]);

				// Run (cold in-memory cache, no forced refresh: the locally rebuilt Gerrit data is part
				// of the FIRST response - no pending round-trips that each re-run getCommits)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false } });

				await waitForExpect(() => {
					expect(messages).toHaveLength(1);
					expect(messages[0]).toMatchObject({ command: 'loadCommits', refreshId: 2, gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
				});
				expect((<any>messages[0]).gerritPending).toBeUndefined();
				expect(spyOnGetCommits).toHaveBeenCalledTimes(1);
				expect(spyOnGetCommits).toHaveBeenLastCalledWith('/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], ['refs/remotes/origin/changes/00/100/1'], false, null, true);
				expect(spyOnListRemoteChanges).not.toHaveBeenCalled(); // no network access
			});

			it('Should keep serving the LOCAL Gerrit data when a forced refresh cannot reach the remote', async () => {
				// Setup (locally cached change refs, and a remote that returns nothing: unreachable)
				spyOnListLocalChangeRefs.mockResolvedValue(['refs/remotes/origin/changes/00/100/1', 'refs/remotes/origin/changes/00/100/meta']);
				spyOnListRemoteChanges.mockResolvedValue(new Map());
				(<any>dataSource).gerrit.parseMetas = jest.fn().mockResolvedValue(new Map([[100, CHANGE_OPEN]]));

				// Run (forced refresh while offline)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false }, gerritForceRefresh: true });

				// Assert (the locally cached Gerrit data keeps being served; the refs are unchanged, so
				// the follow-up skips the branches/refs stages)
				await waitForExpect(() => {
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', refreshId: 2, gerritStates: [CHANGE_OPEN] });
				});
				const responses = messages.filter((m: any) => m.command === 'loadCommits' && m.refreshId === 2);
				expect(responses).toHaveLength(2);
				// The follow-up only swaps in the fresh Gerrit states on the ALREADY LOADED commit
				// graph (the change refs are unchanged), so no second getCommits is run
				expect(spyOnGetCommits).toHaveBeenCalledTimes(1);
			});

			it('Should keep the STALE Gerrit data on screen (gerritPending) during a forced refresh, then deliver the fresh data', async () => {
				// Setup (prime the cache: a cold load answered in two phases)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false } });
				await waitForExpect(() => {
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', refreshId: 2, gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
				});

				// Run (forced refresh: re-fetch the Gerrit data from the remote)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 3, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false }, gerritForceRefresh: true });

				// Assert (two responses: the stale cached Gerrit data is served instantly while the
				// refresh is running, then the refreshed review info arrives; the change refs are
				// unchanged, so the follow-up skips the branches/refs stages)
				await waitForExpect(() => {
					const responses = messages.filter((m: any) => m.command === 'loadCommits' && m.refreshId === 3);
					expect(responses).toHaveLength(2);
					expect(responses[0]).toMatchObject({ gerritPending: true, gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
					expect(responses[1]).toMatchObject({ gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
					expect((<any>responses[1]).gerritPending).toBeUndefined();
					expect(spyOnListRemoteChanges).toHaveBeenCalledTimes(2); // the forced refresh re-fetched
				});
			});

			it('Should re-serve the Gerrit states from the cache when the status filter changes, and only re-fetch on a forced refresh', async () => {
				// Run (initial load: only open changes are enabled by the filter)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false } });

				// Assert (the pipeline ran once; ALL cached states are served - the Webview applies the filter)
				await waitForExpect(() => {
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
					expect(spyOnGetCommits).toHaveBeenLastCalledWith('/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], ['refs/remotes/origin/changes/00/100/1'], false, null, false);
				});
				expect(spyOnListRemoteChanges).toHaveBeenCalledTimes(1);

				// Run (the "Merged" chip was toggled: no forced refresh)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 3, gerritStatusFilter: { new: true, merged: true, abandoned: false, wip: false } });

				// Assert (served from the cache: no new Gerrit fetch, all states are served.
				// Merged changes are already in the target branch's history, so their refs must NOT be
				// injected into the graph: the commits loaded stay identical to the initial load)
				await waitForExpect(() => {
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
					expect(spyOnGetCommits).toHaveBeenLastCalledWith('/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], ['refs/remotes/origin/changes/00/100/1'], false, null, true);
				});
				expect(spyOnListRemoteChanges).toHaveBeenCalledTimes(1);

				// Run (forced refresh: the Gerrit data must be re-fetched from the remote)
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 4, gerritStatusFilter: { new: true, merged: true, abandoned: false, wip: false }, gerritForceRefresh: true });

				await waitForExpect(() => {
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: [CHANGE_OPEN, CHANGE_MERGED] });
				});
				expect(spyOnListRemoteChanges).toHaveBeenCalledTimes(2);
			});
		});

		describe('loadCommits (Gerrit status filter x configuration matrix)', () => {
			// A repository holding every change status at once:
			//  100 open (2 patchsets), 200 merged (2 patchsets), 300 abandoned, 400 WIP (open + wip), 500 merged (3 patchsets)
			const CHANGE_OPEN = { change: 100, patchset: 2, codeReview: 1, verified: 0, status: 'new', wip: false, headHash: 'aaaa', events: [], url: null };
			const CHANGE_MERGED = { change: 200, patchset: 2, codeReview: 2, verified: 1, status: 'merged', wip: false, headHash: 'bbbb', events: [], url: null };
			const CHANGE_ABANDONED = { change: 300, patchset: 1, codeReview: 0, verified: 0, status: 'abandoned', wip: false, headHash: 'cccc', events: [], url: null };
			const CHANGE_WIP = { change: 400, patchset: 1, codeReview: 0, verified: 0, status: 'new', wip: true, headHash: 'dddd', events: [], url: null };
			const CHANGE_MERGED_MULTI_PS = { change: 500, patchset: 3, codeReview: 2, verified: 1, status: 'merged', wip: false, headHash: 'eeee', events: [], url: null };
			const ALL_CHANGES = [CHANGE_OPEN, CHANGE_MERGED, CHANGE_ABANDONED, CHANGE_WIP, CHANGE_MERGED_MULTI_PS];
			const REMOTE_PATCHSETS = new Map([[100, [1, 2]], [200, [1, 2]], [300, [1]], [400, [1]], [500, [1, 2, 3]]]);
			const byChange = (change: number) => ALL_CHANGES.find((state) => state.change === change)!;
			const ref = (change: number, patchset: number) => 'refs/remotes/origin/changes/' + ('0' + change % 100).slice(-2) + '/' + change + '/' + patchset;

			const loadCommitsBase = {
				command: 'loadCommits',
				repo: '/path/to/repo',
				branches: null,
				authors: null,
				maxCommits: 300,
				showTags: false,
				showRemoteBranches: false,
				includeCommitsMentionedByReflogs: false,
				onlyFollowFirstParent: false,
				commitOrdering: CommitOrdering.Date,
				remotes: ['origin'],
				hideRemotes: [],
				stashes: []
			} as const;

			const FILTER_DEFAULT = { new: true, merged: false, abandoned: false, wip: false };
			const FILTER_ALL = { new: true, merged: true, abandoned: true, wip: true };
			const FILTER_NONE = { new: false, merged: false, abandoned: false, wip: false };

			let spyOnListRemoteChanges: jest.SpyInstance, spyOnFetchChanges: jest.SpyInstance, spyOnGetCommits: jest.SpyInstance, previousGerrit: any;
			beforeEach(() => {
				// Setup (the auto-mocked DataSource doesn't construct GerritDataSource, so inject a mock;
				// clear the Gerrit cache and the commit cache so every test starts from a cold cache)
				GitGraphView.currentPanel!['gerritCache'].clear();
				GitGraphView.currentPanel!['gerritStaleRepos'].clear();
				GitGraphView.currentPanel!['commitCache'].clear();
				spyOnListRemoteChanges = jest.fn().mockResolvedValue(REMOTE_PATCHSETS);
				spyOnFetchChanges = jest.fn().mockResolvedValue(null);
				previousGerrit = (<any>dataSource).gerrit;
				(<any>dataSource).gerrit = {
					listRemoteChanges: spyOnListRemoteChanges,
					listLocalChangeRefs: jest.fn().mockResolvedValue([]),
					fetchChanges: spyOnFetchChanges,
					pruneLocalChanges: jest.fn().mockResolvedValue(undefined),
					getChangeUrlBase: jest.fn().mockResolvedValue(null),
					parseMetas: jest.fn().mockImplementation((_repo: string, _remote: string, changes: number[]) => {
						const states = new Map<number, any>();
						for (const change of changes) states.set(change, byChange(change));
						return Promise.resolve(states);
					})
				};
				spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValue({ commits: [], head: null, tags: [], moreCommitsAvailable: false, error: null });
			});
			afterEach(() => {
				(<any>dataSource).gerrit = previousGerrit;
				spyOnGetCommits.mockRestore();
			});

			/**
			 * Send a loadCommits request with the given status filter and await the FINAL response:
			 * a cold-cache load is answered twice (once immediately with the branch graph, marked
			 * `gerritPending`, then again with the fresh Gerrit data).
			 */
			const loadWithFilter = async (filter: { new: boolean; merged: boolean; abandoned: boolean; wip: boolean } | null, refreshId = 1) => {
				// The commit cache is deliberately cleared so each load exercises the full pipeline
				// (the cache's own behaviour is covered by a dedicated test in the Gerrit cache suite)
				GitGraphView.currentPanel!['commitCache'].clear();
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: refreshId, gerritStatusFilter: filter });
				await waitForExpect(() => {
					const responses = <any[]>messages.filter((m) => m.command === 'loadCommits' && m.refreshId === refreshId);
					expect(responses.length).toBeGreaterThan(0);
					expect(responses[responses.length - 1].gerritPending).not.toBe(true);
				});
			};

			/**
			 * Assert the Gerrit states and the change refs injected into the commit log of the LAST
			 * load. `deferred` must be true when the last load was served from the Gerrit cache (the
			 * branch that defers the uncommitted changes status), rather than the cold-cache pending
			 * path (which re-runs getCommits, unmodified, via loadCommitsGerritFollowUp).
			 */
			const expectLastLoad = (states: any[], refs: string[] | null, showChangeRefs = false, deferred = false) => {
				expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: states });
				const args: any[] = ['/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], refs, showChangeRefs, null];
				args.push(deferred);
				expect(spyOnGetCommits).toHaveBeenLastCalledWith(...args);
			};

			it('Serves only open (non-wip) changes and injects only their latest patchset refs (default chips)', async () => {
				await loadWithFilter(FILTER_DEFAULT);
				expectLastLoad(ALL_CHANGES, [ref(100, 2)]);
			});

			it('Toggling the "Merged" chip only adds review info: the injected refs (and thus the graph) stay identical', async () => {
				await loadWithFilter(FILTER_DEFAULT, 1);
				await loadWithFilter({ new: true, merged: true, abandoned: false, wip: false }, 2);
				expectLastLoad(ALL_CHANGES, [ref(100, 2)], false, true);
				expect(spyOnListRemoteChanges).toHaveBeenCalledTimes(1); // served from the cache
			});

			it('Toggling the "Abandoned" chip injects the abandoned change patchset ref', async () => {
				await loadWithFilter({ new: true, merged: false, abandoned: true, wip: false });
				expectLastLoad(ALL_CHANGES, [ref(100, 2), ref(300, 1)]);
			});

			it('Toggling the "WIP" chip injects the wip change patchset ref', async () => {
				await loadWithFilter({ new: true, merged: false, abandoned: false, wip: true });
				expectLastLoad(ALL_CHANGES, [ref(100, 2), ref(400, 1)]);
			});

			it('All chips enabled: every change is served, but merged changes still inject no refs', async () => {
				await loadWithFilter(FILTER_ALL);
				expectLastLoad(ALL_CHANGES, [ref(100, 2), ref(300, 1), ref(400, 1)]);
			});

			it('All chips disabled: no changes are served and no refs are injected', async () => {
				await loadWithFilter(FILTER_NONE);
				expectLastLoad(ALL_CHANGES, []);
			});

			it('Show Refs enabled via the gerrit.showChangeRefs setting: the Gerrit change refs must be displayed as remote branch refs', async () => {
				vscode.mockExtensionSettingReturnValue('gerrit.showChangeRefs', true);
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 1, gerritStatusFilter: FILTER_DEFAULT });
				await waitForExpect(() => {
					// A cold-cache load calls getCommits three times (the immediate branch graph,
					// the branches stage with the change refs injected, then the refs stage with the
					// change refs displayed); the last must pass the flag through
					expect(spyOnGetCommits).toHaveBeenCalledTimes(3);
				});
				expectLastLoad(ALL_CHANGES, [ref(100, 2)], true);
			});

			it('includeChangeCommits disabled: no refs are injected, review info is still served', async () => {
				vscode.mockExtensionSettingReturnValue('gerrit.includeChangeCommits', false);
				await loadWithFilter(FILTER_ALL);
				expectLastLoad(ALL_CHANGES, []);
			});

			it('patchsets mode "all": every patchset of non-merged changes is injected (merged stay excluded)', async () => {
				vscode.mockExtensionSettingReturnValue('gerrit.patchsets', 'all');
				await loadWithFilter({ new: true, merged: true, abandoned: false, wip: false });
				expectLastLoad(ALL_CHANGES, [ref(100, 1), ref(100, 2)]);
			});

			it('Gerrit integration disabled: no Gerrit states are served and getCommits receives NULL refs', async () => {
				vscode.mockExtensionSettingReturnValue('gerrit.enabled', false);
				await loadWithFilter(FILTER_ALL);
				expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: null });
				expect(spyOnGetCommits).toHaveBeenLastCalledWith('/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], null, false, null, true);
			});

			it('Gerrit fetchMode "off": no Gerrit states are served and getCommits receives NULL refs', async () => {
				vscode.mockExtensionSettingReturnValue('gerrit.fetchMode', 'off');
				await loadWithFilter(FILTER_ALL);
				expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: null });
				expect(spyOnGetCommits).toHaveBeenLastCalledWith('/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], null, false, null, true);
			});

			it('A NULL session filter falls back to the configured default status filter (merged changes still inject no refs)', async () => {
				vscode.mockExtensionSettingReturnValue('gerrit.statusFilter', { new: true, merged: true, abandoned: false, wip: false });
				await loadWithFilter(null);
				expectLastLoad(ALL_CHANGES, [ref(100, 2)]);
			});

			it('Degrades to the plain view (NULL Gerrit states) when the Gerrit fetch fails', async () => {
				spyOnFetchChanges.mockResolvedValue('error: unable to access remote');
				await loadWithFilter(FILTER_ALL);
				expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: null });
				expect(spyOnGetCommits).toHaveBeenLastCalledWith('/path/to/repo', null, null, 300, false, false, false, false, CommitOrdering.Date, ['origin'], [], [], null, false, null, false);
			});

			it('A failed forced refresh falls back to the last good cached Gerrit data', async () => {
				await loadWithFilter(FILTER_DEFAULT, 1);

				// Run (forced refresh whose fetch fails)
				spyOnFetchChanges.mockResolvedValueOnce('error: unable to access remote');
				onDidReceiveMessage({ ...loadCommitsBase, refreshId: 2, gerritStatusFilter: FILTER_DEFAULT, gerritForceRefresh: true });

				// Assert (the pipeline re-ran, but the previously cached states are still served)
				await waitForExpect(() => {
					expect(spyOnListRemoteChanges).toHaveBeenCalledTimes(2);
					expect(messages[messages.length - 1]).toMatchObject({ command: 'loadCommits', gerritStates: ALL_CHANGES });
				});
				expectLastLoad(ALL_CHANGES, [ref(100, 2)]);
			});
		});

		describe('fetchIntoLocalBranch', () => {
			it('Should fetch into local branch', async () => {
				// Setup
				const fetchIntoLocalBranchResolvedValue = null;
				const spyOnFetchIntoLocalBranch = jest.spyOn(dataSource, 'fetchIntoLocalBranch');
				spyOnFetchIntoLocalBranch.mockResolvedValueOnce(fetchIntoLocalBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'fetchIntoLocalBranch',
					repo: '/path/to/repo',
					remote: 'origin',
					remoteBranch: 'remote-branch',
					localBranch: 'local-branch',
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnFetchIntoLocalBranch).toHaveBeenCalledWith('/path/to/repo', 'origin', 'remote-branch', 'local-branch', false);
					expect(messages).toStrictEqual([
						{
							command: 'fetchIntoLocalBranch',
							error: fetchIntoLocalBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('loadCommits', () => {
			beforeEach(() => {
				// These tests verify the plain commit loading: disable the Gerrit integration so the
				// responses aren't answered in two phases (branch graph first, Gerrit data later)
				vscode.mockExtensionSettingReturnValue('gerrit.enabled', false);
			});
			const getCommitsResolvedValue = {
				commits: [
					{
						hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
						parents: [],
						author: 'Test Name',
						email: 'test@mhutchie.com',
						date: 1587559258,
						message: 'Commit Message 3',
						heads: ['master'],
						tags: [],
						remotes: [{ name: 'origin/master', remote: 'origin' }],
						stash: null
					}
				],
				head: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
				tags: ['tag1', 'tag2'],
				moreCommitsAvailable: false,
				error: null
			};

			it('Should serve identical commit loads from the commit cache, re-running Git only on a forced refresh', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValue(getCommitsResolvedValue);

				// Run (two identical requests: the second is served from the commit cache)
				for (const refreshId of [2, 3]) {
					onDidReceiveMessage({
						command: 'loadCommits',
						repo: '/path/to/repo',
						refreshId: refreshId,
						branches: null,
						authors: null,
						maxCommits: 300,
						showTags: true,
						showRemoteBranches: false,
						includeCommitsMentionedByReflogs: false,
						onlyFollowFirstParent: false,
						commitOrdering: CommitOrdering.Date,
						remotes: ['origin'],
						hideRemotes: [],
						stashes: [],
						gerritStatusFilter: null
					});
				}

				// Assert (both requests are answered, but Git only ran once; the deferred uncommitted-changes follow-ups add further responses, so only the initial deferred responses are counted here)
				await waitForExpect(() => {
					expect(messages.filter((m: any) => m.command === 'loadCommits' && m.uncommittedPending === true)).toHaveLength(2);
				});
				expect(spyOnGetCommits).toHaveBeenCalledTimes(1);

				// Run (a forced refresh bypasses the cache)
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 4,
					branches: null,
					authors: null,
					maxCommits: 300,
					showTags: true,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin'],
					hideRemotes: [],
					stashes: [],
					gerritStatusFilter: null,
					gerritForceRefresh: true
				});
				await waitForExpect(() => {
					expect(messages.filter((m: any) => m.command === 'loadCommits' && m.uncommittedPending === true).some((m: any) => m.refreshId === 4)).toBe(true);
				});
				expect(spyOnGetCommits).toHaveBeenCalledTimes(2);
				spyOnGetCommits.mockRestore();
			});

			it('Should get commits (show tags)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);
				jest.spyOn(dataSource, 'getUncommittedChanges').mockResolvedValueOnce(0);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					authors: null,
					maxCommits: 300,
					showTags: true,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					stashes: [],
					gerritStatusFilter: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, null, 300, true, false, false, false, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], null, false, null, true);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							uncommittedPending: true,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							gerritStates: null,
							error: getCommitsResolvedValue.error
						},
						{
							command: 'loadCommits',
							refreshId: 2,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							gerritStates: null,
							error: null
						}
					]);
					expect(GitGraphView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (show remote branches)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);
				jest.spyOn(dataSource, 'getUncommittedChanges').mockResolvedValueOnce(0);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					authors: null,
					maxCommits: 300,
					showTags: false,
					showRemoteBranches: true,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					stashes: [],
					gerritStatusFilter: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, null, 300, false, true, false, false, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], null, false, null, true);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							uncommittedPending: true,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							gerritStates: null,
							error: getCommitsResolvedValue.error
						},
						{
							command: 'loadCommits',
							refreshId: 2,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							gerritStates: null,
							error: null
						}
					]);
					expect(GitGraphView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (include commits mentioned by reflogs)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);
				jest.spyOn(dataSource, 'getUncommittedChanges').mockResolvedValueOnce(0);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					authors: null,
					maxCommits: 300,
					showTags: false,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: true,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					stashes: [],
					gerritStatusFilter: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, null, 300, false, false, true, false, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], null, false, null, true);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							uncommittedPending: true,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							gerritStates: null,
							error: getCommitsResolvedValue.error
						},
						{
							command: 'loadCommits',
							refreshId: 2,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							gerritStates: null,
							error: null
						}
					]);
					expect(GitGraphView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (only follow first parent)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);
				jest.spyOn(dataSource, 'getUncommittedChanges').mockResolvedValueOnce(0);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					authors: null,
					maxCommits: 300,
					showTags: false,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: true,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					stashes: [],
					gerritStatusFilter: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, null, 300, false, false, false, true, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], null, false, null, true);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							uncommittedPending: true,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: true,
							gerritStates: null,
							error: getCommitsResolvedValue.error
						},
						{
							command: 'loadCommits',
							refreshId: 2,
							commits: getCommitsResolvedValue.commits,
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: true,
							gerritStates: null,
							error: null
						}
					]);
					expect(GitGraphView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});
		});

		describe('loadRepoInfo', () => {
			it('Should get the repository information (initial repo load)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					tags: [],
					error: null
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				spyOnSetLastActiveRepo.mockImplementationOnce(() => { });
				spyOnRepoFileWatcherStart.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					refreshId: 0,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream']);
					expect(spyOnRepoRoot).not.toHaveBeenCalled();
					expect(spyOnSetLastActiveRepo).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnRepoFileWatcherStart).toHaveBeenCalledWith('/path/to/repo');
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 0,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							tags: getRepoInfoResolvedValue.tags,
							isRepo: true,
							error: getRepoInfoResolvedValue.error
						}
					]);
					expect(GitGraphView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitGraphView.currentPanel!['loadRepoInfoRefreshId']).toBe(0);
				});
			});

			it('Should get the repository information (subsequent repo load)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					tags: [],
					error: null
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				GitGraphView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					refreshId: 1,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream']);
					expect(spyOnRepoRoot).not.toHaveBeenCalled();
					expect(spyOnSetLastActiveRepo).not.toHaveBeenCalled();
					expect(spyOnRepoFileWatcherStart).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 1,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							tags: getRepoInfoResolvedValue.tags,
							isRepo: true,
							error: getRepoInfoResolvedValue.error
						}
					]);
					expect(GitGraphView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitGraphView.currentPanel!['loadRepoInfoRefreshId']).toBe(1);
				});
			});

			it('Should get the repository information (error thrown by getRepoInfo)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					tags: [],
					error: 'error message'
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				spyOnRepoRoot.mockResolvedValueOnce('/path/to/repo');
				GitGraphView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					refreshId: 2,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream']);
					expect(spyOnRepoRoot).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnSetLastActiveRepo).not.toHaveBeenCalled();
					expect(spyOnRepoFileWatcherStart).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 2,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							tags: getRepoInfoResolvedValue.tags,
							isRepo: true,
							error: getRepoInfoResolvedValue.error
						}
					]);
					expect(GitGraphView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitGraphView.currentPanel!['loadRepoInfoRefreshId']).toBe(2);
				});
			});

			it('Should get the repository information (repo no longer exists)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					tags: [],
					error: 'error message'
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitGraphView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				spyOnRepoRoot.mockResolvedValueOnce(null);
				GitGraphView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					refreshId: 3,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream']);
					expect(spyOnRepoRoot).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnSetLastActiveRepo).not.toHaveBeenCalled();
					expect(spyOnRepoFileWatcherStart).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 3,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							tags: getRepoInfoResolvedValue.tags,
							isRepo: false,
							error: null
						}
					]);
					expect(GitGraphView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitGraphView.currentPanel!['loadRepoInfoRefreshId']).toBe(3);
				});
			});
		});

		describe('loadConfig', () => {
			it('Should get the Git configuration for a repository', async () => {
				// Setup
				const getConfigResolvedValue = { config: null, error: null };
				const spyOnGetConfig = jest.spyOn(dataSource, 'getConfig');
				spyOnGetConfig.mockResolvedValueOnce(getConfigResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'loadConfig',
					repo: '/path/to/repo',
					remotes: ['origin']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetConfig).toHaveBeenCalledWith('/path/to/repo', ['origin']);
					expect(messages).toStrictEqual([
						{
							command: 'loadConfig',
							repo: '/path/to/repo',
							config: getConfigResolvedValue.config,
							error: getConfigResolvedValue.error
						}
					]);
				});
			});
		});

		describe('loadRepos', () => {
			it('Should load the repositories (without checking for new repositories)', async () => {
				// Setup
				const spyOnCheckReposExist = jest.spyOn(repoManager, 'checkReposExist');

				// Run
				onDidReceiveMessage({
					command: 'loadRepos',
					check: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckReposExist).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepos',
							repos: { '/path/to/repo': mockRepoState() },
							lastActiveRepo: null,
							loadViewTo: null
						}
					]);
				});
			});

			it('Should load the repositories (found one new repository)', async () => {
				// Setup
				const spyOnCheckReposExist = jest.spyOn(repoManager, 'checkReposExist');
				spyOnCheckReposExist.mockResolvedValueOnce(true);

				// Run
				onDidReceiveMessage({
					command: 'loadRepos',
					check: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckReposExist).toHaveBeenCalledWith();
					expect(messages).toHaveLength(0);
				});
			});

			it('Should load the repositories (no new repositories)', async () => {
				// Setup
				const spyOnCheckReposExist = jest.spyOn(repoManager, 'checkReposExist');
				spyOnCheckReposExist.mockResolvedValueOnce(false);

				// Run
				onDidReceiveMessage({
					command: 'loadRepos',
					check: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckReposExist).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepos',
							repos: { '/path/to/repo': mockRepoState() },
							lastActiveRepo: null,
							loadViewTo: null
						}
					]);
				});
			});
		});

		describe('merge', () => {
			it('Should perform a merge (creating a new commit)', async () => {
				// Setup
				const mergeResolvedValue = null;
				const spyOnMerge = jest.spyOn(dataSource, 'merge');
				spyOnMerge.mockResolvedValueOnce(mergeResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'merge',
					repo: '/path/to/repo',
					obj: 'master',
					actionOn: MergeActionOn.Branch,
					createNewCommit: true,
					squash: false,
					noCommit: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnMerge).toHaveBeenCalledWith('/path/to/repo', 'master', MergeActionOn.Branch, true, false, false);
					expect(messages).toStrictEqual([
						{
							command: 'merge',
							actionOn: MergeActionOn.Branch,
							error: mergeResolvedValue
						}
					]);
				});
			});

			it('Should perform a merge (squash)', async () => {
				// Setup
				const mergeResolvedValue = null;
				const spyOnMerge = jest.spyOn(dataSource, 'merge');
				spyOnMerge.mockResolvedValueOnce(mergeResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'merge',
					repo: '/path/to/repo',
					obj: 'master',
					actionOn: MergeActionOn.Branch,
					createNewCommit: false,
					squash: true,
					noCommit: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnMerge).toHaveBeenCalledWith('/path/to/repo', 'master', MergeActionOn.Branch, false, true, false);
					expect(messages).toStrictEqual([
						{
							command: 'merge',
							actionOn: MergeActionOn.Branch,
							error: mergeResolvedValue
						}
					]);
				});
			});

			it('Should perform a merge (no commit)', async () => {
				// Setup
				const mergeResolvedValue = null;
				const spyOnMerge = jest.spyOn(dataSource, 'merge');
				spyOnMerge.mockResolvedValueOnce(mergeResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'merge',
					repo: '/path/to/repo',
					obj: 'master',
					actionOn: MergeActionOn.Branch,
					createNewCommit: false,
					squash: false,
					noCommit: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnMerge).toHaveBeenCalledWith('/path/to/repo', 'master', MergeActionOn.Branch, false, false, true);
					expect(messages).toStrictEqual([
						{
							command: 'merge',
							actionOn: MergeActionOn.Branch,
							error: mergeResolvedValue
						}
					]);
				});
			});
		});

		describe('openExtensionSettings', () => {
			it('Should open the Extension Settings', async () => {
				// Setup
				const openExtensionSettingsResolvedValue = null;
				const spyOnOpenExtensionSettings = jest.spyOn(utils, 'openExtensionSettings');
				spyOnOpenExtensionSettings.mockResolvedValueOnce(openExtensionSettingsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openExtensionSettings'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenExtensionSettings).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'openExtensionSettings',
							error: openExtensionSettingsResolvedValue
						}
					]);
				});
			});
		});

		describe('openExternalDirDiff', () => {
			it('Should open an External Directory Diff', async () => {
				// Setup
				const openExternalDirDiffResolvedValue = null;
				const spyOnOpenExternalDirDiff = jest.spyOn(dataSource, 'openExternalDirDiff');
				spyOnOpenExternalDirDiff.mockResolvedValueOnce(openExternalDirDiffResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openExternalDirDiff',
					repo: '/path/to/repo',
					fromHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					toHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					isGui: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenExternalDirDiff).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', false);
					expect(messages).toStrictEqual([
						{
							command: 'openExternalDirDiff',
							error: openExternalDirDiffResolvedValue
						}
					]);
				});
			});
		});

		describe('openExternalUrl', () => {
			it('Should open an External URL', async () => {
				// Setup
				const openExternalUrlResolvedValue = null;
				const spyOnOpenExternalUrl = jest.spyOn(utils, 'openExternalUrl');
				spyOnOpenExternalUrl.mockResolvedValueOnce(openExternalUrlResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openExternalUrl',
					url: 'https://www.mhutchie.com'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenExternalUrl).toHaveBeenCalledWith('https://www.mhutchie.com');
					expect(messages).toStrictEqual([
						{
							command: 'openExternalUrl',
							error: openExternalUrlResolvedValue
						}
					]);
				});
			});
		});

		describe('openFile', () => {
			it('Should open a file', async () => {
				// Setup
				const openFileResolvedValue = null;
				const spyOnOpenFile = jest.spyOn(utils, 'openFile');
				spyOnOpenFile.mockResolvedValueOnce(openFileResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openFile',
					repo: '/path/to/repo',
					hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'file.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenFile).toHaveBeenCalledWith('/path/to/repo', 'file.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', dataSource);
					expect(messages).toStrictEqual([
						{
							command: 'openFile',
							error: openFileResolvedValue
						}
					]);
				});
			});
		});

		describe('openTerminal', () => {
			it('Should open a terminal', async () => {
				// Setup
				const openGitTerminalResolvedValue = null;
				const spyOnOpenGitTerminal = jest.spyOn(dataSource, 'openGitTerminal');
				spyOnOpenGitTerminal.mockResolvedValueOnce(openGitTerminalResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openTerminal',
					repo: '/path/to/repo',
					name: 'repo-name'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenGitTerminal).toHaveBeenCalledWith('/path/to/repo', null, 'repo-name');
					expect(messages).toStrictEqual([
						{
							command: 'openTerminal',
							error: openGitTerminalResolvedValue
						}
					]);
				});
			});
		});

		describe('popStash', () => {
			it('Should pop a stash', async () => {
				// Setup
				const popStashResolvedValue = null;
				const spyOnPopStash = jest.spyOn(dataSource, 'popStash');
				spyOnPopStash.mockResolvedValueOnce(popStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'popStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}',
					reinstateIndex: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPopStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}', true);
					expect(messages).toStrictEqual([
						{
							command: 'popStash',
							error: popStashResolvedValue
						}
					]);
				});
			});
		});

		describe('pruneRemote', () => {
			it('Should prune a remote', async () => {
				// Setup
				const pruneRemoteResolvedValue = null;
				const spyOnPruneRemote = jest.spyOn(dataSource, 'pruneRemote');
				spyOnPruneRemote.mockResolvedValueOnce(pruneRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pruneRemote',
					repo: '/path/to/repo',
					name: 'origin'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPruneRemote).toHaveBeenCalledWith('/path/to/repo', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'pruneRemote',
							error: pruneRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('pullBranch', () => {
			it('Should pull a branch from a remote', async () => {
				// Setup
				const pullBranchResolvedValue = null;
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnPullBranch.mockResolvedValueOnce(pullBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pullBranch',
					repo: '/path/to/repo',
					branchName: 'master',
					remote: 'origin',
					createNewCommit: true,
					squash: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPullBranch).toHaveBeenCalledWith('/path/to/repo', 'master', 'origin', true, false);
					expect(messages).toStrictEqual([
						{
							command: 'pullBranch',
							error: pullBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('pushBranch', () => {
			it('Should push a branch to a remote', async () => {
				// Setup
				const pushBranchToMultipleRemotesResolvedValue = [null];
				const spyOnPushBranchToMultipleRemotes = jest.spyOn(dataSource, 'pushBranchToMultipleRemotes');
				spyOnPushBranchToMultipleRemotes.mockResolvedValueOnce(pushBranchToMultipleRemotesResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pushBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remotes: ['origin'],
					setUpstream: true,
					mode: GitPushBranchMode.Normal,
					willUpdateBranchConfig: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranchToMultipleRemotes).toHaveBeenCalledWith('/path/to/repo', 'develop', ['origin'], true, GitPushBranchMode.Normal);
					expect(messages).toStrictEqual([
						{
							command: 'pushBranch',
							willUpdateBranchConfig: false,
							errors: pushBranchToMultipleRemotesResolvedValue
						}
					]);
				});
			});
		});

		describe('pushStash', () => {
			it('Should push a stash', async () => {
				// Setup
				const pushStashResolvedValue = null;
				const spyOnPushStash = jest.spyOn(dataSource, 'pushStash');
				spyOnPushStash.mockResolvedValueOnce(pushStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pushStash',
					repo: '/path/to/repo',
					message: 'stash message',
					includeUntracked: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushStash).toHaveBeenCalledWith('/path/to/repo', 'stash message', true);
					expect(messages).toStrictEqual([
						{
							command: 'pushStash',
							error: pushStashResolvedValue
						}
					]);
				});
			});
		});

		describe('pushTag', () => {
			it('Should push a tag to a remote', async () => {
				// Setup
				const spyOnPushTagResolvedValue = [null];
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnPushTag.mockResolvedValueOnce(spyOnPushTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pushTag',
					repo: '/path/to/repo',
					tagName: 'tag-name',
					remotes: ['origin'],
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					skipRemoteCheck: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushTag).toHaveBeenCalledWith('/path/to/repo', 'tag-name', ['origin'], '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true);
					expect(messages).toStrictEqual([
						{
							command: 'pushTag',
							repo: '/path/to/repo',
							tagName: 'tag-name',
							remotes: ['origin'],
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: spyOnPushTagResolvedValue
						}
					]);
				});
			});
		});

		describe('rebase', () => {
			it('Should rebase the current branch on a branch', async () => {
				// Setup
				const rebaseResolvedValue = null;
				const spyOnRebase = jest.spyOn(dataSource, 'rebase');
				spyOnRebase.mockResolvedValueOnce(rebaseResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'rebase',
					repo: '/path/to/repo',
					obj: 'feature',
					actionOn: RebaseActionOn.Branch,
					ignoreDate: true,
					interactive: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRebase).toHaveBeenCalledWith('/path/to/repo', 'feature', RebaseActionOn.Branch, true, false);
					expect(messages).toStrictEqual([
						{
							command: 'rebase',
							actionOn: RebaseActionOn.Branch,
							interactive: false,
							error: rebaseResolvedValue
						}
					]);
				});
			});
		});

		describe('renameBranch', () => {
			it('Should rename a branch', async () => {
				// Setup
				const renameBranchResolvedValue = null;
				const spyOnRenameBranch = jest.spyOn(dataSource, 'renameBranch');
				spyOnRenameBranch.mockResolvedValueOnce(renameBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'renameBranch',
					repo: '/path/to/repo',
					oldName: 'old-branch',
					newName: 'new-branch'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRenameBranch).toHaveBeenCalledWith('/path/to/repo', 'old-branch', 'new-branch');
					expect(messages).toStrictEqual([
						{
							command: 'renameBranch',
							error: renameBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('rescanForRepos', () => {
			it('Should rescan the workspace for repositories (repositories added)', async () => {
				// Setup
				const spyOnSearchWorkspaceForRepos = jest.spyOn(repoManager, 'searchWorkspaceForRepos');
				const spyOnShowErrorMessage = jest.spyOn(utils, 'showErrorMessage');
				spyOnSearchWorkspaceForRepos.mockResolvedValueOnce(true);

				// Run
				onDidReceiveMessage({
					command: 'rescanForRepos'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSearchWorkspaceForRepos).toHaveBeenCalledWith();
					expect(spyOnShowErrorMessage).not.toHaveBeenCalled();
					expect(messages).toHaveLength(0);
				});
			});

			it('Should rescan the workspace for repositories (no new repositories were found)', async () => {
				// Setup
				const spyOnSearchWorkspaceForRepos = jest.spyOn(repoManager, 'searchWorkspaceForRepos');
				const spyOnShowErrorMessage = jest.spyOn(utils, 'showErrorMessage');
				spyOnSearchWorkspaceForRepos.mockResolvedValueOnce(false);
				spyOnShowErrorMessage.mockResolvedValueOnce();

				// Run
				onDidReceiveMessage({
					command: 'rescanForRepos'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSearchWorkspaceForRepos).toHaveBeenCalledWith();
					expect(spyOnShowErrorMessage).toHaveBeenCalledWith('No Git repositories were found in the current workspace.');
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('resetFileToRevision', () => {
			it('Should reset the file to a revision', async () => {
				// Setup
				const resetFileToRevisionResolvedValue = null;
				const spyOnResetFileToRevision = jest.spyOn(dataSource, 'resetFileToRevision');
				spyOnResetFileToRevision.mockResolvedValueOnce(resetFileToRevisionResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'resetFileToRevision',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'path/to/file'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnResetFileToRevision).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'path/to/file');
					expect(messages).toStrictEqual([
						{
							command: 'resetFileToRevision',
							error: resetFileToRevisionResolvedValue
						}
					]);
				});
			});
		});

		describe('resetToCommit', () => {
			it('Should reset the current branch to a commit', async () => {
				// Setup
				const resetToCommitResolvedValue = null;
				const spyOnResetToCommit = jest.spyOn(dataSource, 'resetToCommit');
				spyOnResetToCommit.mockResolvedValueOnce(resetToCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'resetToCommit',
					repo: '/path/to/repo',
					commit: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					resetMode: GitResetMode.Mixed
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnResetToCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', GitResetMode.Mixed);
					expect(messages).toStrictEqual([
						{
							command: 'resetToCommit',
							error: resetToCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('revertCommit', () => {
			it('Should revert a commit', async () => {
				// Setup
				const revertCommitResolvedValue = null;
				const spyOnRevertCommit = jest.spyOn(dataSource, 'revertCommit');
				spyOnRevertCommit.mockResolvedValueOnce(revertCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'revertCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					parentIndex: 1
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRevertCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 1);
					expect(messages).toStrictEqual([
						{
							command: 'revertCommit',
							error: revertCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('setGlobalViewState', () => {
			it('Should set the Global View State', async () => {
				// Setup
				const globalViewState: GitGraphViewGlobalState = {
					alwaysAcceptCheckoutCommit: true,
					issueLinkingConfig: null,
					pushTagSkipRemoteCheck: false
				};
				const setGlobalViewStateResolvedValue = null;
				const spyOnSetGlobalViewState = jest.spyOn(extensionState, 'setGlobalViewState');
				spyOnSetGlobalViewState.mockResolvedValueOnce(setGlobalViewStateResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'setGlobalViewState',
					state: globalViewState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetGlobalViewState).toHaveBeenCalledWith(globalViewState);
					expect(messages).toStrictEqual([
						{
							command: 'setGlobalViewState',
							error: setGlobalViewStateResolvedValue
						}
					]);
				});
			});
		});

		describe('setRepoState', () => {
			it('Should set the Repository State', async () => {
				// Setup
				const repoState = mockRepoState();
				const spyOnSetRepoState = jest.spyOn(repoManager, 'setRepoState');
				spyOnSetRepoState.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'setRepoState',
					repo: '/path/to/repo',
					state: repoState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetRepoState).toHaveBeenCalledWith('/path/to/repo', repoState);
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('setWorkspaceViewState', () => {
			it('Should set the Workspace View State', async () => {
				// Setup
				const workspaceViewState: GitGraphViewWorkspaceState = {
					findIsCaseSensitive: true,
					findIsRegex: false,
					findOpenCommitDetailsView: true
				};
				const setWorkspaceViewStateResolvedValue = null;
				const spyOnSetWorkspaceViewState = jest.spyOn(extensionState, 'setWorkspaceViewState');
				spyOnSetWorkspaceViewState.mockResolvedValueOnce(setWorkspaceViewStateResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'setWorkspaceViewState',
					state: workspaceViewState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetWorkspaceViewState).toHaveBeenCalledWith(workspaceViewState);
					expect(messages).toStrictEqual([
						{
							command: 'setWorkspaceViewState',
							error: setWorkspaceViewStateResolvedValue
						}
					]);
				});
			});
		});

		describe('showErrorMessage', () => {
			it('Should show a Visual Studio Code Error Message', async () => {
				// Setup
				const spyOnShowErrorMessage = jest.spyOn(utils, 'showErrorMessage');
				spyOnShowErrorMessage.mockResolvedValueOnce();

				// Run
				onDidReceiveMessage({
					command: 'showErrorMessage',
					message: 'error message'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnShowErrorMessage).toHaveBeenCalledWith('error message');
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('startCodeReview', () => {
			it('Should start a code review', async () => {
				// Setup
				const startCodeReviewResolvedValue = {
					codeReview: {
						id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
						lastActive: 1587559258000,
						lastViewedFile: null,
						remainingFiles: ['file1.txt', 'file2.txt', 'file3.txt']
					},
					error: null
				};
				const spyOnStartCodeReview = jest.spyOn(extensionState, 'startCodeReview');
				spyOnStartCodeReview.mockResolvedValueOnce(startCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'startCodeReview',
					repo: '/path/to/repo',
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					files: ['file1.txt', 'file2.txt', 'file3.txt'],
					lastViewedFile: null,
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					compareWithHash: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnStartCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', ['file1.txt', 'file2.txt', 'file3.txt'], null);
					expect(messages).toStrictEqual([
						{
							command: 'startCodeReview',
							codeReview: startCodeReviewResolvedValue.codeReview,
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							compareWithHash: null,
							error: startCodeReviewResolvedValue.error
						}
					]);
				});
			});
		});

		describe('tagDetails', () => {
			it('Should get a tag\'s details', async () => {
				// Setup
				const getTagDetailsResolvedValue = { details: null, error: null };
				const spyOnGetTagDetails = jest.spyOn(dataSource, 'getTagDetails');
				spyOnGetTagDetails.mockResolvedValueOnce(getTagDetailsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'tagDetails',
					repo: '/path/to/repo',
					tagName: 'tag-name',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetTagDetails).toHaveBeenCalledWith('/path/to/repo', 'tag-name');
					expect(messages).toStrictEqual([
						{
							command: 'tagDetails',
							tagName: 'tag-name',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							details: null,
							error: null
						}
					]);
				});
			});
		});

		describe('updateCodeReview', () => {
			it('Should update a code review', async () => {
				// Setup
				const updateCodeReviewResolvedValue = null;
				const spyOnUpdateCodeReview = jest.spyOn(extensionState, 'updateCodeReview');
				spyOnUpdateCodeReview.mockResolvedValueOnce(updateCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'updateCodeReview',
					repo: '/path/to/repo',
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					remainingFiles: ['file2.txt', 'file3.txt'],
					lastViewedFile: 'file1.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUpdateCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', ['file2.txt', 'file3.txt'], 'file1.txt');
					expect(messages).toStrictEqual([
						{
							command: 'updateCodeReview',
							error: updateCodeReviewResolvedValue
						}
					]);
				});
			});
		});

		describe('viewDiff', () => {
			it('Should open a diff', async () => {
				// Setup
				const viewDiffResolvedValue = null;
				const spyOnViewDiff = jest.spyOn(utils, 'viewDiff');
				spyOnViewDiff.mockResolvedValueOnce(viewDiffResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewDiff',
					repo: '/path/to/repo',
					fromHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					toHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					oldFilePath: 'old-file.txt',
					newFilePath: 'new-file.txt',
					type: GitFileStatus.Renamed
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewDiff).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'old-file.txt', 'new-file.txt', GitFileStatus.Renamed);
					expect(messages).toStrictEqual([
						{
							command: 'viewDiff',
							error: viewDiffResolvedValue
						}
					]);
				});
			});
		});

		describe('viewDiffWithWorkingFile', () => {
			it('Should open a diff with the working file', async () => {
				// Setup
				const viewDiffWithWorkingFileResolvedValue = null;
				const spyOnViewDiffWithWorkingFile = jest.spyOn(utils, 'viewDiffWithWorkingFile');
				spyOnViewDiffWithWorkingFile.mockResolvedValueOnce(viewDiffWithWorkingFileResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewDiffWithWorkingFile',
					repo: '/path/to/repo',
					hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'file.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewDiffWithWorkingFile).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'file.txt', dataSource);
					expect(messages).toStrictEqual([
						{
							command: 'viewDiffWithWorkingFile',
							error: viewDiffWithWorkingFileResolvedValue
						}
					]);
				});
			});
		});

		describe('viewFileAtRevision', () => {
			it('Should view a file at a revision', async () => {
				// Setup
				const viewFileAtRevisionResolvedValue = null;
				const spyOnViewFileAtRevision = jest.spyOn(utils, 'viewFileAtRevision');
				spyOnViewFileAtRevision.mockResolvedValueOnce(viewFileAtRevisionResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewFileAtRevision',
					repo: '/path/to/repo',
					hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'file.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewFileAtRevision).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'file.txt');
					expect(messages).toStrictEqual([
						{
							command: 'viewFileAtRevision',
							error: viewFileAtRevisionResolvedValue
						}
					]);
				});
			});
		});

		describe('viewScm', () => {
			it('Should open the Visual Studio Code Source Control View', async () => {
				// Setup
				const viewScmResolvedValue = null;
				const spyOnViewScm = jest.spyOn(utils, 'viewScm');
				spyOnViewScm.mockResolvedValueOnce(viewScmResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewScm'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewScm).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'viewScm',
							error: viewScmResolvedValue
						}
					]);
				});
			});
		});
	});

	describe('sendMessage', () => {
		beforeEach(() => {
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			spyOnLog.mockReset();
			spyOnLogError.mockReset();
		});

		it('Should send a message to the Webview', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockResolvedValueOnce(true);

			// Run
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).toHaveBeenCalledWith({
					command: 'viewScm',
					error: null
				});
				expect(spyOnLog).not.toHaveBeenCalled();
				expect(spyOnLogError).not.toHaveBeenCalled();
			});
		});

		it('Should log an error message when Webview.postMessage rejects, and the GitGraphView hasn\'t been disposed', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockRejectedValueOnce(null);

			// Run
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).toHaveBeenCalledWith({
					command: 'viewScm',
					error: null
				});
				expect(spyOnLog).not.toHaveBeenCalled();
				expect(spyOnLogError).toHaveBeenCalledWith('Unable to send "viewScm" message to the Git Graph View.');
			});
		});

		it('Should log an information message when Webview.postMessage rejects, and the GitGraphView has been disposed', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockImplementationOnce(() => {
				GitGraphView.currentPanel!.dispose();
				return Promise.reject();
			});

			// Run
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).toHaveBeenCalledWith({
					command: 'viewScm',
					error: null
				});
				expect(spyOnLog).toHaveBeenCalledWith('The Git Graph View was disposed while sending "viewScm" message.');
				expect(spyOnLogError).not.toHaveBeenCalled();
			});
		});

		it('Shouldn\'t send a message to the Webview if it has been disposed', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockResolvedValueOnce(true);

			// Run
			GitGraphView.currentPanel!.dispose();
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).not.toHaveBeenCalled();
				expect(spyOnLog).toHaveBeenCalledWith('The Git Graph View has already been disposed, ignored sending "viewScm" message.');
				expect(spyOnLogError).not.toHaveBeenCalled();
			});
		});
	});

	describe('getHtmlForWebview', () => {
		beforeEach(() => {
			jest.spyOn(utils, 'getNonce').mockReturnValueOnce('1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d');
		});
		afterEach(() => {
			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src vscode-webview-resource: \'unsafe-inline\'; script-src \'nonce-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d\'; img-src data: https:;">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<link rel="stylesheet" type="text/css" href="vscode-webview-resource://file///path/to/extension/media/out.min.css?v=1.39.0">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<title>Git Graph</title>');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<style>body{--git-graph-color0:#0085d9; --git-graph-color1:#d9008f; --git-graph-color2:#00d90a; --git-graph-color3:#d98500; --git-graph-color4:#a300d9; --git-graph-color5:#ff0000; --git-graph-color6:#00d9cc; --git-graph-color7:#e138e8; --git-graph-color8:#85d900; --git-graph-color9:#dc5b23; --git-graph-color10:#6f24d6; --git-graph-color11:#ffcc00; } [data-color=\"0\"]{--git-graph-color:var(--git-graph-color0);} [data-color=\"1\"]{--git-graph-color:var(--git-graph-color1);} [data-color=\"2\"]{--git-graph-color:var(--git-graph-color2);} [data-color=\"3\"]{--git-graph-color:var(--git-graph-color3);} [data-color=\"4\"]{--git-graph-color:var(--git-graph-color4);} [data-color=\"5\"]{--git-graph-color:var(--git-graph-color5);} [data-color=\"6\"]{--git-graph-color:var(--git-graph-color6);} [data-color=\"7\"]{--git-graph-color:var(--git-graph-color7);} [data-color=\"8\"]{--git-graph-color:var(--git-graph-color8);} [data-color=\"9\"]{--git-graph-color:var(--git-graph-color9);} [data-color=\"10\"]{--git-graph-color:var(--git-graph-color10);} [data-color=\"11\"]{--git-graph-color:var(--git-graph-color11);} </style>');
		});

		it('Should get HTML when no Git executable is known', () => {
			// Setup
			spyOnIsGitExecutableUnknown.mockReturnValueOnce(true);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<h2>Unable to load Review Graph</h2>');
			expect(mockedWebviewPanel.panel.webview.html).toContain(utils.UNABLE_TO_FIND_GIT_MSG);
		});

		it('Should get HTML when no repositories are found in the workspace', () => {
			// Setup
			spyOnGetRepos.mockResolvedValueOnce({});

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<h2>Unable to load Review Graph</h2>');
			expect(mockedWebviewPanel.panel.webview.html).toContain('No Git repositories were found in the current workspace when it was last scanned by Git Graph.');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d">');
		});

		it('Should get HTML when repositories exist', () => {
			// Setup
			const spyOnIsAvatarStorageAvailable = jest.spyOn(extensionState, 'isAvatarStorageAvailable');
			vscode.mockExtensionSettingReturnValue('repository.commits.fetchAvatars', false);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<div id="view" tabindex="-1">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d" src="vscode-webview-resource://file///path/to/extension/media/out.min.js?v=1.39.0"></script>');
			expect(spyOnIsAvatarStorageAvailable).not.toHaveBeenCalled();
		});

		it('Should get HTML when repositories exist (fetch avatars enabled)', () => {
			// Setup
			const spyOnIsAvatarStorageAvailable = jest.spyOn(extensionState, 'isAvatarStorageAvailable');
			vscode.mockExtensionSettingReturnValue('repository.commits.fetchAvatars', true);

			// Run
			GitGraphView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<div id="view" tabindex="-1">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d" src="vscode-webview-resource://file///path/to/extension/media/out.min.js?v=1.39.0"></script>');
			expect(spyOnIsAvatarStorageAvailable).toHaveBeenCalledWith();
		});
	});
});

describe('standardiseCspSource', () => {
	it('Should not affect vscode-resource scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('vscode-resource:');

		// Assert
		expect(result).toBe('vscode-resource:');
	});

	it('Should not affect file scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('file:');

		// Assert
		expect(result).toBe('file:');
	});

	it('Should not affect http scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('http:');

		// Assert
		expect(result).toBe('http:');
	});

	it('Should not affect https scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('https:');

		// Assert
		expect(result).toBe('https:');
	});

	it('Should not affect file scheme sources', () => {
		// Run
		const result = standardiseCspSource('file://server');

		// Assert
		expect(result).toBe('file://server');
	});

	it('Should not affect http host-only sources', () => {
		// Run
		const result = standardiseCspSource('http://www.mhutchie.com');

		// Assert
		expect(result).toBe('http://www.mhutchie.com');
	});

	it('Should not affect https host-only sources', () => {
		// Run
		const result = standardiseCspSource('https://www.mhutchie.com');

		// Assert
		expect(result).toBe('https://www.mhutchie.com');
	});

	it('Should not affect https host-only IP sources', () => {
		// Run
		const result = standardiseCspSource('https://192.168.1.101');

		// Assert
		expect(result).toBe('https://192.168.1.101');
	});

	it('Should remove the path component from http sources', () => {
		// Run
		const result = standardiseCspSource('http://www.mhutchie.com/path/to/file');

		// Assert
		expect(result).toBe('http://www.mhutchie.com');
	});

	it('Should remove the path component from https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.mhutchie.com/path/to/file');

		// Assert
		expect(result).toBe('https://www.mhutchie.com');
	});

	it('Should remove the path component from https IP sources', () => {
		// Run
		const result = standardiseCspSource('https://192.168.1.101:8080/path/to/file');

		// Assert
		expect(result).toBe('https://192.168.1.101:8080');
	});

	it('Should remove the query from http/https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.mhutchie.com?query');

		// Assert
		expect(result).toBe('https://www.mhutchie.com');
	});

	it('Should remove the fragment from http/https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.mhutchie.com#fragment');

		// Assert
		expect(result).toBe('https://www.mhutchie.com');
	});

	it('Should remove the path, query & fragment from http/https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.mhutchie.com:443/path/to/file?query#fragment');

		// Assert
		expect(result).toBe('https://www.mhutchie.com:443');
	});
});
