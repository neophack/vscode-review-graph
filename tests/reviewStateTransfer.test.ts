import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { ExtensionState } from '../src/extensionState';
import { CodeReviewData } from '../src/extensionState';
import { exportCodeReviewState, importCodeReviewState, mergeCodeReviews, parseReviewState, serializeReviewState } from '../src/reviewStateTransfer';

const REVIEW_A: CodeReviewData = { lastActive: 1587559258000, lastViewedFile: 'file1.txt', remainingFiles: ['file2.txt', 'file3.txt'] };
const REVIEW_B: CodeReviewData = { lastActive: 1587559358000, lastViewedFile: null, remainingFiles: [] };

describe('Review State Transfer', () => {
	describe('serializeReviewState / parseReviewState', () => {
		it('round-trips a review state export', () => {
			const exportedAt = new Date(1600000000000);
			const json = serializeReviewState('/path/to/repo', { 'a1b2': REVIEW_A, 'c3d4': REVIEW_B }, exportedAt);
			const parsed = parseReviewState(json);
			expect(parsed).toEqual({ version: 1, repo: '/path/to/repo', exportedAt: exportedAt.toISOString(), reviews: { 'a1b2': REVIEW_A, 'c3d4': REVIEW_B } });
		});
		it('rejects invalid documents', () => {
			expect(parseReviewState('not json')).toBeNull();
			expect(parseReviewState('null')).toBeNull();
			expect(parseReviewState('{}')).toBeNull();
			expect(parseReviewState(JSON.stringify({ version: 2, repo: 'r', exportedAt: 'x', reviews: {} }))).toBeNull();
			expect(parseReviewState(JSON.stringify({ version: 1, repo: 'r', exportedAt: 'x' }))).toBeNull();
		});
		it('skips invalid review entries but keeps the valid ones', () => {
			const parsed = parseReviewState(JSON.stringify({
				version: 1, repo: 'r', exportedAt: 'x',
				reviews: {
					valid: REVIEW_A,
					noLastActive: { lastViewedFile: null, remainingFiles: [] },
					badFiles: { lastActive: 1, lastViewedFile: null, remainingFiles: ['ok', 42] },
					badViewedFile: { lastActive: 1, lastViewedFile: 5, remainingFiles: [] }
				}
			}));
			expect(parsed).not.toBeNull();
			expect(Object.keys(parsed!.reviews)).toEqual(['valid']);
		});
	});

	describe('mergeCodeReviews', () => {
		it('overrides reviews with the same id and keeps all other reviews', () => {
			const existing = {
				'/path/to/repo': { 'a1b2': REVIEW_A, 'keep': REVIEW_B },
				'/path/to/other': { 'x': REVIEW_A }
			};
			const imported: { 'a1b2': CodeReviewData } = { 'a1b2': { lastActive: 9, lastViewedFile: null, remainingFiles: ['new'] } };
			const merged = mergeCodeReviews(existing, '/path/to/repo', imported);
			expect(merged['/path/to/repo']).toEqual({ 'a1b2': imported['a1b2'], 'keep': REVIEW_B });
			expect(merged['/path/to/other']).toEqual({ 'x': REVIEW_A });
			// The input isn't modified
			expect(existing['/path/to/repo']['a1b2']).toBe(REVIEW_A);
		});
		it('adds reviews to a repository without existing reviews', () => {
			const merged = mergeCodeReviews({}, '/path/to/repo', { 'a1b2': REVIEW_A });
			expect(merged).toEqual({ '/path/to/repo': { 'a1b2': REVIEW_A } });
		});
		it('removes the repository entry when there is nothing left', () => {
			const merged = mergeCodeReviews({ '/path/to/repo': {} }, '/path/to/repo', {});
			expect(merged).toEqual({});
		});
	});

	describe('exportCodeReviewState / importCodeReviewState', () => {
		let filePath: string;

		beforeEach(() => {
			(<jest.Mock>vscode.window.showSaveDialog).mockReset().mockResolvedValue(undefined);
			(<jest.Mock>vscode.window.showOpenDialog).mockReset().mockResolvedValue(undefined);
			(<jest.Mock>vscode.window.showInformationMessage).mockReset();
			filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-review-state-')), 'state.json');
		});

		it('exports the reviews of a repository to the chosen file', async () => {
			(<jest.Mock>vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file(filePath));
			const setCodeReviews = jest.fn().mockResolvedValue(null);
			const state = <ExtensionState><unknown>{ getCodeReviews: () => ({ '/path/to/repo': { 'a1b2': REVIEW_A } }), setCodeReviews };

			expect(await exportCodeReviewState(state, '/path/to/repo')).toBeNull();
			const parsed = parseReviewState(fs.readFileSync(filePath, 'utf8'));
			expect(parsed).toEqual({ version: 1, repo: '/path/to/repo', exportedAt: expect.any(String), reviews: { 'a1b2': REVIEW_A } });
			expect(setCodeReviews).not.toHaveBeenCalled();
		});

		it('returns no error when the save dialog is cancelled', async () => {
			const state = <ExtensionState><unknown>{ getCodeReviews: () => ({ '/path/to/repo': { 'a1b2': REVIEW_A } }), setCodeReviews: jest.fn() };
			expect(await exportCodeReviewState(state, '/path/to/repo')).toBeNull();
		});

		it('fails when the repository has no code reviews', async () => {
			const state = <ExtensionState><unknown>{ getCodeReviews: () => ({}), setCodeReviews: jest.fn() };
			expect(await exportCodeReviewState(state, '/path/to/repo')).not.toBeNull();
		});

		it('imports reviews from a file, merging them into the existing reviews', async () => {
			fs.writeFileSync(filePath, serializeReviewState('/path/to/other', { 'a1b2': REVIEW_B }));
			(<jest.Mock>vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(filePath)]);
			const setCodeReviews = jest.fn().mockResolvedValue(null);
			const existing = { '/path/to/repo': { 'keep': REVIEW_A }, '/path/to/other': { 'x': REVIEW_A } };
			const state = <ExtensionState><unknown>{ getCodeReviews: () => existing, setCodeReviews };

			expect(await importCodeReviewState(state, '/path/to/repo')).toBeNull();
			expect(setCodeReviews).toHaveBeenCalledWith({
				'/path/to/repo': { 'keep': REVIEW_A, 'a1b2': REVIEW_B },
				'/path/to/other': { 'x': REVIEW_A }
			});
		});

		it('fails on an invalid file', async () => {
			fs.writeFileSync(filePath, 'not json');
			(<jest.Mock>vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(filePath)]);
			const state = <ExtensionState><unknown>{ getCodeReviews: () => ({}), setCodeReviews: jest.fn() };
			expect(await importCodeReviewState(state, '/path/to/repo')).not.toBeNull();
			expect(state.setCodeReviews).not.toHaveBeenCalled();
		});

		it('returns no error when the open dialog is cancelled', async () => {
			const state = <ExtensionState><unknown>{ getCodeReviews: () => ({}), setCodeReviews: jest.fn() };
			expect(await importCodeReviewState(state, '/path/to/repo')).toBeNull();
			expect(state.setCodeReviews).not.toHaveBeenCalled();
		});
	});
});
