// Minimal 'vscode' module shim so the compiled out/* modules can run under plain node
function makeConfig() {
	return { get: (_k, d) => d, has: () => false, inspect: () => undefined, update: async () => undefined };
}
module.exports = {
	Uri: { file: (f) => ({ fsPath: f, toString: () => f }) },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8 },
	window: { showInformationMessage: async () => undefined, showErrorMessage: async () => undefined, showWarningMessage: async () => undefined },
	workspace: { workspaceFolders: [], getConfiguration: () => makeConfig(), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
	commands: { registerCommand: () => ({ dispose: () => undefined }), executeCommand: async () => undefined },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 }
};
