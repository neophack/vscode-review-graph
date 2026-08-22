import * as https from 'https';
import { EventEmitter } from 'events';

import './mocks/vscode';
jest.mock('vscode', () => require('./mocks/vscode'), { virtual: true });
jest.mock('https', () => ({ get: jest.fn() }));

import { PullRequestDataSource, fetchJson, findPullRequestForBranch, parseGithubPulls, parseGitlabMergeRequests, parseRemoteUrl } from '../src/pullRequests';
import { PullRequestInfo } from '../src/types';

/* Helpers to simulate https.get requests and responses */

function makeResponse(statusCode: number, body: string) {
	const response = new EventEmitter();
	(<any>response).statusCode = statusCode;
	(<any>response).headers = {};
	(<any>response).resume = jest.fn();
	process.nextTick(() => {
		response.emit('data', Buffer.from(body, 'utf8'));
		response.emit('end');
	});
	return response;
}

function mockHttpsGet(responder: (url: string) => { statusCode: number; body: string } | Error) {
	const get = <jest.Mock>https.get;
	get.mockImplementation((options: any, callback: (response: any) => void) => {
		const request = new EventEmitter();
		(<any>request).setTimeout = jest.fn((timeout: number, cb: () => void) => { setTimeout(cb, timeout); });
		(<any>request).destroy = jest.fn((error?: Error) => request.emit('error', error !== undefined ? error : new Error('destroyed')));
		process.nextTick(() => {
			const result = responder(options.path !== undefined ? options.hostname + options.path : String(options));
			if (result instanceof Error) {
				request.emit('error', result);
			} else {
				callback(makeResponse(result.statusCode, result.body));
			}
		});
		return request;
	});
}

describe('Pull Requests', () => {
	describe('parseRemoteUrl', () => {
		it('parses a GitHub HTTPS remote', () => {
			expect(parseRemoteUrl('https://github.com/owner/repo.git')).toEqual({ platform: 'github', apiBase: 'https://api.github.com', owner: 'owner', repo: 'repo' });
			expect(parseRemoteUrl('https://github.com/owner/repo')).toEqual({ platform: 'github', apiBase: 'https://api.github.com', owner: 'owner', repo: 'repo' });
		});
		it('parses a GitHub SSH remote', () => {
			expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({ platform: 'github', apiBase: 'https://api.github.com', owner: 'owner', repo: 'repo' });
			expect(parseRemoteUrl('ssh://git@github.com/owner/repo.git')).toEqual({ platform: 'github', apiBase: 'https://api.github.com', owner: 'owner', repo: 'repo' });
		});
		it('parses a GitLab.com remote', () => {
			expect(parseRemoteUrl('https://gitlab.com/owner/repo.git')).toEqual({ platform: 'gitlab', apiBase: 'https://gitlab.com/api/v4', owner: 'owner', repo: 'owner/repo' });
		});
		it('parses a self-hosted GitLab remote, keeping the full project path of subgroups', () => {
			expect(parseRemoteUrl('https://gitlab.example.com/group/subgroup/project.git')).toEqual({ platform: 'gitlab', apiBase: 'https://gitlab.example.com/api/v4', owner: 'group', repo: 'group/subgroup/project' });
			expect(parseRemoteUrl('git@gitlab.example.com:group/subgroup/project.git')).toEqual({ platform: 'gitlab', apiBase: 'https://gitlab.example.com/api/v4', owner: 'group', repo: 'group/subgroup/project' });
		});
		it('rejects non-supported remote URLs', () => {
			expect(parseRemoteUrl('/local/path/repo')).toBeNull();
			expect(parseRemoteUrl('https://github.com/onlyowner')).toBeNull();
			expect(parseRemoteUrl('git@example.com:repo')).toBeNull();
			expect(parseRemoteUrl('')).toBeNull();
		});
	});

	describe('parseGithubPulls', () => {
		it('parses open, draft, merged and closed pull requests', () => {
			const pulls = parseGithubPulls([
				{ number: 1, title: 'Open PR', state: 'open', merged_at: null, user: { login: 'alice' }, html_url: 'https://github.com/o/r/pull/1', head: { ref: 'feature-a' } },
				{ number: 2, title: 'Draft PR', state: 'open', draft: true, user: { login: 'bob' }, html_url: 'https://github.com/o/r/pull/2', head: { ref: 'feature-b' } },
				{ number: 3, title: 'Merged PR', state: 'closed', merged_at: '2026-01-01T00:00:00Z', user: { login: 'carol' }, html_url: 'https://github.com/o/r/pull/3', head: { ref: 'feature-c' } },
				{ number: 4, title: 'Closed PR', state: 'closed', merged_at: null, user: { login: 'dave' }, html_url: 'https://github.com/o/r/pull/4', head: { ref: 'feature-d' } }
			]);
			expect(pulls).toEqual(<PullRequestInfo[]>[
				{ number: 1, title: 'Open PR', state: 'open', author: 'alice', url: 'https://github.com/o/r/pull/1', sourceBranch: 'feature-a' },
				{ number: 2, title: 'Draft PR', state: 'draft', author: 'bob', url: 'https://github.com/o/r/pull/2', sourceBranch: 'feature-b' },
				{ number: 3, title: 'Merged PR', state: 'merged', author: 'carol', url: 'https://github.com/o/r/pull/3', sourceBranch: 'feature-c' },
				{ number: 4, title: 'Closed PR', state: 'closed', author: 'dave', url: 'https://github.com/o/r/pull/4', sourceBranch: 'feature-d' }
			]);
		});
		it('skips invalid entries and non-array responses', () => {
			expect(parseGithubPulls({ message: 'Not Found' })).toEqual([]);
			expect(parseGithubPulls([null, { title: 'no number' }, { number: 5, title: 'Valid', state: 'open', merged_at: null, user: null, html_url: '', head: null }])).toEqual([
				{ number: 5, title: 'Valid', state: 'open', author: '', url: '', sourceBranch: '' }
			]);
		});
	});

	describe('parseGitlabMergeRequests', () => {
		it('parses opened, WIP and merged merge requests', () => {
			const mrs = parseGitlabMergeRequests([
				{ iid: 11, title: 'Open MR', state: 'opened', author: { name: 'Alice', username: 'alice' }, web_url: 'https://gitlab.com/o/r/-/merge_requests/11', source_branch: 'feature-a' },
				{ iid: 12, title: 'WIP MR', state: 'opened', work_in_progress: true, author: { name: 'Bob' }, web_url: 'https://gitlab.com/o/r/-/merge_requests/12', source_branch: 'feature-b' },
				{ iid: 13, title: 'Merged MR', state: 'merged', author: { name: 'Carol' }, web_url: 'https://gitlab.com/o/r/-/merge_requests/13', source_branch: 'feature-c' }
			]);
			expect(mrs).toEqual(<PullRequestInfo[]>[
				{ number: 11, title: 'Open MR', state: 'open', author: 'Alice', url: 'https://gitlab.com/o/r/-/merge_requests/11', sourceBranch: 'feature-a' },
				{ number: 12, title: 'WIP MR', state: 'draft', author: 'Bob', url: 'https://gitlab.com/o/r/-/merge_requests/12', sourceBranch: 'feature-b' },
				{ number: 13, title: 'Merged MR', state: 'merged', author: 'Carol', url: 'https://gitlab.com/o/r/-/merge_requests/13', sourceBranch: 'feature-c' }
			]);
		});
		it('skips invalid entries and non-array responses', () => {
			expect(parseGitlabMergeRequests('error')).toEqual([]);
			expect(parseGitlabMergeRequests([{ title: 'no iid' }])).toEqual([]);
		});
	});

	describe('findPullRequestForBranch', () => {
		const pulls: PullRequestInfo[] = [
			{ number: 1, title: 'First', state: 'open', author: 'a', url: 'u1', sourceBranch: 'feature-a' },
			{ number: 2, title: 'Second', state: 'open', author: 'b', url: 'u2', sourceBranch: 'feature-b' }
		];
		it('finds the pull request of a branch', () => {
			expect(findPullRequestForBranch(pulls, 'feature-b')).toBe(pulls[1]);
		});
		it('returns NULL when no pull request matches', () => {
			expect(findPullRequestForBranch(pulls, 'main')).toBeNull();
			expect(findPullRequestForBranch([], 'feature-a')).toBeNull();
		});
	});

	describe('PullRequestDataSource', () => {
		afterEach(() => {
			delete process.env.GITHUB_TOKEN;
			delete process.env.GITLAB_TOKEN;
		});

		it('queries the GitHub API for a GitHub remote', async () => {
			mockHttpsGet(() => ({ statusCode: 200, body: JSON.stringify([{ number: 7, title: 'T', state: 'open', merged_at: null, user: { login: 'u' }, html_url: 'h', head: { ref: 'feature-a' } }]) }));
			const prs = await new PullRequestDataSource().getPullRequests('https://github.com/owner/repo.git');
			expect(prs).toEqual([{ number: 7, title: 'T', state: 'open', author: 'u', url: 'h', sourceBranch: 'feature-a' }]);
			expect((<jest.Mock>https.get).mock.calls[0][0]).toMatchObject({ hostname: 'api.github.com', path: '/repos/owner/repo/pulls?state=all&per_page=100' });
		});

		it('sends the GITHUB_TOKEN as a Bearer token when set', async () => {
			mockHttpsGet(() => ({ statusCode: 200, body: '[]' }));
			process.env.GITHUB_TOKEN = 'gh-token';
			await new PullRequestDataSource().getPullRequests('https://github.com/owner/repo.git');
			expect((<jest.Mock>https.get).mock.calls[0][0].headers['Authorization']).toBe('Bearer gh-token');
		});

		it('queries the GitLab API with a url-encoded project path', async () => {
			mockHttpsGet(() => ({ statusCode: 200, body: '[]' }));
			await new PullRequestDataSource().getPullRequests('https://gitlab.example.com/group/sub/project.git');
			expect((<jest.Mock>https.get).mock.calls[0][0]).toMatchObject({ hostname: 'gitlab.example.com', path: '/api/v4/projects/' + encodeURIComponent('group/sub/project') + '/merge_requests?state=opened&per_page=100' });
		});

		it('sends the GITLAB_TOKEN as a PRIVATE-TOKEN header when set', async () => {
			mockHttpsGet(() => ({ statusCode: 200, body: '[]' }));
			process.env.GITLAB_TOKEN = 'gl-token';
			await new PullRequestDataSource().getPullRequests('https://gitlab.com/owner/repo.git');
			expect((<jest.Mock>https.get).mock.calls[0][0].headers['PRIVATE-TOKEN']).toBe('gl-token');
		});

		it('matches the pull request of a branch', async () => {
			mockHttpsGet(() => ({ statusCode: 200, body: JSON.stringify([{ number: 7, title: 'T', state: 'open', merged_at: null, user: { login: 'u' }, html_url: 'h', head: { ref: 'feature-a' } }]) }));
			const pr = await new PullRequestDataSource().getPullRequestForBranch('https://github.com/owner/repo.git', 'feature-a');
			expect(pr).not.toBeNull();
			expect(pr!.number).toBe(7);
			expect(await new PullRequestDataSource().getPullRequestForBranch('https://github.com/owner/repo.git', 'other')).toBeNull();
		});

		it('degrades to NULL for non-supported remotes, HTTP errors and request failures', async () => {
			const dataSource = new PullRequestDataSource();
			expect(await dataSource.getPullRequests('/local/path')).toBeNull();
			mockHttpsGet(() => ({ statusCode: 404, body: '{"message":"Not Found"}' }));
			expect(await dataSource.getPullRequests('https://github.com/owner/repo.git')).toBeNull();
			mockHttpsGet(() => new Error('network unreachable'));
			expect(await dataSource.getPullRequests('https://gitlab.com/owner/repo.git')).toBeNull();
		});
	});

	describe('fetchJson', () => {
		it('rejects on a non-2xx status code', async () => {
			mockHttpsGet(() => ({ statusCode: 403, body: '[]' }));
			await expect(fetchJson('https://example.com/api', {}, 1000)).rejects.toBe('HTTP 403');
		});
		it('rejects on invalid JSON', async () => {
			mockHttpsGet(() => ({ statusCode: 200, body: '<html>not json' }));
			await expect(fetchJson('https://example.com/api', {}, 1000)).rejects.toBe('invalid JSON response');
		});
		it('rejects on a request error', async () => {
			mockHttpsGet(() => new Error('ECONNREFUSED'));
			await expect(fetchJson('https://example.com/api', {}, 1000)).rejects.toBeInstanceOf(Error);
		});
	});
});
