import * as vscode from 'vscode';

import { blitzCtx, initializeContext, updateBlitzPath, updateContext, updateUserLibs } from './context/context';
import { compilationErrors, diagnosticCollection, initializeDiagnostics } from './context/diagnostics';
import openExample from './context/examples';
import { generateStubs, updateStubPath } from './context/stubs';
import compile from './debug/compilation';
import DebugAdapterDescriptorFactory from './debug/debug';
import updateTodos from './debug/todos';
import CompletionItemProvider from './providers/completionItemProvider';
import BlitzConfigurationProvider from './providers/debugConfigurationProvider';
import DefinitionProvider from './providers/definitionProvider';
import DocumentFormattingEditProvider from './providers/documentFormattingEditProvider';
import BlitzSemanticTokensProvider, { legend } from './providers/documentSemanticTokensProvider';
import DocumentSymbolProvider from './providers/documentSymbolProvider';
import BlitzHoverProvider from './providers/hoverProvider';
import SignatureHelpProvider from './providers/signatureHelpProvider';
import TextDocumentContentProvider from './providers/textDocumentContentProvider';

export function activate(context: vscode.ExtensionContext) {

    // Diagnostics
    initializeDiagnostics();
    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(compilationErrors);

    //Load paths
    updateBlitzPath();
    updateStubPath(context.asAbsolutePath('stubs.bb'));

    // Load stubs to use immediately
    initializeContext();
    if (vscode.window.activeTextEditor) {
        updateContext(vscode.window.activeTextEditor.document);
        updateTodos(vscode.window.activeTextEditor.document);
        compile(vscode.window.activeTextEditor.document);
    }

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(compile));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId == 'blitz3d') {
            updateTodos(e.document);
            updateContext(e.document);
        } else if (e.document.languageId == 'blitz3d-decls') {
            updateUserLibs();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.languageId == 'blitz3d') {
            initializeContext();
            updateContext(document);
        }
    }));

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.languageId == 'blitz3d') {
            initializeContext();
            updateContext(editor.document);
        }
    }));

    //Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.blitz3d.debug', () => {
            let term = vscode.window.createTerminal("blitzcc");
            term.sendText('blitzcc -d "' + vscode.window.activeTextEditor?.document.fileName + '"');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.blitz3d.run', () => {
            let term = vscode.window.createTerminal('blitzcc');
            term.sendText('blitzcc "' + vscode.window.activeTextEditor?.document.fileName + '"');
        })
    );
    context.subscriptions.push(vscode.commands.registerCommand('extension.blitz3d.openExample', openExample));
    context.subscriptions.push(vscode.commands.registerCommand('extension.blitz3d.generatestubs', generateStubs));

    // Providers
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('blitz3d', new BlitzConfigurationProvider()));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('blitz3d', new DebugAdapterDescriptorFactory()));
    context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider('blitz3d', new BlitzSemanticTokensProvider(), legend));
    context.subscriptions.push(vscode.languages.registerHoverProvider('blitz3d', new BlitzHoverProvider()));
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider('blitz3d', new DocumentSymbolProvider()));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider('blitz3d', new CompletionItemProvider(), '.', '\\'));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider('blitz3d', new DefinitionProvider()));
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('blitz3d', new SignatureHelpProvider(), '(', ' '));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('bbdoc', new TextDocumentContentProvider()));
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider('blitz3d', new DocumentFormattingEditProvider()));

    // Configurations
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('blitz3d.editor.UseBracketsEverywhere')) {
            vscode.window.showWarningMessage('Bracket snippets need to be updated. Reload window for changes to take effect', 'Reload')
                .then((resp) => { if (resp) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
        }
        if (event.affectsConfiguration('blitz3d.installation.BlitzPath')) {
            updateBlitzPath();
            vscode.window.showInformationMessage('BlitzPath updated.');
        }
        initializeContext();
    }));
    vscode.workspace.getConfiguration('files.encoding', { languageId: 'blitz3d' }).update('files.encoding', 'windows1250', vscode.ConfigurationTarget.Global, true);

    console.log('Blitz3D extension activated.');
}

export function deactivate(context: vscode.ExtensionContext) {
    vscode.workspace.getConfiguration('files.encoding', { languageId: 'blitz3d' }).update('files.encoding', undefined, vscode.ConfigurationTarget.Global, true);
    diagnosticCollection.dispose();
    compilationErrors.dispose();
}
