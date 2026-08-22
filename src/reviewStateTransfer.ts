import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeReviewData, CodeReviews, ExtensionState } from './extensionState';
import { ErrorInfo } from './types';

/** The JSON document exported by the "Export Code Review State" command. */
export interface ReviewStateExport {
	version: 1;
	/** The repository the reviews belong to (used as a repository identifier when importing). */
	repo: string;
	/** When the state was exported (ISO 8601). */
	exportedAt: string;
	/** The Code Reviews of the repository, keyed by review id (the git diff arguments). */
	reviews: { [id: string]: CodeReviewData };
}

/**
 * Serialise the Code Reviews of a repository into the JSON export document.
 * @param repo The repository the reviews belong to.
 * @param reviews The Code Reviews of the repository.
 * @param exportedAt The export timestamp.
 * @returns The JSON string of the export document.
 */
export function serializeReviewState(repo: string, reviews: { [id: string]: CodeReviewData }, exportedAt: Date = new Date()): string {
	const doc: ReviewStateExport = {
		version: 1,
		repo: repo,
		exportedAt: exportedAt.toISOString(),
		reviews: reviews
	};
	return JSON.stringify(doc, null, '\t');
}

function isValidReview(value: any): value is CodeReviewData {
	return value !== null && typeof value === 'object'
		&& typeof value.lastActive === 'number' && isFinite(value.lastActive) && value.lastActive > 0
		&& (value.lastViewedFile === null || typeof value.lastViewedFile === 'string')
		&& Array.isArray(value.remainingFiles) && value.remainingFiles.every((file: any) => typeof file === 'string');
}

/**
 * Parse and validate a Code Review state export document.
 * @param content The file content.
 * @returns The parsed document, or NULL if the content isn't a valid export.
 */
export function parseReviewState(content: string): ReviewStateExport | null {
	let doc: any;
	try {
		doc = JSON.parse(content);
	} catch (_) {
		return null;
	}
	if (doc === null || typeof doc !== 'object' || doc.version !== 1 || typeof doc.repo !== 'string' || typeof doc.exportedAt !== 'string' || doc.reviews === null || typeof doc.reviews !== 'object') return null;
	const reviews: { [id: string]: CodeReviewData } = {};
	for (const id of Object.keys(doc.reviews)) {
		if (isValidReview(doc.reviews[id])) reviews[id] = doc.reviews[id];
	}
	return { version: 1, repo: doc.repo, exportedAt: doc.exportedAt, reviews: reviews };
}

/**
 * Merge imported Code Reviews into the existing reviews of a repository: imported reviews
 * override existing reviews with the same id, all other existing reviews are kept.
 * @param existing The current set of Code Reviews (not modified).
 * @param repo The repository to import the reviews into.
 * @param imported The imported reviews of the repository.
 * @returns The merged set of Code Reviews.
 */
export function mergeCodeReviews(existing: CodeReviews, repo: string, imported: { [id: string]: CodeReviewData }): CodeReviews {
	const merged: CodeReviews = {};
	for (const repoPath of Object.keys(existing)) merged[repoPath] = existing[repoPath];
	const repoReviews = Object.assign({}, merged[repo], imported);
	if (Object.keys(repoReviews).length > 0) merged[repo] = repoReviews;
	else delete merged[repo];
	return merged;
}

/**
 * Export the Code Reviews of a repository to a JSON file chosen with a Save dialog.
 * @param extensionState The Git Graph ExtensionState instance.
 * @param repo The repository to export the Code Reviews of.
 * @returns The ErrorInfo of the failure (NULL => exported successfully, or the user cancelled).
 */
export async function exportCodeReviewState(extensionState: ExtensionState, repo: string): Promise<ErrorInfo> {
	const reviews = extensionState.getCodeReviews()[repo];
	if (reviews === undefined || Object.keys(reviews).length === 0) {
		return 'There are no Code Reviews to export for this repository.';
	}
	const uri = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(path.join(os.homedir(), (repo.replace(/[\\\/]+$/, '').split(/[\\\/]/).pop() || 'repository') + '-code-review-state.json')),
		filters: { 'Code Review State': ['json'], 'All Files': ['*'] }
	});
	if (uri === undefined) return null; // the user cancelled the dialog
	try {
		fs.writeFileSync(uri.fsPath, serializeReviewState(repo, reviews), 'utf8');
	} catch (error) {
		return 'Unable to write the file: ' + (error instanceof Error ? error.message : String(error));
	}
	vscode.window.showInformationMessage('Exported the Code Review state (' + Object.keys(reviews).length + ' review' + (Object.keys(reviews).length > 1 ? 's' : '') + ') of this repository.');
	return null;
}

/**
 * Import Code Reviews of a repository from a JSON file chosen with an Open dialog.
 * @param extensionState The Git Graph ExtensionState instance.
 * @param repo The repository to import the Code Reviews into.
 * @returns The ErrorInfo of the failure (NULL => imported successfully, or the user cancelled).
 */
export async function importCodeReviewState(extensionState: ExtensionState, repo: string): Promise<ErrorInfo> {
	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { 'Code Review State': ['json'], 'All Files': ['*'] }
	});
	if (uris === undefined || uris.length === 0) return null; // the user cancelled the dialog

	let content: string;
	try {
		content = fs.readFileSync(uris[0].fsPath, 'utf8');
	} catch (error) {
		return 'Unable to read the file: ' + (error instanceof Error ? error.message : String(error));
	}
	const doc = parseReviewState(content);
	if (doc === null) return 'The file is not a valid Code Review state export.';

	const error = await extensionState.setCodeReviews(mergeCodeReviews(extensionState.getCodeReviews(), repo, doc.reviews));
	if (error !== null) return error;
	const numReviews = Object.keys(doc.reviews).length;
	vscode.window.showInformationMessage('Imported ' + numReviews + ' Code Review' + (numReviews > 1 ? 's' : '') + ' into this repository' + (doc.repo !== repo ? ' (exported from "' + doc.repo + '")' : '') + '.');
	return null;
}
