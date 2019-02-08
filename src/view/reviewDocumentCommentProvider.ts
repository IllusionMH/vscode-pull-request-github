/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { Comment, convertToVSCodeComment, getCommentingRanges, workspaceLocalCommentsToCommentThreads } from '../common/comment';
import { getAbsolutePosition, getLastDiffLine, mapCommentsToHead, mapHeadLineToDiffHunkPosition, mapOldPositionToNew } from '../common/diffPositionMapping';
import { fromPRUri, fromReviewUri, ReviewUriParams } from '../common/uri';
import { formatError, groupBy } from '../common/utils';
import { Repository } from '../git/api';
import { onDidSubmitReview, PullRequestManager } from '../github/pullRequestManager';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { providePRDocumentComments } from './treeNodes/pullRequestNode';

export class ReviewDocumentCommentProvider implements vscode.DocumentCommentProvider {
	private _localToDispose: vscode.Disposable[] = [];

	private _onDidChangeDocumentCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	public onDidChangeCommentThreads = this._onDidChangeDocumentCommentThreads.event;

	private _onDidChangeWorkspaceCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	public onDidChangeWorkspaceCommentThreads = this._onDidChangeWorkspaceCommentThreads.event;

	private _onDidChangeComments = new vscode.EventEmitter<Comment[]>();
	public onDidChangeComments = this._onDidChangeComments.event;

	public startDraftLabel = 'Start Review';
	public deleteDraftLabel = 'Delete Review';
	public finishDraftLabel = 'Submit Review';

	constructor(
		private _prManager: PullRequestManager,
		private _repository: Repository,
		private _localFileChanges: GitFileChangeNode[],
		private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		private _comments: Comment[]) {
		const supportsGraphQL = _prManager.activePullRequest!.githubRepository.supportsGraphQl;
		if (supportsGraphQL) {
			this._localToDispose.push(onDidSubmitReview(submittedComments => {
				this.updateCommentPendingState(submittedComments);
			}));
		}

		this.startDraft = supportsGraphQL ? this.startDraft.bind(this) : undefined;
		this.deleteDraft = supportsGraphQL ? this.deleteDraft.bind(this) : undefined;
		this.finishDraft = supportsGraphQL ? this.finishDraft.bind(this) : undefined;
	}

	async provideDocumentComments(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CommentInfo | undefined> {
		if (document.uri.scheme === 'pr') {
			const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
			const prNumber = this._prManager.activePullRequest && this._prManager.activePullRequest.prNumber;
			return providePRDocumentComments(document, prNumber!, this._localFileChanges, inDraftMode);
		}

		let query: ReviewUriParams | undefined;

		try {
			query = fromReviewUri(document.uri);
		} catch (e) { }

		if (query) {
			return this.provideCommentInfoForReviewUri(document, query);
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!currentWorkspace) {
			return;
		}

		if (document.uri.scheme === currentWorkspace.uri.scheme) {
			return this.provideCommentInfoForFileUri(document, currentWorkspace);
		}

		return;
	}

	private async provideCommentInfoForReviewUri(document: vscode.TextDocument, query: ReviewUriParams): Promise<vscode.CommentInfo | undefined> {
		const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._localFileChanges, document.uri);

		if (matchedFile) {
			const matchingComments = matchedFile.comments;
			const isBase = query.base;
			matchingComments.forEach(comment => { comment.absolutePosition = getAbsolutePosition(comment, matchedFile!.diffHunks, isBase); });

			return {
				threads: workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchingComments.filter(comment => comment.absolutePosition !== undefined && comment.absolutePosition > 0), vscode.CommentThreadCollapsibleState.Expanded),
				commentingRanges: getCommentingRanges(matchedFile.diffHunks, isBase),
				inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest!)
			};
		}

		const matchedObsoleteFile = this.findMatchedFileChangeForReviewDiffView(this._obsoleteFileChanges, document.uri);
		let comments: Comment[] = [];
		if (!matchedObsoleteFile) {
			// The file may be a change from a specific commit, check the comments themselves to see if they match it, as obsolete file changs
			// may not contain it
			try {
				comments = this._comments.filter(comment => comment.path === query!.path && `${comment.originalCommitId}^` === query.commit);
			} catch (_) {
				// Do nothing
			}

			if (!comments.length) {
				return;
			}
		} else {
			comments = matchedObsoleteFile.comments;
		}

		let sections = groupBy(comments, comment => String(comment.originalPosition)); // comment.position is null in this case.
		let ret: vscode.CommentThread[] = [];
		for (let i in sections) {
			let commentGroup = sections[i];
			const firstComment = commentGroup[0];
			let diffLine = getLastDiffLine(firstComment.diffHunk);
			if (!diffLine) {
				continue;
			}

			const lineNumber = query.base
				? diffLine.oldLineNumber
				: diffLine.oldLineNumber > 0
					? -1
					: diffLine.newLineNumber;

			if (lineNumber < 0) {
				continue;
			}

			const range = new vscode.Range(new vscode.Position(lineNumber, 0), new vscode.Position(lineNumber, 0));

			ret.push({
				threadId: String(firstComment.id),
				resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, firstComment.path!)),
				range,
				comments: commentGroup.map(comment => convertToVSCodeComment(comment)),
				collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
			});

			return {
				threads: ret,
				inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest!)
			};
		}
	}

	private async provideCommentInfoForFileUri(document: vscode.TextDocument, currentWorkspace: vscode.WorkspaceFolder) {
		// local file, we only provide active comments
		// TODO. for comments in deleted ranges, they should show on top of the first line.
		const fileName = nodePath.relative(currentWorkspace!.uri.fsPath, document.uri.fsPath);
		const matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => fileChange.fileName === fileName);
		let matchedFile: GitFileChangeNode;
		let matchingComments: Comment[] = [];
		let ranges = [];

		const headCommitSha = this._prManager.activePullRequest!.head.sha;
		if (matchedFiles && matchedFiles.length) {
			matchedFile = matchedFiles[0];

			let contentDiff: string;
			if (document.isDirty) {
				const documentText = document.getText();
				const details = await this._repository.getObjectDetails(headCommitSha, matchedFile.fileName);
				const idAtLastCommit = details.object;
				const idOfCurrentText = await this._repository.hashObject(documentText);

				// git diff <blobid> <blobid>
				contentDiff = await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
			} else {
				// git diff sha -- fileName
				contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);
			}

			matchingComments = this._comments.filter(comment => comment.path! === fileName);
			matchingComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchingComments);

			let diffHunks = matchedFile.diffHunks;

			for (let i = 0; i < diffHunks.length; i++) {
				let diffHunk = diffHunks[i];
				let start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber);
				let end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1);
				if (start > 0 && end > 0) {
					ranges.push(new vscode.Range(start - 1, 0, end - 1, 0));
				}
			}
		}

		return {
			threads: workspaceLocalCommentsToCommentThreads(this._repository, matchedFile!, matchingComments, vscode.CommentThreadCollapsibleState.Collapsed),
			commentingRanges: ranges,
			inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest!)
		};
	}

	private findMatchedFileChangeForReviewDiffView(fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], uri: vscode.Uri): GitFileChangeNode | undefined {
		let query = fromReviewUri(uri);
		let matchedFiles = fileChanges.filter(fileChange => {
			if (fileChange instanceof RemoteFileChangeNode) {
				return false;
			}

			if (fileChange.fileName !== query.path) {
				return false;
			}

			try {
				let q = JSON.parse(fileChange.filePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) { }

			try {
				let q = JSON.parse(fileChange.parentFilePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) { }

			return false;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0] as GitFileChangeNode;
		}
	}

	private findMatchedFileByUri(document: vscode.TextDocument): GitFileChangeNode | undefined {
		const uri = document.uri;

		let fileName: string;
		let isOutdated = false;
		if (uri.scheme === 'review') {
			const query = fromReviewUri(uri);
			isOutdated = query.isOutdated;
			fileName = query.path;
		}

		if (uri.scheme === 'file') {
			fileName = uri.path;
		}

		if (uri.scheme === 'pr') {
			fileName = fromPRUri(uri)!.fileName;
		}

		const fileChangesToSearch = isOutdated ? this._obsoleteFileChanges : this._localFileChanges;
		const matchedFiles = gitFileChangeNodeFilter(fileChangesToSearch).filter(fileChange => {
			if (uri.scheme === 'review' || uri.scheme === 'pr') {
				return fileChange.fileName === fileName;
			} else {
				let absoluteFilePath = vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, fileChange.fileName));
				let targetFilePath = vscode.Uri.file(fileName);
				return absoluteFilePath.fsPath === targetFilePath.fsPath;
			}
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0];
		}
	}

	async replyToCommentThread(document: vscode.TextDocument, range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}
			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const commentFromThread = this._comments.find(c => c.id.toString() === thread.threadId);
			if (!commentFromThread) {
				throw new Error('Unable to find thread to respond to.');
			}

			const comment = await this._prManager.createCommentReply(this._prManager.activePullRequest, text, commentFromThread);
			thread.comments.push(convertToVSCodeComment(comment!));

			matchedFile.comments.push(comment!);
			this._comments.push(comment!);
			this._onDidChangeComments.fire(this._comments);

			const workspaceThread = Object.assign({}, thread, { resource: vscode.Uri.file(thread.resource.fsPath) });
			this._onDidChangeWorkspaceCommentThreads.fire({
				added: [],
				changed: [workspaceThread],
				removed: []
			});

			return thread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		try {
			const uri = document.uri;
			const matchedFile = this.findMatchedFileByUri(document);
			const query = uri.query === '' ? undefined : fromReviewUri(uri);
			const isBase = query && query.base;

			if (!matchedFile) {
				throw new Error(`Cannot find document ${uri.toString()}`);
			}

			if (!this._prManager.activePullRequest) {
				throw new Error('No active pull request');
			}
			const headCommitSha = this._prManager.activePullRequest.head.sha;

			// git diff sha -- fileName
			const contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);
			const position = mapHeadLineToDiffHunkPosition(matchedFile.diffHunks, contentDiff, range.start.line + 1, isBase);

			if (position < 0) {
				throw new Error('Comment position cannot be negative');
			}

			// there is no thread Id, which means it's a new thread
			const rawComment = await this._prManager.createComment(this._prManager.activePullRequest!, text, matchedFile.fileName, position);
			const comment = convertToVSCodeComment(rawComment!);

			let commentThread: vscode.CommentThread = {
				threadId: comment.commentId.toString(),
				resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, rawComment!.path!)),
				range: range,
				comments: [comment]
			};

			matchedFile.comments.push(rawComment!);
			this._comments.push(rawComment!);
			this._onDidChangeComments.fire(this._comments);

			const workspaceThread = Object.assign({}, commentThread, { resource: vscode.Uri.file(commentThread.resource.fsPath) });
			this._onDidChangeWorkspaceCommentThreads.fire({
				added: [workspaceThread],
				changed: [],
				removed: []
			});

			return commentThread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async editComment(document: vscode.TextDocument, comment: vscode.Comment, text: string): Promise<void> {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const rawComment = matchedFile.comments.find(c => c.id === Number(comment.commentId));
			if (!rawComment) {
				throw new Error('Unable to find comment');
			}

			const editedComment = await this._prManager.editReviewComment(this._prManager.activePullRequest, rawComment, text);

			// Update the cached comments of the file
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				matchedFile.comments.splice(matchingCommentIndex, 1, editedComment);
				const changedThreads = workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchedFile.comments.filter(c => c.position === editedComment.position), vscode.CommentThreadCollapsibleState.Expanded);

				this._onDidChangeWorkspaceCommentThreads.fire({
					added: [],
					changed: changedThreads,
					removed: []
				});
			}

			// Also update this._comments
			const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
			if (indexInAllComments > -1) {
				this._comments.splice(indexInAllComments, 1, editedComment);
				this._onDidChangeComments.fire(this._comments);
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteComment(document: vscode.TextDocument, comment: vscode.Comment): Promise<void> {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			await this._prManager.deleteReviewComment(this._prManager.activePullRequest, comment.commentId);
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				const [deletedComment] = matchedFile.comments.splice(matchingCommentIndex, 1);
				const updatedThreadComments = matchedFile.comments.filter(c => c.position === deletedComment.position);

				// If the deleted comment was the last in its thread, remove the thread
				if (updatedThreadComments.length) {
					const changedThreads = workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, updatedThreadComments, vscode.CommentThreadCollapsibleState.Expanded);
					this._onDidChangeWorkspaceCommentThreads.fire({
						added: [],
						changed: changedThreads,
						removed: []
					});
				} else {
					this._onDidChangeWorkspaceCommentThreads.fire({
						added: [],
						changed: [],
						removed: [{
							threadId: deletedComment.id.toString(),
							resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, deletedComment.path!)),
							comments: [],
							range: null
						}]
					});
				}

				this._onDidChangeDocumentCommentThreads.fire({
					added: [],
					changed: [],
					removed: [],
					inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest)
				});
			}

			const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
			if (indexInAllComments > -1) {
				this._comments.splice(indexInAllComments, 1);
				this._onDidChangeComments.fire(this._comments);
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async startDraft(_document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<void> {
		if (!this._prManager.activePullRequest) {
			throw new Error('Unable to find active pull request');
		}

		await this._prManager.startReview(this._prManager.activePullRequest);
		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed: [],
			removed: [],
			inDraftMode: true
		});
	}

	async deleteDraft(_document: vscode.TextDocument, _token: vscode.CancellationToken) {
		if (!this._prManager.activePullRequest) {
			throw new Error('Unable to find active pull request');
		}

		const { deletedReviewId, deletedReviewComments } = await this._prManager.deleteReview(this._prManager.activePullRequest);

		const removed: vscode.CommentThread[] = [];
		const changed: vscode.CommentThread[] = [];

		const oldCommentThreads = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		oldCommentThreads.forEach(thread => {
			thread.comments = thread.comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
			if (!thread.comments.length) {
				removed.push(thread);
			} else {
				changed.push(thread);
			}
		});

		const commentsByFile = groupBy(deletedReviewComments, comment => comment.path!);
		for (let filePath in commentsByFile) {
			const matchedFile = this._localFileChanges.find(fileChange => fileChange.fileName === filePath);
			if (matchedFile) {
				matchedFile.comments = matchedFile.comments.filter(comment => comment.pullRequestReviewId !== deletedReviewId);
			}
		}

		this._comments = this._comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id === comment.id));
		this._onDidChangeComments.fire(this._comments);

		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});

		this._onDidChangeWorkspaceCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});
	}

	async finishDraft(document: vscode.TextDocument, _token: vscode.CancellationToken) {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			await this._prManager.submitReview(this._prManager.activePullRequest);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async updateComments(comments: Comment[]): Promise<void> {
		let added: vscode.CommentThread[] = [];
		let removed: vscode.CommentThread[] = [];
		let changed: vscode.CommentThread[] = [];

		const oldCommentThreads = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		const newCommentThreads = this.allCommentsToCommentThreads(comments, vscode.CommentThreadCollapsibleState.Expanded);

		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (matchingThreads.length === 0) {
				removed.push(thread);
			}
		});

		function commentsEditedInThread(oldComments: vscode.Comment[], newComments: vscode.Comment[]): boolean {
			return oldComments.some(oldComment => {
				const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
				if (matchingComment.length !== 1) {
					return true;
				}

				if (matchingComment[0].body.value !== oldComment.body.value) {
					return true;
				}

				return false;
			});
		}

		newCommentThreads.forEach(thread => {
			const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

			// No old threads match this thread, it is new
			if (matchingCommentThread.length === 0) {
				added.push(thread);
				if (thread.resource.scheme === 'file') {
					thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
				}
			}

			// Check if comment has been updated
			matchingCommentThread.forEach(match => {
				if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments, thread.comments)) {
					changed.push(thread);
				}
			});
		});

		if (added.length || removed.length || changed.length) {
			this._onDidChangeDocumentCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed,
				inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest!)
			});

			this._onDidChangeWorkspaceCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed
			});

			this._comments = comments;
			this._localFileChanges.forEach(change => {
				if (change instanceof GitFileChangeNode) {
					change.comments = this._comments.filter(comment => change.fileName === comment.path && comment.position !== null);
				}
			});
			this._onDidChangeComments.fire(this._comments);
		}

	}

	private allCommentsToCommentThreads(comments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
		if (!comments || !comments.length) {
			return [];
		}

		let fileCommentGroups = groupBy(comments, comment => comment.path!);
		let ret: vscode.CommentThread[] = [];

		for (let file in fileCommentGroups) {
			let fileComments: Comment[] = fileCommentGroups[file];

			let matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => fileChange.fileName === file);

			if (matchedFiles && matchedFiles.length) {
				ret = [...ret, ...workspaceLocalCommentsToCommentThreads(this._repository, matchedFiles[0], fileComments, collapsibleState)];
			}
		}
		return ret;
	}

	private updateCommentPendingState(submittedComments: Comment[]) {
		this._comments.forEach(comment => {
			comment.isDraft = false;
		});

		this._onDidChangeComments.fire(this._comments);

		const commentsByFile = groupBy(submittedComments, comment => comment.path || '');
		for (let filePath in commentsByFile) {
			const matchedFile = this._localFileChanges.find(fileChange => fileChange.fileName === filePath);
			if (matchedFile) {
				matchedFile.comments.forEach(comment => {
					comment.isDraft = false;
				});
			}
		}

		const open = groupBy(vscode.workspace.textDocuments,
			doc => doc.uri.scheme === 'file'
				? vscode.workspace.asRelativePath(doc.uri.path)
				: doc.uri.path[0] === '/' ? doc.uri.path.slice(1) : doc.uri.path);
		const changed = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		let i = changed.length; while (i-- > 0) {
			const thread = changed[i];
			const docsForThread = open[vscode.workspace.asRelativePath(thread.resource)];
			if (!docsForThread) { continue; }
			changed.push(...docsForThread.map(doc => ({ ...thread, resource: doc.uri })));
		}
		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed,
			removed: [],
			inDraftMode: false
		});
	}
}