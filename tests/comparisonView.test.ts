import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/dataSource');
jest.mock('../src/logger');

import { DataSource } from '../src/dataSource';
import { Logger } from '../src/logger';
import { CommitComparisonView } from '../src/comparisonView';
import { GitFileChange, GitFileStatus } from '../src/types';
import * as utils from '../src/utils';

import { waitForExpect } from './helpers/expectations';

const REPO = '/path/to/repo';
const HASH_A = '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b';
const HASH_B = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function mockFileChange(overrides: Partial<GitFileChange>): GitFileChange {
	return Object.assign({
		oldFilePath: 'file.txt',
		newFilePath: 'file.txt',
		type: GitFileStatus.Modified,
		additions: 1,
		deletions: 2
	}, overrides);
}

describe('CommitComparisonView', () => {
	let dataSource: DataSource;
	let spyOnGetCommitComparison: jest.SpyInstance;
	let spyOnGetCommitSummaries: jest.SpyInstance;
	let spyOnGetCommitFileDiff: jest.SpyInstance;

	beforeAll(() => {
		dataSource = new DataSource({ path: '/path/to/git', version: '2.25.0' }, jest.fn(), jest.fn(), new Logger());

		spyOnGetCommitComparison = jest.spyOn(dataSource, 'getCommitComparison');
		spyOnGetCommitSummaries = jest.spyOn(dataSource, 'getCommitSummaries');
		spyOnGetCommitFileDiff = jest.spyOn(dataSource, 'getCommitFileDiff');
	});

	afterAll(() => {
		dataSource.dispose();
	});

	const DEFAULT_SUMMARIES = {
		[HASH_A]: { hash: HASH_A, author: 'Alice <alice@example.com>', email: 'alice@example.com', date: 1600000000, message: 'First commit' },
		[HASH_B]: { hash: HASH_B, author: 'Bob <bob@example.com>', email: 'bob@example.com', date: 1600001000, message: 'Second commit' }
	};

	function mockSuccessfulLoad(fileChanges: GitFileChange[] = [mockFileChange({})]) {
		spyOnGetCommitComparison.mockResolvedValue({ error: null, fileChanges: fileChanges });
		spyOnGetCommitSummaries.mockResolvedValue(DEFAULT_SUMMARIES);
		return new Promise<void>((resolve) => waitForExpect(() => resolve()));
	}

	function currentPanelHtml() {
		return vscode.getMockedWebviewPanel(0).panel.webview.html;
	}

	function sendWebviewMessage(msg: any) {
		const panel = vscode.getMockedWebviewPanel(0);
		panel.mocks.panel.webview.onDidReceiveMessage(msg);
	}

	function disposePanel() {
		const panel = vscode.getMockedWebviewPanel(0);
		panel.mocks.panel.onDidDispose(undefined as any);
	}

	beforeEach(() => {
		// Safe defaults, so that views opened by a test never hit an unmocked undefined result
		spyOnGetCommitComparison.mockReset().mockResolvedValue({ error: null, fileChanges: [] });
		spyOnGetCommitSummaries.mockReset().mockResolvedValue(DEFAULT_SUMMARIES);
		spyOnGetCommitFileDiff.mockReset().mockResolvedValue('+a line');
	});

	afterEach(() => {
		// Dispose any views left open by the test, so they do not leak into the next one
		for (let i = 0; i < 100; i++) {
			const panel = vscode.getMockedWebviewPanel(i);
			if (panel === undefined) break;
			panel.mocks.panel.onDidDispose(undefined as any);
		}
	});

	describe('open', () => {
		it('Should create a webview panel with a title abbreviating both commit hashes', () => {
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			expect(vscode.getMockedWebviewPanel(0).panel.viewType).toBe('review-graph.compare');
			expect(vscode.getMockedWebviewPanel(0).panel.title).toBe('Compare ' + HASH_A.substring(0, 8) + ' ↔ ' + HASH_B.substring(0, 8));
		});

		it('Should show "Present" instead of a hash when comparing against the working tree', () => {
			CommitComparisonView.open(dataSource, REPO, HASH_A, '');
			expect(vscode.getMockedWebviewPanel(0).panel.title).toBe('Compare ' + HASH_A.substring(0, 8) + ' ↔ Present');
		});

		it('Should render a loading state before the Git commands complete', () => {
			spyOnGetCommitComparison.mockReturnValue(new Promise(() => { }));
			spyOnGetCommitSummaries.mockReturnValue(new Promise(() => { }));
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			expect(currentPanelHtml()).toContain('Loading changes');
		});

		it('Should render the commit cards, file tree and stats once loaded', async () => {
			await mockSuccessfulLoad([
				mockFileChange({ newFilePath: 'src/a.ts', additions: 3, deletions: 0 }),
				mockFileChange({ oldFilePath: 'src/b.ts', newFilePath: '', type: GitFileStatus.Deleted, additions: null, deletions: null })
			]);
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));
			const html = currentPanelHtml();
			expect(html).toContain('Second commit');
			expect(html).toContain('Alice &lt;alice@example.com&gt;'); // commit metadata is HTML-escaped
			expect(html).toContain('src/a.ts'); // the file changes are embedded for the webview script
			expect(html).not.toContain('Loading changes');
		});

		it('Should not request summaries for the uncommitted pseudo-hash', async () => {
			await mockSuccessfulLoad();
			CommitComparisonView.open(dataSource, REPO, HASH_A, utils.UNCOMMITTED);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));
			expect(spyOnGetCommitSummaries).toHaveBeenCalledWith(REPO, [HASH_A]);
			expect(currentPanelHtml()).toContain('Uncommitted changes');
		});

		it('Should show an error message when the comparison fails', async () => {
			spyOnGetCommitComparison.mockResolvedValue({ error: 'fatal: bad object', fileChanges: [] });
			spyOnGetCommitSummaries.mockResolvedValue(DEFAULT_SUMMARIES);
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('fatal: bad object'));
			expect(currentPanelHtml()).toContain('Error');
		});

		it('Should show an error message when the Git command rejects', async () => {
			spyOnGetCommitComparison.mockRejectedValue(new Error('spawn ENOENT'));
			spyOnGetCommitSummaries.mockResolvedValue(null);
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('spawn ENOENT'));
		});

		it('Should escape HTML in commit messages to prevent XSS in the webview', async () => {
			spyOnGetCommitComparison.mockResolvedValue({ error: null, fileChanges: [] });
			spyOnGetCommitSummaries.mockResolvedValue({
				[HASH_A]: { hash: HASH_A, author: 'x', email: 'x', date: 0, message: '<img src=x onerror=alert(1)>' },
				[HASH_B]: { hash: HASH_B, author: 'x', email: 'x', date: 0, message: 'ok' }
			});
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('&lt;img src=x'));
			expect(currentPanelHtml()).not.toContain('<img src=x onerror');
		});

		it('Should not update the webview if the tab was closed while the Git commands were running', async () => {
			let resolveComparison: (value: any) => void;
			spyOnGetCommitComparison.mockReturnValue(new Promise((resolve) => { resolveComparison = resolve; }));
			spyOnGetCommitSummaries.mockResolvedValue(DEFAULT_SUMMARIES);
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			const panel = vscode.getMockedWebviewPanel(0).panel;
			const initialHtml = panel.webview.html;
			vscode.getMockedWebviewPanel(0).mocks.panel.onDidDispose(undefined as any);
			resolveComparison!({ error: null, fileChanges: [mockFileChange({})] });
			await waitForExpect(() => expect(panel.dispose).toHaveBeenCalled());
			expect(panel.webview.html).toBe(initialHtml);
		});
	});

	describe('reusing existing views', () => {
		it('Should reveal the existing panel when the same range is opened again', async () => {
			await mockSuccessfulLoad();
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));

			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			expect(vscode.getMockedWebviewPanel(1)).toBeUndefined(); // no second panel was created
			expect(vscode.getMockedWebviewPanel(0).panel.reveal).toHaveBeenCalled();
			expect(spyOnGetCommitComparison).toHaveBeenCalledTimes(1);
		});

		it('Should open a separate panel for a different commit range', async () => {
			await mockSuccessfulLoad();
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			CommitComparisonView.open(dataSource, REPO, HASH_B, HASH_A);
			expect(vscode.getMockedWebviewPanel(1)).not.toBeUndefined();
		});

		it('Should allow the same range to be reopened after the tab was closed', async () => {
			await mockSuccessfulLoad();
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));
			disposePanel();

			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			expect(vscode.getMockedWebviewPanel(1)).not.toBeUndefined();
		});
	});

	describe('webview messages', () => {
		it('Should respond to getFileDiff with the diff of the requested file', async () => {
			const fileA = mockFileChange({ newFilePath: 'a.txt', oldFilePath: 'a.txt' });
			const fileB = mockFileChange({ newFilePath: 'b.txt', oldFilePath: 'b.txt', type: GitFileStatus.Added, additions: 5, deletions: 0 });
			await mockSuccessfulLoad([fileA, fileB]);
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));

			sendWebviewMessage({ command: 'getFileDiff', index: 1 });
			await waitForExpect(() => expect(spyOnGetCommitFileDiff).toHaveBeenCalledWith(REPO, HASH_A, HASH_B, 'b.txt', 'b.txt'));
			const messages = vscode.getMockedWebviewPanel(0).mocks.messages;
			expect(messages[messages.length - 1]).toEqual({ command: 'fileDiff', index: 1, diff: '+a line', error: null });
		});

		it('Should report getFileDiff errors back to the webview instead of rejecting', async () => {
			await mockSuccessfulLoad();
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));
			spyOnGetCommitFileDiff.mockRejectedValue(new Error('git crashed'));

			sendWebviewMessage({ command: 'getFileDiff', index: 0 });
			const messages = vscode.getMockedWebviewPanel(0).mocks.messages;
			await waitForExpect(() => expect(messages[messages.length - 1]).toEqual({ command: 'fileDiff', index: 0, diff: null, error: 'git crashed' }));
		});

		it('Should open a diff editor when the webview requests viewDiff', async () => {
			const executeCommand = jest.fn((..._args: any[]) => Promise.resolve());
			vscode.commands.registerCommand('vscode.diff', executeCommand);
			const file = mockFileChange({ newFilePath: 'src/a.ts', oldFilePath: 'src/a.ts' });
			await mockSuccessfulLoad([file]);
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));

			sendWebviewMessage({ command: 'viewDiff', index: 0 });
			await waitForExpect(() => expect(executeCommand).toHaveBeenCalledTimes(1));
			const diffArgs = executeCommand.mock.calls[0];
			expect(diffArgs.length).toBe(4); // (leftUri, rightUri, title, options)
			expect(diffArgs[2]).toContain('a.ts');
		});

		it('Should ignore webview messages after the view has been disposed', async () => {
			await mockSuccessfulLoad();
			CommitComparisonView.open(dataSource, REPO, HASH_A, HASH_B);
			await waitForExpect(() => expect(currentPanelHtml()).toContain('First commit'));
			disposePanel();

			spyOnGetCommitFileDiff.mockClear();
			sendWebviewMessage({ command: 'getFileDiff', index: 0 });
			await Promise.resolve();
			expect(spyOnGetCommitFileDiff).not.toHaveBeenCalled();
		});
	});
});
