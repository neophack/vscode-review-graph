/**
 * Integration test: run the compiled extension (out/*) against a real repository
 * with a Gerrit remote, exercising the full Gerrit pipeline + commit loading.
 *
 * Usage: node scripts/integrationTest.js <repoPath> [remote]
 * NOTE: never submits/pushes anything; only runs the same git commands the view runs on refresh.
 */
const path = require('path');
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') return require.resolve('./gerritShim.js');
	return origResolve.call(this, request, ...args);
};

const repo = process.argv[2];
const remote = process.argv[3] || 'origin';
if (!repo) { console.error('Usage: node integrationTest.js <repoPath> [remote]'); process.exit(1); }

const DataSource = require('../out/dataSource.js').DataSource;
const gerritMod = require('../out/gerrit.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('  PASS ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
	else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}

async function main() {
	const utils = require('../out/utils.js');
	const gitExecutable = await utils.getGitExecutable('git');
	const ds = new DataSource(gitExecutable, () => ({ dispose: () => undefined }), () => undefined, { log: () => undefined, logCmd: () => undefined });
	const gs = new gerritMod.GerritDataSource(ds);
	console.log('git ' + gitExecutable.version + ' @ ' + repo);

	console.log('\n== 1. Repo basics ==');
	const branchData = await ds.getBranches(repo, true, []);
	const branches = branchData.branches;
	check('getBranches returns a list + head', Array.isArray(branches) && branchData.head !== null, branches.length + ' branches, head=' + branchData.head);
	const remotes = await ds.getRemotes(repo);
	check('getRemotes includes "' + remote + '"', remotes.includes(remote), remotes.join(', '));
	const stashes = await ds.getStashes(repo);
	check('getStashes works', Array.isArray(stashes), stashes.length + ' stashes');

	console.log('\n== 2. Gerrit pipeline: ls-remote -> fetch -> prune ==');
	const allChanges = await gs.listRemoteChanges(repo, remote);
	check('listRemoteChanges (ls-remote refs/changes/*)', allChanges instanceof Map, allChanges.size + ' changes on remote');
	const changes = gerritMod.limitChanges(allChanges, 10);
	check('limitChanges(10) keeps <= 10 latest', changes.size <= 10, changes.size + ' kept');
	const refspecs = gerritMod.buildFetchRefspecs(changes, remote, 'latest');
	check('buildFetchRefspecs (latest PS + meta per change)', refspecs.length === changes.size * 2, refspecs.length + ' refspecs');
	const fetchError = await gs.fetchChanges(repo, remote, refspecs);
	check('fetchChanges (targeted fetch)', fetchError === null, fetchError || 'ok');
	if (fetchError !== null) { console.log('  (network/auth failure - aborting gerrit part)'); return report(); }
	await gs.pruneLocalChanges(repo, remote, Array.from(changes.keys()));
	check('pruneLocalChanges runs', true);
	const localRefs = await gs.listLocalChangeRefs(repo, remote);
	check('local change refs exist after fetch', localRefs.length > 0, localRefs.length + ' refs');

	console.log('\n== 3. NoteDb meta parsing (badges data) ==');
	const urlBase = await gs.getChangeUrlBase(repo, remote);
	check('getChangeUrlBase derives /c/ URL', urlBase !== null, String(urlBase));
	const states = [];
	for (const change of changes.keys()) {
		const state = await gs.parseMeta(repo, remote, change, urlBase);
		if (state !== null) states.push(state);
	}
	check('parseMeta produces change states', states.length > 0, states.length + '/' + changes.size + ' parsed');
	for (const s of states.slice(0, 3)) {
		console.log('    #' + s.change + '/' + s.patchset + '  status=' + s.status + ' wip=' + s.wip + '  CR=' + s.codeReview + ' V=' + s.verified + '  events=' + s.events.length + '  head=' + s.headHash.substring(0, 8));
	}
	const withEvents = states.filter((s) => s.events.length > 0);
	check('states contain event timelines', withEvents.length > 0, withEvents.length + ' with events');

	console.log('\n== 4. Status filtering (chips) ==');
	const openStates = gerritMod.filterChangeStates(states, { new: true, merged: false, abandoned: false, wip: false });
	check('default filter keeps only open changes', openStates.every((s) => s.status === 'new' && !s.wip), openStates.length + ' open');
	const allOn = gerritMod.filterChangeStates(states, { new: true, merged: true, abandoned: true, wip: true });
	check('all-on filter keeps everything', allOn.length === states.length, allOn.length + '/' + states.length);
	const noneOn = gerritMod.filterChangeStates(states, { new: false, merged: false, abandoned: false, wip: false });
	check('all-off filter keeps nothing', noneOn.length === 0);

	console.log('\n== 5. getCommits: Show All Branches mode (gerrit refs in graph) ==');
	const gerritRefs = [];
	for (const [change, patchsets] of changes) {
		const shard = gerritMod.changeShard(change);
		gerritRefs.push('refs/remotes/' + remote + '/changes/' + shard + '/' + change + '/' + patchsets[patchsets.length - 1]);
	}
	const commitDataAll = await ds.getCommits(repo, null, null, null, 500, true, true, false, false, 'date', remotes, [], stashes, gerritRefs);
	check('getCommits (show all + gerrit refs)', commitDataAll.commits.length > 0, commitDataAll.commits.length + ' commits');
	const metaLeaks = commitDataAll.commits.filter((c) => /^Gerrit User /.test(c.author) || /^(Create change|Update patch set)/.test(c.message));
	check('NoteDb meta commits are NOT shown as graph commits', metaLeaks.length === 0, metaLeaks.length + ' leaked');
	const hashes = new Set(commitDataAll.commits.map((c) => c.hash));
	const anchoredStates = states.filter((s) => hashes.has(s.headHash));
	check('change head commits present in graph (badges will render)', anchoredStates.length > 0, anchoredStates.length + '/' + states.length + ' anchored');

	console.log('\n== 6. getCommits: specific branch selected (chips fix) ==');
	const specificBranch = branches.length > 0 ? [branches[0]] : ['develop'];
	const commitDataBranch = await ds.getCommits(repo, specificBranch, null, null, 500, true, true, false, false, 'date', remotes, [], stashes, gerritRefs);
	check('getCommits (specific branch + gerrit refs)', commitDataBranch.commits.length > 0, commitDataBranch.commits.length + ' commits on ' + specificBranch.join(','));
	const hashesBranch = new Set(commitDataBranch.commits.map((c) => c.hash));
	const anchoredBranch = states.filter((s) => hashesBranch.has(s.headHash));
	check('change commits appear even with a branch filter (fix #3)', anchoredBranch.length > 0, anchoredBranch.length + ' anchored');

	console.log('\n== 7. Change-Id helpers ==');
	const msg = await ds.gitOutput(['log', '-1', '--format=%B', 'HEAD', '--'], repo, (o) => o);
	console.log('    HEAD has Change-Id: ' + gerritMod.hasChangeId(msg));
	const cid = gerritMod.generateChangeId('tree'.repeat(4), 'parent'.repeat(4), 'A <a@b> 1', 'A <a@b> 1', 'msg');
	check('generateChangeId produces I<40 hex>', /^I[0-9a-f]{40}$/.test(cid), cid.substring(0, 12) + '...');

	console.log('\n== 8. Refs / branches listing ==');
	const refs = await ds.getRefs(repo, true, true, []);
	check('getRefs works', typeof refs === 'object', Object.keys(refs).join(', '));

	report();
}

function report() {
	console.log('\n==================================');
	console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
	console.log('==================================');
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
