# Git Branch & Tag Graph (Review Graph)

**This extension is an independent fork of the original [Git Graph](https://github.com/mhutchie/vscode-git-graph).**

View your repository's Git commit history as an interactive graph in VS Code, and perform Git operations and code review workflows directly on the graph. This fork fixes long-standing issues in recent VS Code versions and adds many features not present in the original.

*   Source: [GitHub](https://github.com/neophack/vscode-review-graph)
*   Issues: [Issues](https://github.com/neophack/vscode-review-graph/issues)
*   Marketplace: [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=aucneon.review-graph)
*   Changelog: [CHANGELOG.md](CHANGELOG.md)

---

## Contents

1.  [Getting Started](#getting-started)
2.  [Feature Overview](#feature-overview)
3.  [Git Graph View](#1-git-graph-view)
4.  [Commit Details & File Diffs](#2-commit-details--file-diffs)
5.  [Commit Comparison (Comparison View)](#3-commit-comparison-comparison-view)
6.  [Local Code Review](#4-local-code-review)
7.  [Gerrit Code Review Integration](#5-gerrit-code-review-integration)
8.  [Command Palette Commands](#6-command-palette-commands)
9.  [Context Menu Git Actions](#7-context-menu-git-actions)
10. [Common Settings](#8-common-settings)

---

## Getting Started

1.  Install the extension in VS Code (or via a VSIX).
2.  Open a workspace containing a Git repository.
3.  Click the **Git Branch & Tag Graph** icon in the Activity Bar to open the graph view.

> The extension's full namespace is `review-graph` (command IDs, setting keys, Diff URI scheme, and the per-repository config file `.vscode/review-graph.json`), so it can coexist with the original Git Graph extension without conflicts.
> The local clone directory name does not affect how the extension runs (it does not need to be named `vscode-review-graph`).

---

## Feature Overview

| Feature | Description |
| --- | --- |
| Git graph view | Interactive branch/tag/commit history graph |
| Git operations | Run checkout, merge, rebase, cherry-pick, stash and more directly on the graph |
| Commit details | View commit info, signature status and per-file additions/deletions |
| Commit comparison | Compare any two commits (or a commit against the working directory) |
| Local code review | Track reviewed files in the commit details / comparison views |
| Gerrit integration | Change badges, review timeline, one-click Submit for Review |
| Branch/tag filtering | Filter the graph by branches and tags via dropdown menus |
| Find widget | Quickly find commits by message, author or hash |
| Filter history by file | View the commit history of a single file |
| Repository settings | Configure remotes, issue links and pull request providers |
| Highly customisable | Many settings for date formats, column visibility, commit ordering, appearance and more |

---

## 1. Git Graph View

Displays the repository's full commit history as a graph, including branches, tags, remote branches, stashes and uncommitted changes.

**How to use:**

*   Click the Activity Bar icon to open the view; you can also run **View Review Graph (git log + Gerrit review)** (`review-graph.view`) from the Command Palette.
*   Use the branch dropdown at the top to select/deselect branches to display, and the tag dropdown to filter the graph by tags.
*   Click any commit to view its details in the commit details view below.
*   The view uses virtualised rendering and "load more", so even large repositories scroll smoothly; first-open load performance has also been specifically optimised.
*   Commits can be **pinned**: pinned branches/commits are retained stably and are not overwritten by refreshes.

## 2. Commit Details & File Diffs

After selecting a commit, the details view shows the commit message, author, signature status and the list of changed files.

**How to use:**

*   Click a commit row in the graph to open the details.
*   The file list supports both **tree/flat** views (`review-graph.commitDetailsView.fileView.type`); the tree view supports collapsible folders (compactFolders).
*   Click a file to open the diff between its versions before and after the commit.
*   Uncommitted changes (the UNCOMMITTED row) refresh the changed-file count in real time.
*   `review-graph.commitDetailsView.autoCenter` controls whether the details view auto-centres when scrolling.

## 3. Commit Comparison (Comparison View)

Compare all differences between any two commits (or between a commit and the working directory).

**How to use:**

1.  Right-click the first commit in the graph and choose **Select for Compare** (the commit gets marked).
2.  Right-click the second commit and choose **Compare with Selected**.
3.  The comparison view lists all files changed between the two commits; click a file to view its diff.
4.  A toggle at the top of the view enables the Gerrit controls bar, so Gerrit review actions can be used directly in the comparison view.

## 4. Local Code Review

Track which files you have already reviewed in the commit details and comparison views.

**How to use:**

*   Use the button on the right of the commit details/comparison view to **start or end** a code review.
*   A code review can target a single commit or span any two commits (uncommitted changes are not supported).
*   Use **Mark as Reviewed / Mark as Not Reviewed** in the file context menu to track review progress.
*   From the Command Palette you can:
    *   **End All Code Reviews in Workspace** — end all reviews in the workspace;
    *   **End a specific Code Review in Workspace...** — end a specific review;
    *   **Resume a specific Code Review in Workspace...** — resume a previously paused review without losing progress.

## 5. Gerrit Code Review Integration

For repositories hosted on [Gerrit](https://www.gerritcodereview.com/), the review workflow is embedded directly in the graph view.

**Features and usage:**

*   **Change badges**: commits belonging to Gerrit changes display a badge with the change number, optionally with **Code-Review (CR)** and **Verified (V)** score labels (`review-graph.gerrit.showReviewProgress`). Clicking a badge opens the change dialog showing the owner and the full event timeline.
*   **Review event timeline**: each change's review history (patchsets, votes, status transitions) is anchored to its commit; clicking an event row expands the full raw NoteDb record (`review-graph.gerrit.showMetaCommits`: `collapsed` / `expanded` / `off`).
*   **Submit for Review**: a toolbar button pushes HEAD to `refs/for/<branch>` in one click. Safety checks are performed (e.g. HEAD must not already be pushed to the remote); if HEAD lacks a Change-Id, the **Amend Change-Id** action generates and amends one (`review-graph.gerrit.showPushButton`).
*   **Change fetching**: `refs/changes/*` are fetched in the background. You can fetch only the latest patchset of each change or all patchsets, cache all open changes or the most recent N, and fetch periodically and automatically.
*   **Status filtering**: status toggles on the toolbar control which change statuses are shown — pending review (NEW), merged, abandoned, WIP.

**Gerrit settings (`review-graph.gerrit.*`, enabled by default):**

| Setting | Description |
| --- | --- |
| `review-graph.gerrit.enabled` | Enable/disable the Gerrit integration |
| `review-graph.gerrit.remote` | The remote used to fetch change refs (default `origin`) |
| `review-graph.gerrit.fetchMode` | Fetch mode: `off` / `latest` (most recent N) / `all` (all open changes) |
| `review-graph.gerrit.fetchLimit` | Number of changes kept in `latest` mode (1–10000, default 20) |
| `review-graph.gerrit.patchsets` | Fetch only the `latest` patchset of each change, or `all` |
| `review-graph.gerrit.autoFetch` | Periodically fetch Gerrit changes automatically |
| `review-graph.gerrit.showChangeRefs` | Show change badges on commits |
| `review-graph.gerrit.includeChangeCommits` | Include Gerrit change commits in the graph |
| `review-graph.gerrit.showReviewProgress` | Show CR/V score labels on badges |
| `review-graph.gerrit.showMetaCommits` | Show the review event timeline (`collapsed`/`expanded`/`off`) |
| `review-graph.gerrit.statusFilter` | Which change statuses are shown in the graph (also toggleable from the toolbar) |
| `review-graph.gerrit.showPushButton` | Show the "Submit for Review" toolbar button |

> When a fetch fails, stale markers are kept and retried automatically on the next view load, rather than continuing to use a stale cache.

## 6. Command Palette Commands

Available in the Command Palette (`Ctrl/Cmd + Shift + P`):

| Command | Effect |
| --- | --- |
| **View Review Graph** (`review-graph.view`) | Open the graph view |
| **Add Git Repository...** (`review-graph.addGitRepository`) | Add a Git repository outside the current workspace to the view |
| **Remove Git Repository...** (`review-graph.removeGitRepository`) | Remove a repository from the view |
| **Fetch from Remote(s)** (`review-graph.fetch`) | Fetch all remotes |
| **Search Commits in History...** (`review-graph.searchCommits`) | Search commits by message/author/hash |
| **Show File History in Review Graph** (`review-graph.filterByFile`) | View the commit history of a file |
| **Amend Last Commit** (`review-graph.amendLastCommit`) | Amend the last commit |
| **Reset Current Branch to Remote (Soft)** (`review-graph.resetCurrentBranchToRemote`) | Soft-reset the current branch to its remote |
| **Clear Avatar Cache** (`review-graph.clearAvatarCache`) | Clear the avatar cache |
| **End / Resume Code Review commands** | Manage code reviews in the workspace |
| **Get Version Information** (`review-graph.version`) | Show the extension version |

## 7. Context Menu Git Actions

Right-click commits, branches and tags in the graph to run actions directly:

*   **Branches**: Checkout, Rename, Create, Delete, Merge into current branch, Rebase current branch on Branch, Push, Pull, Create Archive, copy branch name and more.
*   **Commits**: Create Branch / Tag, Checkout, Cherry Pick, Revert, Drop, Merge into current branch, Reset current branch to Commit, Copy Hash / Subject / Body and more.
*   **Tags**: Add Tag, Delete Tag, Push Tag, Checkout and more.
*   **Others**: View Issue (jump to the linked issue), Create Pull Request..., Bisect, apply/pop stashes and more.

Default options of each dialog (e.g. no-ff for merge, recordOrigin for cherry-pick, the reset mode, etc.) can be pre-configured via the `review-graph.dialog.*` settings.

## 8. Common Settings

See the extension's settings panel in VS Code for the full list. Frequently used settings include:

*   `review-graph.repository.commits.initialLoad` / `loadMore` / `loadMoreAutomatically` — initial load count and automatic loading of more commits.
*   `review-graph.repository.commits.order` — commit ordering (date / author-date / topo, etc.).
*   `review-graph.repository.showRemoteBranches` / `showTags` / `showStashes` / `showUncommittedChanges` / `showUntrackedFiles` — visibility toggles for the various reference types.
*   `review-graph.repository.onLoad.showSpecificBranches` / `scrollToHead` / `showCheckedOutBranch` — behaviour when the view loads.
*   `review-graph.date.format` / `date.type` — date format.
*   `review-graph.defaultColumnVisibility` — default visibility of the columns.
*   `review-graph.enhancedAccessibility` — enhanced accessibility support.
*   `review-graph.contextMenuActionsVisibility` — control the visibility of actions in the context menus.
*   `review-graph.customPullRequestProviders` / `customEmojiShortcodeMappings` / `customBranchGlobPatterns` — custom PR providers, emoji mappings and custom branch globs.
*   `review-graph.repository.sign.commits` / `sign.tags` — commit/tag signing.
*   `review-graph.repository.fetchAndPrune` / `fetchAndPruneTags` — prune behaviour when fetching.

---

## Why a Fork?

The original Git Graph is an excellent extension, but some issues have remained unfixed for a long time. This fork aims to:

*   Fix the context menu disappearing in VS Code 1.97+.
*   Optimise activation events and startup performance.
*   Keep up with the latest VS Code releases.
*   Add new features such as tag filtering, a find widget, double line break support in commit messages, and Gerrit integration.

## Acknowledgements

Thanks to the original author [mhutchie](https://github.com/mhutchie) for creating this great extension.

Some icons used in this extension are from:

- [GitHub Octicons](https://octicons.github.com/) ([License](https://github.com/primer/octicons/blob/master/LICENSE))
- [Icons8](https://icons8.com/icon/pack/free-icons/ios11) ([License](https://icons8.com/license))
