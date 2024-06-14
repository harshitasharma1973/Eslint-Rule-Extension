import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import hash from 'object-hash';
import { ESLint, Linter } from "eslint";
// ESLint configuration embedded directly
type CodeBlocks = Record<string, number[]>;
const eslintConfig: Linter.Config = {
	root: true,
	parserOptions: {
		ecmaVersion: 2020,
		sourceType: 'module',
	},
	env: {
		browser: true,
		node: true,
		es6: true,
	},
	plugins: ['custom-rules'],
	rules: {
		'custom-rules/no-duplicate-code': 'error',
		camelcase: ["error", { properties: "always" }],
		complexity: ["error", 5],
		"max-depth": ["error", 2],
		"max-params": ["error", 4],
		"max-statements": ["error", 15],
		"no-var": "error",
		"no-console": "error",
		eqeqeq: "error",
		"no-unused-vars": "error",
		"padding-line-between-statements": [
			"warn",
			{ blankLine: "always", prev: "*", next: "function" },
			{ blankLine: "always", prev: "function", next: "*" },
		],
		"init-declarations": ["error", "always"],
		"default-case": "error",
		"default-case-last": "error",
		"max-len": [
			"error",
			{
				code: 120,
				ignoreUrls: true,
				ignoreTemplateLiterals: true,
				ignoreStrings: false,
				ignoreComments: true,
				ignoreRegExpLiterals: true,
			},
		],
		"no-debugger": process.env.NODE_ENV === "production" ? "error" : "off",
		quotes: ["warn", "single"],
	},
};

// Function to create ESLint instance
function createESLintInstance() {
	const eslint = new ESLint({
		// ignore: false,
		overrideConfig: eslintConfig,
		ignorePath: path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.eslintignore'),
		useEslintrc: true,
		plugins: {
			'custom-rules': {
				rules: {
					'no-duplicate-code': {
						meta: {
							type: 'suggestion',
							docs: {
								description: 'detect duplicate code snippets',
								category: 'Best Practices',
								recommended: false,
							},
							schema: [],
						},
						create(context) {
							const codeBlocks: CodeBlocks = {};
							function reportDuplicate(node: any, hash: string) {
								context.report({
									node,
									message: `Duplicate code detected. Similar code found at: ${codeBlocks[hash].join(', ')}`,
								});
							}
							function getHash(node: any) {
								const sourceCode = context.sourceCode.getText();
								return hash(sourceCode);
							  }
							return {
								BlockStatement(node) {
									const blockHash = getHash(node);
									if (codeBlocks[blockHash]) {
										codeBlocks[blockHash].push(node.loc?.start.line!);
										reportDuplicate(node, blockHash);
									} else {
										codeBlocks[blockHash] = [node.loc?.start.line!];
									}
								},
							};
						},
					},
				},
			},
		},
	});
	return eslint
}

// Function to run ESLint and update diagnostics
async function runEslint(document: vscode.TextDocument, diagnosticsCollection: vscode.DiagnosticCollection, token: vscode.CancellationToken) {
	if (token.isCancellationRequested) {
		return [];
	}

	if (document.languageId === "javascript" || document.languageId === "vue" || document.languageId === "typescript") {
		const eslint = createESLintInstance();

		try {
			const text = document.getText();
			const results = await eslint.lintText(text, { filePath: document.uri.fsPath });

			if (token.isCancellationRequested) {
				return [];
			}

			const diagnostics: vscode.Diagnostic[] = [];

			results.forEach((result) => {
				result.messages.forEach((message) => {
					const range = new vscode.Range(
						new vscode.Position(message.line - 1, message.column - 1),
						new vscode.Position(message.endLine ? message.endLine - 1 : message.line - 1, message.endColumn ? message.endColumn - 1 : message.column)
					);

					const diagnostic = new vscode.Diagnostic(
						range,
						message.message,
						message.severity === 2 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
					);

					diagnostics.push(diagnostic);
				});
			});

			diagnosticsCollection.set(document.uri, diagnostics);
			if (results.length > 0) {
				updateEslintReport();
				await ESLint.outputFixes(results);
			}
			return results
		} catch (error) {
			if (error instanceof Error) {
				vscode.window.showErrorMessage(`Error analyzing code: ${error.message}`);
			} else {
				vscode.window.showErrorMessage(`Unknown error analyzing code`);
			}
		}
	}
	return [];
}

// Function to analyze the workspace
async function analyzeWorkspace(diagnosticsCollection: vscode.DiagnosticCollection, token: vscode.CancellationToken) {
	const allResults: ESLint.LintResult[] = [];
	try {
		const uris = await vscode.workspace.findFiles("**/*.{js,ts,vue}", "**/node_modules/**");
		for (const uri of uris) {
			if (token.isCancellationRequested) {
				return;
			}

			const document = await vscode.workspace.openTextDocument(uri);
			const results = await runEslint(document, diagnosticsCollection, token);
			allResults.push(...results)
		}
	} catch (error) {
		if (error instanceof Error) {
			vscode.window.showErrorMessage(`Error analyzing workspace: ${error.message}`);
		} else {
			vscode.window.showErrorMessage(`Unknown error analyzing workspace`);
		}
	}
	return allResults;
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "itt-eslint-ts" is now active!');

	const diagnosticsCollection = vscode.languages.createDiagnosticCollection("eslint");
	context.subscriptions.push(diagnosticsCollection);

	const tokenSource = new vscode.CancellationTokenSource();

	// Event Listeners
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => runEslint(document, diagnosticsCollection, tokenSource.token))
	);
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((document) => runEslint(document, diagnosticsCollection, tokenSource.token))
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => analyzeWorkspace(diagnosticsCollection, tokenSource.token))
	);

	// Analyze the workspace on activation
	analyzeWorkspace(diagnosticsCollection, tokenSource.token).then((results) => {
		const report = generateReport(results!);
		saveReport(report);
	});
}

function generateReport(results: ESLint.LintResult[]): string {
	let report = "ESLint Report\n\n";
	results.forEach((result) => {
		if (result.messages.length > 0) {
			report += `File: ${result.filePath}\n`;
			result.messages.forEach((message) => {
				report += `  [${message.line}, ${message.column}] ${message.message} (${message.ruleId})\n`;
			});
			report += "\n";
		}
	});
	return report;
}

function saveReport(report: string) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		const reportDir = path.join(workspaceFolders[0].uri.fsPath, "lint-report");
		const reportPath = path.join(reportDir, "eslint-report.txt");

		if (!fs.existsSync(reportDir)) {
			fs.mkdirSync(reportDir);
		}

		fs.writeFileSync(reportPath, report);
		vscode.window.showInformationMessage(`ESLint report saved to ${reportPath}`);
	} else {
		vscode.window.showErrorMessage("No workspace folder found to save the ESLint report.");
	}
}

async function updateEslintReport() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage("No workspace folder found to update ESLint report.");
		return;
	}

	const reportDir = path.join(workspaceFolders[0].uri.fsPath, "lint-report");
	const reportPath = path.join(reportDir, "eslint-report.txt");

	if (!fs.existsSync(reportDir)) {
		fs.mkdirSync(reportDir);
	}

	try {
		const allResults: ESLint.LintResult[] = [];
		const uris = await vscode.workspace.findFiles("**/*.{js,ts,vue}", "**/node_modules/**");
		for (const uri of uris) {
			const document = await vscode.workspace.openTextDocument(uri);
			const eslint = createESLintInstance();
			const results = await eslint.lintText(document.getText(), { filePath: document.uri.fsPath });
			allResults.push(...results);
		}

		const updatedReport = generateReport(allResults);
		fs.writeFile(reportPath, updatedReport, (err) => {
			if (err) {
				vscode.window.showErrorMessage(`Failed to update ESLint report: ${err.message}`);
			} else {
				vscode.window.showInformationMessage(`ESLint report updated and saved to ${reportPath}`);
			}
		});
	} catch (error) {
		vscode.window.showErrorMessage(`Error updating ESLint report: ${error}`);
	}
}
export function deactivate() {
	// Nothing to clean up for now
}
