/* Gerrit View (badges, meta rows, review/hooks dialogs and controls) */

function getGerritBadgeHtml(view: GitGraphView, state: GG.GerritChangeState) {

	const score = formatGerritScore;

	let progress = '';

	if (view.config.gerrit.showReviewProgress) {

		progress = '<span class="gg-label cr' + state.codeReview + '">CR' + score(state.codeReview) + '</span>';

		if (state.verified !== 0) progress += '<span class="gg-label v' + state.verified + '">V' + score(state.verified) + '</span>';

	}

	let status = '';

	if (state.status === 'merged') status = '<span class="gg-status merged">\u2713 merged</span>';

	else if (state.status === 'abandoned') status = '<span class="gg-status abandoned">\u2205 abandoned</span>';

	else if (state.wip) status = '<span class="gg-status wip">WIP</span>';

	const expanded = isGerritChangeExpanded(view, state.change);

	const meta = view.config.gerrit.showMetaCommits !== 'off'

		? '<span class="gg-meta-chip' + (expanded ? ' expanded' : '') + '" data-change="' + state.change + '" title="' + strings.gerritMetaChipTitle + '">' + SVG_ICONS.chevronDown + '</span>'

		: '';

	return '<span class="gitRef gerrit" data-name="#' + state.change + '/' + state.patchset + '" data-change="' + state.change + '" data-ps="' + state.patchset + '" data-hash="' + escapeHtml(state.headHash) + '" title="Gerrit Change #' + state.change + (state.url !== null ? ' - ' + escapeHtml(state.url) : '') + '">' + SVG_ICONS.review + '<span class="gitRefName" data-fullref="#' + state.change + '/' + state.patchset + '">#' + state.change + '/' + state.patchset + '</span>' + progress + status + '</span>' + meta;

}


function isGerritChangeExpanded(view: GitGraphView, change: number) {

	const expanded = view.gerritExpandedChanges[view.currentRepo];

	if (expanded !== undefined && expanded[change] !== undefined) return expanded[change];

	return view.config.gerrit.showMetaCommits === 'expanded';

}


function toggleGerritChangeExpanded(view: GitGraphView, change: number) {

	const newValue = !isGerritChangeExpanded(view, change);

	if (view.gerritExpandedChanges[view.currentRepo] === undefined) view.gerritExpandedChanges[view.currentRepo] = {};

	view.gerritExpandedChanges[view.currentRepo][change] = newValue;

	return newValue;

}


function getGerritMetaRowsHtml(_view: GitGraphView, state: GG.GerritChangeState, hash: string, colVisibility: { date: boolean; author: boolean; commit: boolean }) {

	const events = state.events; // display newest → oldest, matching the review dialog

	let html = '';

	for (const event of events) {

		const text = formatGerritEventText(event);

		html += '<tr class="gg-meta-row" data-change="' + state.change + '" data-hash="' + escapeHtml(hash) + '" title="' + escapeHtml(event.raw) + '"><td></td><td>' +

			'<div class="gg-meta-event">' +

			'<span class="gg-meta-event-icon">' + (GERRIT_EVENT_ICONS[event.type] || '•') + '</span>' +

			'<span class="gg-meta-event-text">' + text + '</span>' +

			(event.reviewer !== undefined ? '<span class="gg-meta-event-reviewer">' + escapeHtml(event.reviewer) + '</span>' : '') +

			'<span class="gg-meta-event-date">' + formatShortDate(event.timestamp).formatted + '</span>' +

			'</div></td>' +

			(colVisibility.date ? '<td></td>' : '') +

			(colVisibility.author ? '<td></td>' : '') +

			(colVisibility.commit ? '<td></td>' : '') +

			'</tr>';

	}

	return html;

}


function showGerritReviewInfo(view: GitGraphView, hash: string) {

	const state = view.gerritStates[hash];

	if (state === undefined) {

		dialog.showError(strings.gerritReviewDialogTitle, strings.gerritNoReviewInfo, strings.dialogClose, null);

		return;

	}

	showGerritDialog(view, state);

}


function showGerritDialog(_view: GitGraphView, state: GG.GerritChangeState) {

	const score = formatGerritScore;

	const statusText = state.status === 'merged' ? strings.gerritStatusMerged : state.status === 'abandoned' ? strings.gerritStatusAbandoned : (state.wip ? strings.gerritStatusWip : strings.gerritStatusOpen);

	const icons = GERRIT_EVENT_ICONS;

	// state.events is newest → oldest: the change author is the actor of the oldest "Create change" event

	const createdEvent = state.events.slice().reverse().find((event) => event.type === 'created');

	const owner = createdEvent !== undefined && createdEvent.reviewer !== undefined ? createdEvent.reviewer : null;

	let timeline = '', hasDetails = false;

	for (const event of state.events) {

		// Older webview states (persisted before rawFull existed) may lack the full record

		const hasFull = typeof event.rawFull === 'string' && event.rawFull.trim() !== '';

		if (hasFull) hasDetails = true;

		const detail = hasFull ? '<pre class="gg-event-detail">' + escapeHtml(event.rawFull) + '</pre>' : '';

		timeline += '<div class="gg-event' + (hasFull ? ' gg-event-expandable' : '') + '"' + (hasFull ? ' title="' + strings.gerritToggleNoteDb + '"' : '') + '>' +

			'<div class="gg-event-row">' +

			(detail !== '' ? '<span class="gg-event-toggle">' + SVG_ICONS.chevronDown + '</span>' : '') +

			'<span class="gg-event-icon">' + (icons[event.type] || '\u2022') + '</span>' +

			'<span class="gg-event-text">' + formatGerritEventText(event) + '</span>' +

			(event.reviewer !== undefined ? '<span class="gg-event-reviewer">' + escapeHtml(event.reviewer) + '</span>' : '') +

			'<span class="gg-event-date">' + formatShortDate(event.timestamp).formatted + '</span>' +

			'</div>' +

			detail +

			'</div>';

	}

	dialog.showMessage(

		'<b>Gerrit Change #' + state.change + '</b> &middot; Patch Set ' + state.patchset + ' &middot; <b>' + statusText + '</b>' +

		(owner !== null ? ' &middot; Owner: ' + escapeHtml(owner) : '') +

		(state.url !== null ? ' &middot; <a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(state.url) + '" tabindex="-1">Open in Gerrit</a>' : '') +

		'<br><b>Code-Review:</b> ' + score(state.codeReview) + ' &nbsp; <b>Verified:</b> ' + score(state.verified) +

		'<div class="gg-timeline">' + timeline + '</div>' +

		(hasDetails ? '<span class="gg-hint">' + strings.gerritEventsHint + '</span>' : '')

	);

	// Show an ✕ close icon in the top-right corner instead of the bottom Close button

	dialog.useCloseIcon();

	// Expand/collapse the detailed NoteDb record of an event when its row is clicked

	dialog.onClick('.gg-event-expandable', (elem) => elem.classList.toggle('expanded'));

}


function gerritAmendChangeIdAction(view: GitGraphView) {

	dialog.showForm('Amend a Gerrit <b>Change-Id</b> onto <b><i>HEAD</i></b>?<br><span class="gg-hint">Only possible when HEAD has no Change-Id yet and hasn\'t been pushed to any remote. The commit message of HEAD will gain a "Change-Id: I..." footer - nothing else is changed.</span>', [], 'Yes, amend', () => {

		runAction({ command: 'gerritAmendChangeId', repo: view.currentRepo }, 'Amending Change-Id');

	}, null);

}


function gerritSubmitReviewAction(view: GitGraphView) {

	if (view.gitBranchHead === null) {

		dialog.showError('Submit for Review', 'Unable to determine the current branch. Check out a branch first.', 'Close', null);

		return;

	}

	const branch = view.gitBranchHead;

	dialog.showForm('Are you sure you want to push <b><i>HEAD</i></b> to <b>refs/for/' + escapeHtml(branch) + '</b> for Gerrit review?<br><span class="gg-hint">If HEAD has no Change-Id, you will be asked to amend one first.</span>', [], 'Yes, submit', () => {

		runAction({ command: 'gerritSubmitReview', repo: view.currentRepo, branch: branch, hash: null }, 'Submitting for Review');

	}, null);

}


function gerritClearRefsAction(view: GitGraphView) {

	dialog.showForm('Are you sure you want to delete all locally downloaded Gerrit change refs (<b>refs/remotes/' + escapeHtml(view.config.gerrit.remote) + '/changes/*</b>)?<br><span class="gg-hint">The downloaded change commits remain in the object database until Git garbage collects them. Gerrit change fetching will be turned off, so the deleted refs are not re-downloaded on the next refresh.</span>', [], 'Yes, delete', () => {

		// Deselect every status filter chip: with fetching turned off there is no Gerrit data to filter, and selecting a chip again re-enables fetching
		view.gerritStatusFilter = { new: false, merged: false, abandoned: false, wip: false };

		for (const elem of Array.from(document.querySelectorAll('#gerritFilterControl .gerritFilterChip'))) {

			(<HTMLElement>elem).classList.remove('active');

		}

		view.saveRepoStateValue(view.currentRepo, 'gerritStatusFilter', view.gerritStatusFilter);

		runAction({ command: 'gerritClearRefs', repo: view.currentRepo }, 'Clearing Gerrit Refs');

	}, null);

}


function gerritHooksAction(view: GitGraphView) {

	runAction({ command: 'gerritGetHookStatus', repo: view.currentRepo }, 'Loading Hook Status');

}


function reloadHookStatus(view: GitGraphView) {

	runAction({ command: 'gerritGetHookStatus', repo: view.currentRepo }, 'Loading Hook Status');

}


function showHooksDialog(view: GitGraphView, hooks: ReadonlyArray<GG.GerritHookStatus>) {

	const rows = hooks.map((hook) => {

		const check = hook.installed ? '<span style="color:var(--gitgis-success, #4bb44a);">&#10003;</span>' : '<span style="color:var(--gitgis-error, #bb4b4b);">&#10007;</span>';

		const action = !hook.installed && hook.installable

			? ' &mdash; <span class="gg-hook-install" data-hook="' + escapeHtml(hook.name) + '" style="cursor:pointer;text-decoration:underline">Get from Gerrit</span>'

			: '';

		return '<div style="padding:2px 0">' + check + ' <b>' + escapeHtml(hook.name) + '</b>' + action + '</div>';

	}).join('');

	dialog.showForm('<b>HOOKS</b><br><span class="gg-hint">The Git hooks of this repository (in &lt;git-dir&gt;/hooks/).</span><div style="margin-top:6px">' + rows + '</div>', [], 'Close', () => {}, null);

	dialog.useCloseIcon();

	// Install a missing Gerrit-served hook when its "Get from Gerrit" link is clicked

	dialog.onClick('.gg-hook-install', (elem) => {

		const hook = elem.dataset.hook!;

		dialog.showConfirmation('Download and install the <b><i>' + escapeHtml(hook) + '</i></b> hook from the Gerrit server into this repository?', 'Yes, install', () => {

			runAction({ command: 'gerritInstallHook', repo: view.currentRepo, hook: hook }, 'Installing ' + hook + ' Hook');

		}, null);

	});

}


function initGerritControls(view: GitGraphView) {

	const controlsRow = view.gerritControlsElem;

	if (controlsRow === null || !view.config.gerrit.enabled || !view.config.gerrit.showControlsBar) {

		if (controlsRow !== null) controlsRow.style.display = 'none';

		alterClass(view.controlsElem, 'withGerritRow', false);

		return;

	}

	alterClass(view.controlsElem, 'withGerritRow', true);



	// Amend Change-Id button (icon + label)

	const amendBtn = document.getElementById('gerritAmendBtn');

	if (amendBtn !== null) {

		amendBtn.innerHTML = SVG_ICONS.pencil + '<span>' + strings.gerritAmendLabel + '</span>';

		amendBtn.title = strings.gerritAmendTitle;

		amendBtn.addEventListener('click', () => gerritAmendChangeIdAction(view));

	}



	// Submit for Review button (icon + label)

	const submitBtn = document.getElementById('gerritSubmitBtn');

	if (submitBtn !== null) {

		if (view.config.gerrit.showPushButton) {

			submitBtn.innerHTML = SVG_ICONS.review + '<span>' + strings.gerritSubmitLabel + '</span>';

			submitBtn.title = strings.gerritSubmitTitle;

			submitBtn.addEventListener('click', () => gerritSubmitReviewAction(view));

		} else {

			submitBtn.style.display = 'none';

		}

	}



	// Clear downloaded change refs button (icon + label)

	const clearRefsBtn = document.getElementById('gerritClearRefsBtn');

	if (clearRefsBtn !== null) {

		clearRefsBtn.innerHTML = SVG_ICONS.trash + '<span>' + strings.gerritClearLabel + '</span>';

		clearRefsBtn.title = formatStr(strings.gerritClearRefsTitle, view.config.gerrit.remote);

		clearRefsBtn.addEventListener('click', () => gerritClearRefsAction(view));

	}



	// Git hooks status button (icon + label)

	const hooksBtn = document.getElementById('gerritHooksBtn');

	if (hooksBtn !== null) {

		hooksBtn.innerHTML = SVG_ICONS.download + '<span>' + strings.gerritHooksLabel + '</span>';

		hooksBtn.title = strings.gerritHooksTitle;

		hooksBtn.addEventListener('click', () => gerritHooksAction(view));

	}

}



/**
 * Render the status filter chips for the current repository and resolve the active filter. Called
 * from loadRepo (the current repository is not yet known when the static controls are initialised,
 * and the initial loadCommits request must already carry the restored filter).
 */
function initGerritFilterChips(view: GitGraphView) {

	const filterControl = document.getElementById('gerritFilterControl');

	if (filterControl === null || !view.config.gerrit.enabled || !view.config.gerrit.showControlsBar) return;

	// The selected chips persist in the repository's state, so loading a repository (initially, on a
	// repo switch, or after the webview was reloaded) restores them; NULL => the repository has no
	// persisted selection, so the global config's default filter applies
	const repo = view.gitRepos[view.currentRepo];

	view.gerritStatusFilter = repo !== undefined && repo.gerritStatusFilter !== null && repo.gerritStatusFilter !== undefined
		? repo.gerritStatusFilter
		: Object.assign({}, view.config.gerrit.statusFilter);

	const chips: { status: keyof GG.GerritStatusFilter, label: string }[] = [

		{ status: 'new', label: strings.gerritChipOpen }, { status: 'merged', label: strings.gerritChipMerged }, { status: 'abandoned', label: strings.gerritChipAbandoned }, { status: 'wip', label: strings.gerritChipWip }

	];

	filterControl.innerHTML = chips.map((chip) => '<span class="gerritFilterChip" data-status="' + chip.status + '" title="' + formatStr(strings.gerritFilterChipTitle, chip.label) + '">' + chip.label + '</span>').join('');

	for (const elem of Array.from(filterControl.querySelectorAll('.gerritFilterChip'))) {

		const chip = <HTMLElement>elem;

		const status = <keyof GG.GerritStatusFilter>chip.dataset.status;

		chip.classList.toggle('active', view.gerritStatusFilter![status]);

		chip.addEventListener('click', () => {

			view.gerritStatusFilter![status] = !view.gerritStatusFilter![status];

			chip.classList.toggle('active', view.gerritStatusFilter![status]);

			// Persist the selection with the repository's state, so it survives the view being
			// closed and reopened
			view.saveRepoStateValue(view.currentRepo, 'gerritStatusFilter', view.gerritStatusFilter);

			if (view.config.gerrit.fetchMode === 'off') {

				// Gerrit change fetching is turned off (after "Clear Refs"): selecting a chip re-enables it, and the configuration change reloads the view and re-downloads the change refs
				runAction({ command: 'gerritEnableFetching', repo: view.currentRepo }, 'Fetching Gerrit Changes');

				return;

			}

			// The status filter is applied locally by the Webview (the extension serves ALL cached
			// Gerrit states): re-render the badges immediately, without reloading the commits.
			view.renderGerritFilterChange();

			// Only the "Open", "Abandoned" and "WIP" chips can change which change refs are injected
			// into the commit graph (merged changes are never injected), and only when change commits
			// are included: reload in the background for those, so the floating patchset chains are
			// added/removed. Debounce so rapidly toggling multiple chips only triggers a single load.
			if (view.config.gerrit.includeChangeCommits && status !== 'merged') {

				if (view.gerritFilterRefreshTimer !== null) window.clearTimeout(view.gerritFilterRefreshTimer);

				view.gerritFilterRefreshTimer = window.setTimeout(() => {

					view.gerritFilterRefreshTimer = null;

					view.requestLoadRepoInfoAndCommits(false, true);

				}, 120);

			}

		});

	}

}

