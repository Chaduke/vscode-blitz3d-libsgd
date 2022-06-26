import * as vscode from 'vscode';
import * as cp from 'child_process';
import { createWriteStream, readdirSync, readFileSync } from 'fs';
import * as path from 'path';

const tokenTypes = new Map<string, number>();
const tokenModifiers = new Map<string, number>();
let diagnosticCollection: vscode.DiagnosticCollection;
let stubs: BlitzStub[];
let stubpath: string;


class BlitzStub {
	name: string = '';
    declaration: string = '';
    parameters: string[] = [];
    description: string[] = [];
    example: string = '';
}

class BlitzToken {
	lcname: string;
	oname: string;
	declaration: string; 
	uri: vscode.Uri;
	declarationRange: vscode.Range;
	range: vscode.Range;
	references: vscode.Range[];
	type: string = '';

	matchBefore: string | RegExp | undefined;
	matchAfter: string | RegExp | undefined;

	constructor(name: string, uri: vscode.Uri, declaration: string, declarationRange: vscode.Range) {
		this.oname = name;
		this.lcname = name.toLowerCase();
		this.uri = uri;
		this.declaration = declaration;
		this.declarationRange = declarationRange;
		this.range = declarationRange;
		this.references = [];
	}
}

class BlitzFunction extends BlitzToken {
	type: string = 'function';
	returnType: string = '(%)';
	locals: BlitzVariable[] = [];
	endPosition: vscode.Position = new vscode.Position(0, 0);
	stub: BlitzStub | undefined;
}

class BlitzType extends BlitzToken {
	type: string = 'type';
	matchBefore: string | RegExp | undefined = /(\.|new\s+|each\s+|type\s+|first\s+|last\s+)$/i;
	fields: BlitzVariable[] = [];
}

class BlitzVariable extends BlitzToken {
	storageType: string = 'local';
	dataType: string = '(%)';
	matchBefore: string | RegExp | undefined = /(?<!\.|new\s|\\|each\s)$/i;
	description: string | undefined;
	constructor(name: string, uri: vscode.Uri, declaration: string, declarationRange: vscode.Range, storageType?: string, dataType?: string) {
		super(name, uri, declaration, declarationRange);
		this.type = 'variable';
		if (storageType) this.storageType = storageType;
		if (dataType) this.dataType = dataType;
	}
}

class BlitzLabel extends BlitzToken {
	type: string = 'label';
	matchBefore: string | RegExp | undefined = /\.|goto\s/i;
}

// TODO: create interface for limited accessibility
class BlitzIterator extends BlitzVariable {
	endPosition: vscode.Position = new vscode.Position(0,0);
}

enum StubGenState {
    declaration,
    parameters,
    description,
    example,
    done
}

function generateTokens(uri: vscode.Uri, text: string): BlitzToken[] {
	let r: BlitzToken[] = [];
	let cType: BlitzType = new BlitzType('', uri, '', new vscode.Range(0, 0, 0, 0));
	let cStub: BlitzStub = new BlitzStub();
	let cFunction: BlitzFunction | undefined;
	let cIterator: BlitzIterator[] = [];
	const lines = text.split(/\r\n|\r|\n/);
	for (let i = 0; i < lines.length; i++) {
		const oline = lines[i];
		const tline = oline.toLowerCase().trim();
		const lineRange = new vscode.Range(i, 0, i, oline.length);

		// get tokens from included file
		if (tline.startsWith('include')) {
			const infile = tline.match(/(?<=\").+(?=\")/)?.toString();
			if (infile) {
				//const infilepath = path.join(uri.path.substring(1, uri.path.lastIndexOf('/')), infile); // path is relative to run location
				const wsfolder = vscode.workspace.workspaceFolders?.[0];
				const infilepath = wsfolder ? path.join(wsfolder.uri.path.substring(1), infile) : path.join(uri.path.substring(1, uri.path.lastIndexOf('/')), infile);
				//TODO obtain infile path from launch config
				const intext = readFileSync(infilepath).toString();
				if (intext.length > 0) r = r.concat(generateTokens(vscode.Uri.file(infilepath), intext));
			}
		}

		// parse global variables
		if (tline.startsWith('global ')) {
			const q = tline.substring('global '.length).split('=')[0].trim();
			if (q.length > 0) {
				r.push(new BlitzVariable(
					removeType(oline.trimStart().substring(7).split('=')[0]),
					uri,
					oline.split('=')[0].trim(),
					lineRange,
					'global'
				));
			}
		}

		// parse locals (or at least try)
		if (tline.startsWith('local ')) {
			const q = tline.substring(6).split('=')[0].trim();
			if (q.length > 0) {
				let v = new BlitzVariable(
					removeType(oline.trimStart().substring(6).split('=')[0]),
					uri,
					oline.split('=')[0].trim(),
					lineRange,
					'local'
				);
				v.description = oline.substring(startOfComment(oline)).trim();
				if (cFunction) {
					cFunction.locals.push(v);
				} else r.push(v);
			}
		}
		if (tline.startsWith('const ')) {
			const q = tline.substring(6).split('=')[0].trim();
			if (q.length > 0) {
				let v = new BlitzVariable(
					removeType(oline.trimStart().substring(6).split('=')[0]),
					uri,
					oline.substring(0, startOfComment(oline)).trim(),
					lineRange,
					'local'
				);
				v.description = oline.substring(startOfComment(oline)).trim();
				if (cFunction) {
					cFunction.locals.push(v);
				} else r.push(v);
			}
		}
		if (tline.startsWith('for ')) {
			const iter = oline.trimStart().substring(3).split('=')[0].trim();
			if (iter.length > 0) {
				let dt = extractType(iter)[1]
				if (!dt) dt = '(%)';
				let l = false;
				if (cFunction) for (const tl of cFunction.locals) {
					if (tl.lcname == removeType(tline.substring(4).split('=')[0].trim())) {
						l = true;
						break;
					}
				} else for (const t of r) {
					if (t.lcname == removeType(tline.substring(4).split('=')[0].trim())) {
						l = true;
						break;
					}
				}
				if (!l) {
					cIterator.push(new BlitzIterator(
						removeType(oline.trimStart().substring(4).split('=')[0].trim()),
						uri,
						'(iterator) ' + oline.split('=')[0].trim().substring(4),
						lineRange,
						'local',
						dt
					));
				}
			}
		}
		if (tline.startsWith('next')) {
			const cit = cIterator.pop()
			if (cit) {
				cit.endPosition = lineRange.end;
				if (cFunction) cFunction.locals.push(cit);
				else r.push(cit);
			}
		}
		if (tline.indexOf('=') >= 0 && (startOfComment(tline) > tline.indexOf('=')) && tline.split('=')[0].trim().indexOf(' ') == -1 && tline.split('=')[0].trim().indexOf('\\') == -1) {
			let dt = extractType(tline.split('=')[0].trim())[1]
			if (!dt) dt = '(%)';
			let l = false;
			if (cFunction) for (const tl of cFunction.locals) {
				if (tl.lcname == removeType(tline.split('=')[0].trim())) {
					l = true;
					break;
				}
			} else for (const t of r) {
				if (t.lcname == removeType(tline.split('=')[0].trim())) {
					l = true;
					break;
				}
			}
			if (!l) {
				const v = new BlitzVariable(
					removeType(oline.split('=')[0]),
					uri,
					'(Local) ' + oline.split('=')[0].trim(),
					lineRange,
					'local',
					dt
				);
				v.description = oline.split(';')[1]//.trim();
				if (cFunction) cFunction.locals.push(v);
				else r.push(v);
			}
		}

		// parse bbdoc
		if (tline.startsWith(';; ')) {
			cStub.description.push(oline.trim().substring(3));
		} else if (tline.startsWith(';;param ')) {
			const fstspc = tline.indexOf(' ', 8);
			if ( fstspc > -1) {
				const param = oline.trim().substring(7, fstspc);
				cStub.parameters.push('`' + param + '`' + oline.trim().substring(fstspc));
			} else cStub.parameters.push(oline.trim().substring(7));
		}

		// parse functions
		const fn = oline.match(/(?<=\bfunction\b).+(?=\()/i)?.toString();
		if (fn) {
			cFunction = new BlitzFunction(
				removeType(fn),
				uri,
				oline.trim().split(';')[0],
				lineRange
			);
			cFunction.uri = uri;
			cFunction.stub = cStub;
			const fType = extractType(fn)[1];
			if (fType) cFunction.returnType = fType;

			// parse parameters as local variables
			const op = tline.indexOf('(');
			if (op < startOfComment(tline)) { // don't parse parameters from comments
				const cp = tline.indexOf(')');
				if (cp >= 0) {
					const pars = tline.substring(op + 1, cp).split(',');
					for (const q of pars) {
						const name = q.split('=')[0].trim();
						if (q.trim().length > 0) {
							const param = new BlitzVariable(removeType(name), uri, '(param) ' + q.trim(), lineRange, 'param', extractType(name)[1]);
							param.type = 'parameter';
							cFunction.locals.push(param);
						}
					}
				}
			}

			cStub = new BlitzStub();
		} else if (cFunction && tline.startsWith('end function')) {
			cFunction.endPosition = lineRange.end;
			cFunction.range = new vscode.Range(cFunction.declarationRange.start, lineRange.end);
			r.push(cFunction);
			cFunction = undefined;
		}

		// parse types
		if (tline.startsWith('type')) {
			const tn = oline.trimStart().substring(4).trim();
			if (tn.length > 0) cType = new BlitzType(tn, uri, oline.trim().split(';')[0], lineRange);
		}
		if (tline.startsWith('field')) {
			tline.substring(5).split(';')[0].trim().split(',').forEach(val => {
				const field = new BlitzVariable(removeType(val), uri, 'Field ' + val, lineRange, 'field', extractType(val)[1]);
				field.description = oline.split(';')[1];
				field.matchBefore = /(Field\s|\\)$/;
				field.type = 'field';
				cType.fields.push(field);
			})
		}
		if (tline.startsWith('end type')) {
			cType.range = new vscode.Range(cType.declarationRange.start, lineRange.end);
			r.push(cType);
		}

		// parse labels
		if (tline.startsWith('.') && tline.length > 1) {
			r.push(new BlitzLabel(tline.substring(1), uri, '(label) ' + tline, lineRange));
		}
	}
	return r;
}

function generateStubFromDoc(document: Buffer):BlitzStub {
    let declaration: string | undefined = ''
	let name: string = '';
    let parameters: string[] = []
    let description: string[] = []
    let example = ''
    let state = StubGenState.declaration
    for (const line of document.toString().split(/\r\n|\r|\n/)) {
        const str = line.trim();
        if ((str.startsWith('<h1>') || str.startsWith('<p><span class="Command">')) && !declaration) {
            declaration = 'function ';
            const m1 = str.match(/(?<=\<h1\>).+(?=\<\/h1\>)/)?.toString()
            const m2 = str.match(/(?<=&nbsp;&nbsp;).+(?=&nbsp;&nbsp;)/)?.toString();
            if (m1) {
				declaration += m1;
			} else if (m2) {
				declaration += m2;
			}
			name = declaration.substring(9)
			name = name.substring(0, name.indexOf('(') == -1 ? name.length : name.indexOf('(')).trim();
			name = name.substring(0, name.indexOf(' ') == -1 ? name.length : name.indexOf(' ')).trim();
        }
        else if (str.startsWith('<td>')) {
            if (parameters.length === 0) {
                state = StubGenState.parameters
            } else if (description.length === 0) {
                state = StubGenState.description
            } else if (!example) {
                state = StubGenState.example
            }
        } else if (str.startsWith('</table>') && state == StubGenState.example) {
            state = StubGenState.done;
        } else if (str.match(/\b(br|table|td|tr|h1)\b/)) {
            continue;
        } else {
            if (str.trim().length === 0) continue;
            switch (state) {
                case StubGenState.parameters:
                    parameters.push(str);
                    break;
                case StubGenState.description:
                    description.push(str);
                    break;
                case StubGenState.example:
                    //if (str.split('"').length % 2 == 0) example += str + '"\r\n'; else example += str + '\r\n';
                    // ^- might be config later
                    example += str + '  \n';
                    break;
                default:
                    continue;
            }
        }
    }
    return {
		name: name,
        declaration: declaration ? declaration : '',
        parameters: parameters,
        description: description,
        example: example
    }
}

function loadDefaultStubs(document: Buffer): BlitzStub[] {
    const r: BlitzStub[] = [];
    let descLines: string[] = [];
    let paramLines: string[] = [];
    let declaration: string = '';
	let name: string = '';
    let exampleLines: string[] = [];
    for (const line of document.toString().split(/\r\n|\r|\n/)) {
        if (line.trim().length == 0) {
            continue;
        }
        if (line.startsWith(';; ')) {
            descLines.push(line.substring(3));
        } else if (line.startsWith(';;param')) {
			paramLines.push(line.substring(7));
        } else if (line.startsWith('function')) {
            declaration = '(builtin)' + line.substring(8);
			name = declaration.substring(9);
			name = name.substring(0, name.indexOf('(') == -1 ? name.length : name.indexOf('(')).trim();
			if (!(name.startsWith('End') || name.startsWith('Else'))) name = name.substring(0, name.indexOf(' ') == -1 ? name.length : name.indexOf(' '));
			name = removeType(name);
        } else if (line.startsWith('end function')) {
            r.push({
				name: name,
                declaration: declaration,
                description: descLines,
                parameters: paramLines,
                example: exampleLines.join('  \n')
            })
            descLines = []
            paramLines = []
            exampleLines = []
        } else {
            exampleLines.push(line);
        }
    }
    return r;
}

const legend = (function () {
	const tokenTypesLegend = [
		'comment', 'string', 'keyword', 'number', 'operator', 'type', 'typeParameter', 'function', 'variable', 'parameter', 'property', 'field'
	];
	tokenTypesLegend.forEach((tokenType, index) => tokenTypes.set(tokenType, index));

	const tokenModifiersLegend = [
		'declaration', 'readonly', 'modification'
	];
	tokenModifiersLegend.forEach((tokenModifier, index) => tokenModifiers.set(tokenModifier, index));

	return new vscode.SemanticTokensLegend(tokenTypesLegend, tokenModifiersLegend);
})();

export function activate(context: vscode.ExtensionContext) {

	diagnosticCollection = vscode.languages.createDiagnosticCollection('blitz3d');
  	context.subscriptions.push(diagnosticCollection);
	if (vscode.window.activeTextEditor) {
		if (vscode.window.activeTextEditor.document.languageId == 'blitz3d') updateDiagnostics(vscode.window.activeTextEditor.document);
	}
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId == 'blitz3d') updateDiagnostics(event.document);
	}));

	context.subscriptions.push (
		vscode.commands.registerCommand('extension.blitz3d.debug', () => {
			let term = vscode.window.createTerminal("blitzcc");
			term.sendText('blitzcc -d ' + vscode.window.activeTextEditor?.document.fileName);
		})
	);
	context.subscriptions.push (
		vscode.commands.registerCommand('extension.blitz3d.run', () => {
			let term = vscode.window.createTerminal('blitzcc');
			term.sendText('blitzcc ' + vscode.window.activeTextEditor?.document.fileName);
		})
	);

	context.subscriptions.push (
		vscode.debug.registerDebugConfigurationProvider('blitz3d', new Blitz3DConfigurationProvider())
	);

	context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider('blitz3d', new DocumentSemanticTokensProvider(), legend));

	context.subscriptions.push(vscode.languages.registerHoverProvider('blitz3d', new BlitzHoverProvider()));

	context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider('blitz3d', new DocumentSymbolProvider()));

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider('blitz3d', new CompletionItemProvider(), '.', '\\'));

	context.subscriptions.push(vscode.languages.registerDefinitionProvider('blitz3d', new DefinitionProvider()));

	context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('blitz3d', new SignatureHelpProvider(), '(', ' '));

	context.subscriptions.push(vscode.commands.registerCommand('extension.blitz3d.generatestubs', generateStubs));

	stubpath = context.asAbsolutePath('stubs.bb')
	let stubdoc = readFileSync(stubpath);
	stubs = loadDefaultStubs(stubdoc);
	console.log('Blitz3D extension activated.');
}

function generateStubs() {
	let blitzpath = vscode.workspace.getConfiguration('blitz3d.installation').get<string>('BlitzPath');
	if (!blitzpath) blitzpath = 'C:\\Program Files (x86)\\Blitz3D\\help\\commands\\';
	else blitzpath += blitzpath.endsWith(path.sep) ? '' : path.sep + 'help' + path.sep + 'commands' + path.sep;
	let stubs: BlitzStub[] = [];
	let ws = createWriteStream(stubpath);
	const files2d = readdirSync(blitzpath + '2d_commands');
	files2d.forEach((fileName) => {
		const file = readFileSync(blitzpath + '2d_commands' + path.sep + fileName);
		let stub = generateStubFromDoc(file);
		if (fileName != 'template.htm') stubs.push(stub);
	})
	const files3d = readdirSync(blitzpath + '3d_commands');
	files3d.forEach((fileName) => {
		const file = readFileSync(blitzpath + '3d_commands' + path.sep + fileName);
		let stub = generateStubFromDoc(file);
		if (fileName != 'template.htm') stubs.push(stub);
	})
	//console.log('stubs count: ' + stubs.length)
	stubs.forEach((stub) => {
		stub.description.forEach((desc) => {
			ws.write(';; ' + desc + '\n');
		})
		stub.parameters.forEach((param) => {
			ws.write(';;param ' + param + '\n');
		})
		ws.write(stub.declaration + '\n');
		ws.write(stub.example);
		ws.write('end function\n');
	})
	ws.close();
	vscode.window.showInformationMessage('Stubs generated from installation folder.');
}

function updateDiagnostics(document: vscode.TextDocument) {

	let diagnostics: vscode.Diagnostic[] = []

	// check for colon usage
	lines: for (let i = 0; i < document.lineCount; i++) {
		const line = document.lineAt(i).text;
		let instring = false;
		for (let j = 0; j < line.length; j++) {
			if (line[j] == '"') instring = !instring;
			if (line[j] == ';' && !instring) continue lines;
			if (line[j] == ':' && !instring) diagnostics.push({
				message: 'The Blitz3D extension does not support the use of colons. Use newline instead of colons',
				range: new vscode.Range(i, j, i, j + 1),
				severity: vscode.DiagnosticSeverity.Warning
			});
		}
	}

	// implement TODOs
	const todotype = vscode.workspace.getConfiguration('blitz3d.editor').get<string>('UseTodos');
	if(todotype != 'Off') {
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.lineAt(i).text;
			if (line.toLowerCase().indexOf(';;todo ') !== -1) diagnostics.push({
				message: 'TODO: ' + line.trim().substring(7),
				range: new vscode.Range(i, line.toLowerCase().indexOf(';;todo '), i, line.length),
				severity: todotype == 'Information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning
			})
		}
	}

	// TODO check for errors by ourselves

	// run compiler with env got from config
	const blitzpath = vscode.workspace.getConfiguration('blitz3d.installation').get<string>('BlitzPath');
	const env = process.env;
	if (blitzpath && blitzpath.length > 0) {
		env['PATH'] += path.delimiter + blitzpath + (blitzpath.endsWith(path.sep) ? '' : path.sep) + 'bin';
		env['BLITZPATH'] = blitzpath;
	}
	cp.exec('blitzcc -c ' + document.fileName, env, (err, sout, serr) => {
		if (err) {
			if (sout.trim() == "Can't find blitzpath environment variable") vscode.window.showErrorMessage('BlitzPath is missing from your environment variables. Please set BlitzPath in the extension settings correctly.');
			else if (sout.trim() == "Unable to open linker.dll") vscode.window.showErrorMessage('BlitzPath is configured incorrectly. Please set BlitzPath in the extension settings correctly.');
			const lines = sout.toLowerCase().split(/\r\n|\r|\n/);
			for (const l of lines) {
				if (l.indexOf(':') >= 0 && !l.startsWith('compiling')) {
					const s = l.split(':');
					const msg = s[s.length - 1];
					const lineno = parseInt(s[s.length - 3]) - 1;
					const charno = parseInt(s[s.length - 2]);
					const startPos = new vscode.Position(lineno, charno);
					diagnostics.push({
						message: msg,
						range: new vscode.Range(startPos, startPos),
						severity: vscode.DiagnosticSeverity.Error
					});
				}
			}
		}
		diagnosticCollection.set(document.uri, diagnostics);
	})
}

interface IParsedToken {
	line: number;
	startCharacter: number;
	length: number;
	tokenType: string;
	tokenModifiers: string[];
}

function removeType(name: string): string {
	let q = name.trim();
	if (q.endsWith(']')) q = q.substring(0, q.lastIndexOf('['));
	if (q.indexOf('.') > 0) {
		return q.split('.')[0];
	} else if (q.endsWith('$') || q.endsWith('#') || q.endsWith('%')) {
		return q.substring(0, q.trim().length - 1);
	} else return q;
}


function extractType(name: string) {
	let q = name.trim();
	let suffix = '';
	if (q.endsWith(']')) {
		suffix = '[]';
		q = q.substring(0, q.lastIndexOf('['));
	}
	if (q.indexOf('.') > 0) {
		const ret = q.split('.');
		return [ret[0], ret[1] + suffix]
	} else if (q.endsWith('$') || q.endsWith('#') || q.endsWith('%')) {
		return [q.substring(0, q.length - 1).trimEnd(), q.substring(q.length - 1) + suffix];
	} else return [q, undefined];
}

class DocumentSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
	async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.SemanticTokens> {
		const allTokens = DocumentSemanticTokensProvider._parseText(document.uri, document.getText());
		const builder = new vscode.SemanticTokensBuilder();
		allTokens.forEach((token) => {
			builder.push(token.line, token.startCharacter, token.length, this._encodeTokenType(token.tokenType), this._encodeTokenModifiers(token.tokenModifiers));
		});
		return builder.build();
	}

	private _encodeTokenType(tokenType: string): number {
		if (tokenTypes.has(tokenType)) {
			return tokenTypes.get(tokenType)!;
		} else if (tokenType === 'notInLegend') {
			return tokenTypes.size + 2;
		}
		return 0;
	}

	private _encodeTokenModifiers(strTokenModifiers: string[]): number {
		let result = 0;
		for (let i = 0; i < strTokenModifiers.length; i++) {
			const tokenModifier = strTokenModifiers[i];
			if (tokenModifiers.has(tokenModifier)) {
				result = result | (1 << tokenModifiers.get(tokenModifier)!);
			} else if (tokenModifier === 'notInLegend') {
				result = result | (1 << tokenModifiers.size + 2);
			}
		}
		return result;
	}

	static _parseText(uri: vscode.Uri, text: string): IParsedToken[] {
		const r: IParsedToken[] = [];
		const lines = text.split(/\r\n|\r|\n/);
		let tokens: BlitzToken[] = generateTokens(uri, text);
		for (let i = 0; i < lines.length; i++) {
			const oline = lines[i].toLowerCase();
			const tline = oline.trim();
			const scpos = startOfComment(tline);
			const oscpos = startOfComment(oline);
			
			for (const t of tokens) {
				/*
					I will refactor this later...				
				*/
				if (t instanceof BlitzIterator && (i < t.range.start.line || i > t.endPosition.line)) continue;
				for (let st = oline.indexOf(t.lcname); st != -1 && (scpos === -1 || st < oscpos); st = oline.indexOf(t.lcname, st + 1)) {
					// not in strings
					if (isInString(oline, st)) continue;
					if (t.matchBefore && !oline.substring(0, st).match(t.matchBefore)) continue;
					if (t.matchAfter && !oline.substring(st + t.lcname.length).match(t.matchAfter)) continue;
					if (st >= 0 && !oline[st - 1]?.match(/\w/) && !oline[st + t.lcname.length]?.match(/\w/)) {
						r.push({
							line: i,
							startCharacter: st,
							length: t.lcname.length,
							tokenType: t.type,
							tokenModifiers: []
						});
					}
				}
				if (t instanceof BlitzFunction && t.uri == uri &&	i >= t.declarationRange.start.line && i < t.endPosition.line) t.locals.forEach((loc) => {
					for (let st = oline.indexOf(loc.lcname); st != -1 && (scpos === -1 || st < oscpos); st = oline.indexOf(loc.lcname, st + 1)) {
						// not in strings
						if (isInString(oline, st)) continue;
						if (loc.matchBefore && !oline.substring(0, st).match(loc.matchBefore)) continue;
						if (loc.matchAfter && !oline.substring(st + loc.lcname.length).match(loc.matchAfter)) continue;
						if (loc instanceof BlitzIterator && (i < loc.range.start.line || i > loc.endPosition.line)) continue;
						if (st >= 0 && !oline[st - 1]?.match(/\w/) && !oline[st + loc.lcname.length]?.match(/\w/)) {
							r.push({
								line: i,
								startCharacter: st,
								length: loc.lcname.length,
								tokenType: loc.type,
								tokenModifiers: []
							});
						}
					}
				});
				if (t instanceof BlitzType) t.fields.forEach((f) => {
					for (let st = oline.indexOf(f.lcname); st != -1 && (scpos === -1 || st < oscpos); st = oline.indexOf(f.lcname, st + 1)) {
						// not in strings
						if (isInString(oline, st)) continue;
						if (f.matchBefore && !oline.substring(0, st).match(f.matchBefore)) continue;
						if (f.matchAfter && !oline.substring(st + f.lcname.length).match(f.matchAfter)) continue;
						if (st >= 0 && !oline[st - 1]?.match(/\w/) && !oline[st + f.lcname.length]?.match(/\w/)) {
							r.push({
								line: i,
								startCharacter: st,
								length: f.lcname.length,
								tokenType: 'property',
								tokenModifiers: []
							});
						}
					}
				});
			}
		}
		return r;	
	}

}

class Blitz3DConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'blitz3d') {
				config.type = 'blitz3d';
				config.name = 'Debug Blitz3D program';
				config.request = 'launch';
				config.bbfile = '${file}';
			}
		}
		return config;
	}
	resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration>{
		if (!config.bbfile || config.bbfile.substring(config.bbfile.length - 2) != 'bb') {
			return vscode.window.showErrorMessage('No file to debug.').then(_ => undefined);
		}
		if (!path.isAbsolute(config.bbfile)) {
			//console.log('BB file is not absolute, finding ' + config.bbfile + ' in workspace');
			config.bbfile = vscode.workspace.workspaceFolders?.[0].uri.fsPath + path.sep + config.bbfile;
		}
		// implementing debug call in config resolver since idfk why my js doesn't launch
		const cmd = 'blitzcc -d ' + config.bbfile;
		const blitzpath = vscode.workspace.getConfiguration('blitz3d.installation').get<string>('BlitzPath');
		const env = process.env;
		if (blitzpath && blitzpath.length > 0) {
			env['PATH'] += path.delimiter + blitzpath + (blitzpath.endsWith(path.sep) ? '' : path.sep) + 'bin';
			env['BLITZPATH'] = blitzpath;	
		}
		cp.exec(cmd, env, (err, stdout, stderr) => {
			if (err) {
				if (stderr.length > 0) {
					vscode.window.showErrorMessage('Your path does not contain the blitzcc command. Please set BlitzPath in the extension settings correctly.', 'View error', 'Go to settings').then(val => {
						switch (val) {
							case 'View error':
								vscode.window.showErrorMessage('Your path does not contain the blitzcc command. Please set BlitzPath in the extension settings correctly.', {detail: 'Error: ' + stderr, modal: true});
								break;
							case 'Go to settings':
								vscode.window.showInformationMessage('Not supported yet');
								break;
						}
					});
				} else {
					let msg = '';
					if (stdout.trim() == "Can't find blitzpath environment variable") msg = 'BlitzPath is missing from your environment variables. Please set BlitzPath in the extension settings correctly.';
					else if (stdout.trim() == "Unable to open linker.dll") msg = 'BlitzPath is configured incorrectly. Please set BlitzPath in the extension settings correctly.';
					else msg = 'Failed to run file: ' + stdout.substring(stdout.lastIndexOf(':') + 1);
					vscode.window.showErrorMessage(msg, 'View output').then(val => {
						if (val) vscode.window.showErrorMessage(msg, {detail: 'Output: ' + stdout, modal: true});
					});
				}
			}
		})
		return config;
	}
}

function isBuiltinBlitzFunction(name:string) {
	return ',Abs,After,And,Before,Case,Const,Data,Default,Delete,Dim,Each,Else,ElseIf,EndIf,Exit,False,Field,First,Float,For,Forever,Function,Global,Gosub,Goto,Handle,If,Include,Insert,Int,Last,Local,Mod,New,Next,Not,Null,Object,Or,Pi,Read,Repeat,Restore,Return,Sar,Select,Sgn,Shl,Shr,Step,Str,Then,To,True,Type,Until,Wend,While,Xor,End,Stop,AppTitle,RuntimeError,ExecFile,Delay,MilliSecs,CommandLine,SystemProperty,GetEnv,SetEnv,CreateTimer,WaitTimer,FreeTimer,DebugLog,RuntimeStats,Sin,Cos,Tan,ASin,ACos,ATan,ATan2,Sqr,Floor,Ceil,Exp,Log,Log10,Rnd,Rand,SeedRnd,RndSeed,String,Left,Right,Replace,Instr,Mid,Upper,Lower,Trim,LSet,RSet,Chr,Asc,Len,Hex,Bin,CurrentDate,CurrentTime,Eof,ReadAvail,ReadByte,ReadShort,ReadInt,ReadFloat,ReadString,ReadLine,WriteByte,WriteShort,WriteInt,WriteFloat,WriteString,WriteLine,CopyStream,DottedIP,CountHostIPs,HostIP,CreateUDPStream,CloseUDPStream,SendUDPMsg,RecvUDPMsg,UDPStreamIP,UDPStreamPort,UDPMsgIP,UDPMsgPort,UDPTimeouts,OpenTCPStream,CloseTCPStream,CreateTCPServer,CloseTCPServer,AcceptTCPStream,TCPStreamIP,TCPStreamPort,TCPTimeouts,OpenFile,ReadFile,WriteFile,CloseFile,FilePos,SeekFile,ReadDir,CloseDir,NextFile,CurrentDir,ChangeDir,CreateDir,DeleteDir,FileSize,FileType,CopyFile,DeleteFile,CreateBank,FreeBank,BankSize,ResizeBank,CopyBank,PeekByte,PeekShort,PeekInt,PeekFloat,PokeByte,PokeShort,PokeInt,PokeFloat,ReadBytes,WriteBytes,CallDLL,CountGfxDrivers,GfxDriverName,SetGfxDriver,CountGfxModes,GfxModeExists,GfxModeWidth,GfxModeHeight,GfxModeDepth,AvailVidMem,TotalVidMem,GfxDriver3D,CountGfxModes3D,GfxMode3DExists,GfxMode3D,Windowed3D,Graphics,Graphics3D,EndGraphics,GraphicsLost,SetGamma,UpdateGamma,GammaRed,GammaGreen,GammaBlue,FrontBuffer,BackBuffer,ScanLine,VWait,Flip,GraphicsWidth,GraphicsHeight,GraphicsDepth,SetBuffer,GraphicsBuffer,LoadBuffer,SaveBuffer,BufferDirty,LockBuffer,UnlockBuffer,ReadPixel,WritePixel,ReadPixelFast,WritePixelFast,CopyPixel,CopyPixelFast,Origin,Viewport,Color,GetColor,ColorRed,ColorGreen,ColorBlue,ClsColor,SetFont,Cls,Plot,Rect,Oval,Line,Text,CopyRect,LoadFont,FreeFont,FontWidth,FontHeight,StringWidth,StringHeight,OpenMovie,DrawMovie,MovieWidth,MovieHeight,MoviePlaying,CloseMovie,LoadImage,LoadAnimImage,CopyImage,CreateImage,FreeImage,SaveImage,GrabImage,ImageBuffer,DrawImage,DrawBlock,TileImage,TileBlock,DrawImageRect,DrawBlockRect,MaskImage,HandleImage,MidHandle,AutoMidHandle,ImageWidth,ImageHeight,ImageXHandle,ImageYHandle,ScaleImage,ResizeImage,RotateImage,TFormImage,TFormFilter,ImagesOverlap,ImagesCollide,RectsOverlap,ImageRectOverlap,ImageRectCollide,Write,Print,Input,Locate,ShowPointer,HidePointer,KeyDown,KeyHit,GetKey,WaitKey,FlushKeys,MouseDown,MouseHit,GetMouse,WaitMouse,MouseWait,MouseX,MouseY,MouseZ,MouseXSpeed,MouseYSpeed,MouseZSpeed,FlushMouse,MoveMouse,JoyType,JoyDown,JoyHit,GetJoy,WaitJoy,JoyWait,JoyX,JoyY,JoyZ,JoyU,JoyV,JoyPitch,JoyYaw,JoyRoll,JoyHat,JoyXDir,JoyYDir,JoyZDir,JoyUDir,JoyVDir,FlushJoy,EnableDirectInput,DirectInputEnabled,LoadSound,FreeSound,LoopSound,SoundPitch,SoundVolume,SoundPan,PlaySound,PlayMusic,PlayCDTrack,StopChannel,PauseChannel,ResumeChannel,ChannelPitch,ChannelVolume,ChannelPan,ChannelPlaying,Load3DSound,LoaderMatrix,HWMultiTex,HWTexUnits,GfxDriverCaps3D,WBuffer,Dither,AntiAlias,WireFrame,AmbientLight,ClearCollisions,Collisions,UpdateWorld,CaptureWorld,RenderWorld,ClearWorld,ActiveTextures,TrisRendered,Stats3D,CreateTexture,LoadTexture,LoadAnimTexture,FreeTexture,TextureBlend,TextureCoords,ScaleTexture,RotateTexture,PositionTexture,TextureWidth,TextureHeight,TextureName,SetCubeFace,SetCubeMode,TextureBuffer,ClearTextureFilters,TextureFilter,CreateBrush,LoadBrush,FreeBrush,BrushColor,BrushAlpha,BrushShininess,BrushTexture,GetBrushTexture,BrushBlend,BrushFX,LoadMesh,LoadAnimMesh,LoadAnimSeq,CreateMesh,CreateCube,CreateSphere,CreateCylinder,CreateCone,CopyMesh,ScaleMesh,RotateMesh,PositionMesh,FitMesh,FlipMesh,PaintMesh,AddMesh,UpdateNormals,LightMesh,MeshWidth,MeshHeight,MeshDepth,MeshesIntersect,CountSurfaces,GetSurface,MeshCullBox,CreateSurface,GetSurfaceBrush,GetEntityBrush,FindSurface,ClearSurface,PaintSurface,AddVertex,AddTriangle,VertexCoords,VertexNormal,VertexColor,VertexTexCoords,CountVertices,CountTriangles,VertexX,VertexY,VertexZ,VertexNX,VertexNY,VertexNZ,VertexRed,VertexGreen,VertexBlue,VertexAlpha,VertexU,VertexV,VertexW,TriangleVertex,CreateCamera,CameraZoom,CameraRange,CameraClsColor,CameraClsMode,CameraProjMode,CameraViewport,CameraFogColor,CameraFogRange,CameraFogMode,CameraProject,ProjectedX,ProjectedY,ProjectedZ,EntityInView,EntityVisible,EntityPick,LinePick,CameraPick,PickedX,PickedY,PickedZ,PickedNX,PickedNY,PickedNZ,PickedTime,PickedEntity,PickedSurface,PickedTriangle,CreateLight,LightColor,LightRange,LightConeAngles,CreatePivot,CreateSprite,LoadSprite,RotateSprite,ScaleSprite,HandleSprite,SpriteViewMode,LoadMD2,AnimateMD2,MD2AnimTime,MD2AnimLength,MD2Animating,LoadBSP,BSPLighting,BSPAmbientLight,CreateMirror,CreatePlane,CreateTerrain,LoadTerrain,TerrainDetail,TerrainShading,TerrainX,TerrainY,TerrainZ,TerrainSize,TerrainHeight,ModifyTerrain,CreateListener,EmitSound,CopyEntity,EntityX,EntityY,EntityZ,EntityPitch,EntityYaw,EntityRoll,GetMatElement,TFormPoint,TFormVector,TFormNormal,TFormedX,TFormedY,TFormedZ,VectorYaw,VectorPitch,DeltaPitch,DeltaYaw,ResetEntity,EntityType,EntityPickMode,GetParent,GetEntityType,EntityRadius,EntityBox,EntityDistance,EntityCollided,CountCollisions,CollisionX,CollisionY,CollisionZ,CollisionNX,CollisionNY,CollisionNZ,CollisionTime,CollisionEntity,CollisionSurface,CollisionTriangle,MoveEntity,TurnEntity,TranslateEntity,PositionEntity,ScaleEntity,RotateEntity,PointEntity,AlignToVector,SetAnimTime,Animate,SetAnimKey,AddAnimSeq,ExtractAnimSeq,AnimSeq,AnimTime,AnimLength,Animating,EntityParent,CountChildren,GetChild,FindChild,PaintEntity,EntityColor,EntityAlpha,EntityShininess,EntityTexture,EntityBlend,EntityFX,EntityAutoFade,EntityOrder,HideEntity,ShowEntity,FreeEntity,NameEntity,EntityName,EntityClass,'.toLowerCase().indexOf(',' + name.toLowerCase() + ',') >= 0;
}

/**
 * Determines where the comment starts in a valid blitz3d line. If there is no comment, the line length is returned so that it will always be bigger than all considerable character positions.
 * @param line the line of code to be examined
 * @returns the position of the first ';' character which is not in a string, or the line length, if there are none
 */
function startOfComment(line: string) : number {
	let instring: boolean = false;
	for (let i = 0; i < line.length; i++) {
		if (line[i] == '"') instring = !instring;
		if (line[i] == ';' && !instring) return i;
	}
	return line.length + 1; // so that c >= startOfComment only if the cth is a comment character
}

/**
 * Check if given position is between double quotes or after the last double quote (but before the start of comment)
 * @param line the line to search in
 * @param position the position to check
 * @returns if the position is in a string in the command line
 */
function isInString(line:string, position: number) : boolean {
	const scpos = startOfComment(line);
	for (let ap = line.indexOf('"'); ap != -1 && ap < scpos; ap = line.indexOf('"', ap + 1)) {
		if (position > ap && (line.indexOf('"', ap + 1) == -1 || position < line.indexOf('"', ap + 1))) return true;
		ap = line.indexOf('"', ap + 1);
		if (ap == -1 || ap > scpos) return false;
	}
	return false;
}

class BlitzHoverProvider implements vscode.HoverProvider {
    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
		const desc: string[] = [];
		const wr = document.getWordRangeAtPosition(position);
		// not on whitespace
		if (!wr) return undefined;
		// not on number literals
		if (document.getText(wr).match(/^[0-9]+$/)) return undefined;
		if (document.lineAt(position.line).text[position.character] == ' ') return undefined;
		const line = document.lineAt(position).text;
		// not in strings
		if (isInString(line, position.character)) return undefined;
		// not in comments
		if (position.character >= startOfComment(line)) return undefined;

		let def = document.getText(wr).toLowerCase();
		// add following word on certain tokens
		const nwr = wr ? document.getWordRangeAtPosition(new vscode.Position(wr?.end.line, wr?.end.character + 2)) : undefined;
		if (nwr) {
			const m = document.getText(nwr).toLowerCase().match(/if|function|type|select/)?.toString();
			if (def == 'end' && m) {
				def += ' ' + m;
			} else if (def == 'else' && m == 'if') {
				def = 'else if';
			}
		}

		let dl = 'Defined in ' + document.fileName.substring(document.fileName.lastIndexOf(path.sep) + 1);
		for (const stub of stubs) {
			if (stub.name.toLowerCase() == def) {
				def = '```\n' + stub.declaration + '\n```';
				desc.push('#### Parameters');
				stub.parameters.forEach((p) => {
					desc.push('- ' + p);
				});
				desc.push('\n#### Description');
				stub.description.forEach((descLine) => {
					desc.push(descLine);
				});
				if(stub.example.length == 0) break;
				desc.push('#### Example');
				desc.push('```\n' + stub.example.replace('\r\n', '  \n') + '\n```');
				dl = '';
				break;
			}
		}
		const tokens = generateTokens(document.uri, document.getText());

		// check if hovered over a field
		let typename: string | undefined;
		if (wr.start.character > 0) {
			const x = document.getText(new vscode.Range(wr.start.translate(0, -1), wr.start));
			if (x == '\\') {
				const pwr = document.getWordRangeAtPosition(wr.start.translate(0, -2));
				if (pwr) {
					const par = document.getText(pwr);
					// look up type of parent
					for (const t of tokens) {
						if (t instanceof BlitzVariable && t.lcname == par) {
							typename = t.dataType;
							break;
						} else if (t instanceof BlitzFunction && position.isAfter(t.declarationRange.start) && position.isBefore(t.endPosition)) {
							t.locals.forEach(loc => {
								if (loc.lcname == par) {
									typename = loc.dataType;
								}
							});
						} else if (t instanceof BlitzType && document.getText(new vscode.Range(pwr?.start.translate(0, -1), pwr?.start))) {
							for (const f of t.fields) {
								if (f.lcname == par) {
									typename = f.dataType;
								}
							}
						}
					}
				}
			}
		}

		let newdef = '', priornewdef = '';
		for (const t of tokens) {
			if (def == t.lcname) {
				if (t.matchBefore && !line.substring(0, wr.start.character).match(t.matchBefore)) continue;
				if (t.matchAfter && !line.substring(wr.end.character).match(t.matchAfter)) continue;
				newdef = '```\n' + t.declaration + '\n```';
				if (t instanceof BlitzFunction && t.stub /*&& '#$%. ('.indexOf(t.declaration.charAt(t.name.length + 9)) >= 0*/) {
					t.stub.description.forEach((descLine) => {
						desc.push(descLine);
					});
					if (t.stub.parameters.length > 0) desc.push('#### Parameters');
					t.stub.parameters.forEach((p) => {
						desc.push(p);
					});
					if (t.uri != document.uri) dl = 'Defined in ' + t.uri.path.substring(t.uri.path.lastIndexOf('/') + 1);
				}
				//if (t instanceof BlitzVariable && t.description) desc.push(t.description);
				if (!(t instanceof BlitzVariable)) break; // Variables can be dimmed
			}
			if (t instanceof BlitzFunction && t.uri == document.uri && position.isAfter(t.declarationRange.start) && position.isBefore(t.endPosition)) {
				t.locals.forEach((loc) => {
					if (def == loc.lcname && !((loc.matchBefore && !line.substring(0, wr.start.character).match(loc.matchBefore)) || (loc.matchAfter && !line.substring(wr.end.character).match(loc.matchAfter)))) {
						priornewdef = '```\n' + loc.declaration + '\n```';
						if (loc.description) desc.push(loc.description);
						dl = 'Defined in Function ' + t.oname;
					}
				});
			}
			if (typename && t instanceof BlitzType && t.lcname == typename) {
				t.fields.forEach((f) => {
					if (def == f.lcname && !((f.matchBefore && !line.substring(0, wr.start.character).match(f.matchBefore)) || (f.matchAfter && !line.substring(wr.end.character).match(f.matchAfter)))) {
						priornewdef = '```\n' + f.declaration + '\n```';
						if (f.description) desc.push(f.description);
						dl = 'Defined in Type ' + t.oname;
					}
				});
			}
		}
		if (priornewdef.length > 0) def = priornewdef;
		else if (newdef.length > 0) def = newdef;
		return {
			contents: [
				def,
				desc.join('  \n') + (desc.length > 0 ? '  \n' : ''),
				dl
			]
		}
    }
}

class DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	private static _typeToKind(type: string): vscode.SymbolKind {
		switch (type) {
			case 'function':
				return vscode.SymbolKind.Function;
			case 'type':
				return vscode.SymbolKind.Class;
			case 'label':
				return vscode.SymbolKind.String;
			case 'variable':
				return vscode.SymbolKind.Variable;
			case 'field':
				return vscode.SymbolKind.Field;
			case 'label':
				return vscode.SymbolKind.String;
			default:
				return vscode.SymbolKind.Module;
		}
	}
	provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentSymbol[]> {
		const classicSymbols = vscode.workspace.getConfiguration('blitz3d.outline').get<boolean>('ClassicOutlineSymbols');
		if (classicSymbols) {
			const stPos = new vscode.Position(0, 0);
			const endPos = document.lineAt(document.lineCount - 1).range.end;
			const nulRng = new vscode.Range(stPos, endPos);
			let funcs: vscode.DocumentSymbol[] = [];
			let types: vscode.DocumentSymbol[] = [];
			let labels: vscode.DocumentSymbol[] = [];
			for (let i = 0; i < document.lineCount; i++) {
				const line = document.lineAt(i);
				const s = line.text.toLowerCase().trim();
				const fn = s.match(/(?<=^function\b).+(?=\()/)?.toString();
				if (fn) {
					const fnt = extractType(fn);
					if (fnt && fnt[0]) funcs.push(new vscode.DocumentSymbol(fnt[0], fnt[1] ? fnt[1] : '(%)', vscode.SymbolKind.Function,line.range,line.range));
				}
				if (s.match(/^end function/)) {
					const lf = funcs.pop();
					if (lf) {
						lf.range = new vscode.Range(lf.range.start, line.range.end);
						funcs.push(lf);
					}
				}
				const tn = s.match(/(?<=^type\b).+$/)?.toString();
				if (tn) {
					types.push(new vscode.DocumentSymbol(tn, 'type', vscode.SymbolKind.Class,line.range,line.range));
				}
				if (s.match(/^end type/)) {
					const lt = types.pop();
					if (lt) {
						lt.range = new vscode.Range(lt.range.start, line.range.end);
						types.push(lt);
					}
				}
				if (s.length > 1 && s.startsWith('.')) {
					labels.push(new vscode.DocumentSymbol(s.substring(1),'label', vscode.SymbolKind.String, line.range, line.range));
				}
			}
			const funcscontainer = new vscode.DocumentSymbol('functions','',vscode.SymbolKind.Module, nulRng, nulRng);
			funcscontainer.children = funcs;
			const typescontainer = new vscode.DocumentSymbol('types','',vscode.SymbolKind.Module, nulRng, nulRng);
			typescontainer.children = types;
			const labelscontainer = new vscode.DocumentSymbol('labels','',vscode.SymbolKind.Module, nulRng, nulRng);
			labelscontainer.children = labels;
			return [funcscontainer, typescontainer, labelscontainer];
			//return funcs.concat(types).concat(labels);
		}
		const includeParams = vscode.workspace.getConfiguration('blitz3d.outline').get<boolean>('ParametersInOutline');
		const tokens = generateTokens(document.uri, document.getText());
		const symbols: vscode.DocumentSymbol[] = []
		for (const t of tokens) {
			if (t.uri == document.uri) {
				let dataType = t.type;
				if (t instanceof BlitzFunction) dataType = t.returnType;
				if (t instanceof BlitzVariable) dataType = t.dataType;
				let s = new vscode.DocumentSymbol(t.oname, dataType, DocumentSymbolProvider._typeToKind(t.type), t.range, t.declarationRange);
				if (t instanceof BlitzFunction) {
					for (const loc of t.locals) {
						if (includeParams || loc.type != 'parameter') s.children.push(new vscode.DocumentSymbol(loc.oname, loc.dataType, DocumentSymbolProvider._typeToKind(loc.type), loc.range, loc.declarationRange));
					}
				}
				if (t instanceof BlitzType) {
					for (const f of t.fields) {
						s.children.push(new vscode.DocumentSymbol(f.oname, f.dataType, DocumentSymbolProvider._typeToKind(f.type), f.range, f.declarationRange));
					}
				}
				symbols.push(s);
			}
		}
		return symbols;
	}
	
}

class CompletionItemProvider implements vscode.CompletionItemProvider {
	private _typeToKind(type: string): vscode.CompletionItemKind | undefined {
		switch (type) {
			case 'function':
				return vscode.CompletionItemKind.Function;
			case 'type':
				return vscode.CompletionItemKind.Class;
			case 'variable':
				return vscode.CompletionItemKind.Variable;
			default:
				return undefined;
		}
	}
	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
		const tokens = generateTokens(document.uri, document.getText());
		const r: vscode.CompletionItem[] = [];

		// not in comments
		if (position.character >= startOfComment(document.lineAt(position.line).text)) return undefined;

		// Fields of type
		if (context.triggerCharacter == '\\') {
			const pwr = document.getWordRangeAtPosition(new vscode.Position(position.line, position.character - 2));
			if (pwr) {
				const par = document.getText(pwr);
				// look up type of parent
				let typename = '';
				for (const t of tokens) {
					if (t instanceof BlitzVariable && t.lcname == par) {
						typename = t.dataType;
						break;
					} else if (t instanceof BlitzFunction && position.isAfter(t.declarationRange.start) && position.isBefore(t.endPosition)) {
						t.locals.forEach(loc => {
							if (loc.lcname == par) {
								typename = loc.dataType;
							}
						});
					} else if (t instanceof BlitzType && document.getText(new vscode.Range(pwr?.start.translate(0, -1), pwr?.start))) {
						for (const f of t.fields) {
							if (f.lcname == par) {
								typename = f.dataType;
							}
						}
					}
				}
				for (const t of tokens) {
					if (t instanceof BlitzType && t.lcname == typename) {
						for (const f of t.fields) {
							const ci = new vscode.CompletionItem({label: f.oname, detail: (f.dataType.charAt(0).match(/\w/)? '.' : '') + f.dataType, description: f.description}, vscode.CompletionItemKind.Field);
							ci.detail = f.description ? f.description : '';
							r.push(ci);
						}
					}
				}
				return new vscode.CompletionList(r);
			} else return undefined;
		}

		// Types
		if (context.triggerCharacter == '.') {
			if (position.character >= 2 && document.lineAt(position.line).text[position.character - 2].match(/\w/)) {
				for (const t of tokens) {
					if (t.type == 'type') r.push(new vscode.CompletionItem(t.oname, this._typeToKind(t.type)));
				}
			}
			return new vscode.CompletionList(r);
		}

		// general IntelliSense
		for (const t of tokens) {
			if (t instanceof BlitzType) continue;
			let ci = new vscode.CompletionItem({label: t.oname}, this._typeToKind(t.type));
			if (t instanceof BlitzFunction) {
				ci.label = {
					label: t.oname,
					detail: (t.returnType.charAt(0).match(/\w/) ? '.' : '') + t.returnType,
					description: t.stub?.description.join(' ')
				};
				ci.insertText = new vscode.SnippetString(t.oname + '($0)');
				ci.command = {
					title: 'Trigger Parameter Hints',
					command: 'editor.action.triggerParameterHints'
				}
				ci.documentation = t.stub?.description.join('\n');
				if (position.isAfter(t.declarationRange.start) && position.isBefore(t.endPosition) && document.uri == t.uri) {
					t.locals.forEach(loc => {
						r.push(new vscode.CompletionItem({label: loc.oname, detail: (loc.dataType.charAt(0).match(/\w/) ? '.' : '') + loc.dataType, description: '(local) ' + (loc.description ? loc.description : '')}, vscode.CompletionItemKind.Variable));
					});
				}
			} else if (t instanceof BlitzVariable) {
				ci.label = {
					label: t.oname,
					detail: (t.dataType.charAt(0).match(/\w/) ? '.' : '') + t.dataType,
					description: t.description
				}
				ci.documentation = t.description;
			}
			r.push(ci);
		}

		// Builtin functions
		const usebrackets = vscode.workspace.getConfiguration('blitz3d.editor').get<boolean>('UseBracketsEverywhere');
		for (const stub of stubs) {
			let ci = new vscode.CompletionItem({label: stub.name, detail: stub.declaration.substring(8).includes('(') ? '()' : ''}, vscode.CompletionItemKind.Function);
			ci.documentation = stub.description.join('  \n');
			if (usebrackets || stub.declaration.substring(9).includes('(')) ci.insertText = new vscode.SnippetString(stub.name + '($0)');
			ci.command = {
				title: 'Trigger Parameter Hints',
				command: 'editor.action.triggerParameterHints'
			}
			r.push(ci);
		}
		return new vscode.CompletionList(r);
	}
}

class DefinitionProvider implements vscode.DefinitionProvider{
	provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
		const wr = document.getWordRangeAtPosition(position);
		// not on whitespace
		if (!wr) return undefined;
		if (document.lineAt(position.line).text[position.character] == ' ') return undefined;
		const line = document.lineAt(position).text;
		// not in strings
		if (isInString(line, position.character)) return undefined;
		// not in comments
		if (position.character >= startOfComment(line)) return undefined;

		let def = document.getText(wr).toLowerCase();
		const tokens = generateTokens(document.uri, document.getText());
		let pos: vscode.Position | undefined = undefined;
		let uri: vscode.Uri | undefined = undefined;
		for (const t of tokens) {
			if (def == t.lcname) {
				if (t.matchBefore && !line.substring(0, wr.start.character).match(t.matchBefore)) continue;
				if (t.matchAfter && !line.substring(wr.end.character).match(t.matchAfter)) continue;
				pos = t.declarationRange.start;
				uri = t.uri;
				if (!(t instanceof BlitzVariable)) break; // Variables can be dimmed
			}
			if (t instanceof BlitzFunction && t.uri == document.uri && position.isAfter(t.declarationRange.start) && position.isBefore(t.endPosition)) {
				t.locals.forEach((loc) => {
					if (def == loc.lcname && !((loc.matchBefore && !line.substring(0, wr.start.character).match(loc.matchBefore)) || (loc.matchAfter && !line.substring(wr.end.character).match(loc.matchAfter)))) {
						def = '```\n' + loc.declaration + '\n```';
						pos = loc.declarationRange.start;
						uri = loc.uri;
					}
				});
			}
			if (t instanceof BlitzType) {
				t.fields.forEach((f) => {
					if (def == f.lcname && !((f.matchBefore && !line.substring(0, wr.start.character).match(f.matchBefore)) || (f.matchAfter && !line.substring(wr.end.character).match(f.matchAfter)))) {
						def = '```\n' + f.declaration + '\n```';
						pos = f.declarationRange.start;
						uri = f.uri;
					}
				});
			}
		}
		if (uri && pos) return new vscode.Location(uri, pos);
		return undefined;
	}

}

class SignatureHelpProvider implements vscode.SignatureHelpProvider {
	static startPosition: vscode.Position | undefined;
	provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): vscode.ProviderResult<vscode.SignatureHelp> {
		let ret = context.activeSignatureHelp ? context.activeSignatureHelp : new vscode.SignatureHelp();
		const tokens = generateTokens(document.uri, document.getText());
		const wr = document.getWordRangeAtPosition(position.translate(0, -2));
		if (context.triggerCharacter == '(' || context.triggerKind == vscode.SignatureHelpTriggerKind.Invoke) {
			SignatureHelpProvider.startPosition = position;
			if (!wr) return undefined;
			for (const stub of stubs) {
				if (stub.declaration.toLowerCase().match(document.getText(wr).toLowerCase())) {
					let sigInf = new vscode.SignatureInformation(stub.declaration);
					for (const param of stub.parameters) {
						sigInf.parameters.push(new vscode.ParameterInformation(param.trim().substring(0, param.trim().indexOf(' '))));
					}
					ret.signatures.push(sigInf);
					ret.activeParameter = 0;
				}
			}
			for (const t of tokens) {
				if (!(t instanceof BlitzFunction)) continue;
				if (t.lcname == document.getText(wr).toLowerCase()) {
					let sigInf = new vscode.SignatureInformation(t.declaration);
					for (const l of t.locals) if (l.storageType == 'param') {
						sigInf.parameters.push(new vscode.ParameterInformation(l.oname + (l.dataType == '(%)' ? '' : ('#$%'.indexOf(l.dataType) == -1 ? '.' : '') + l.dataType), l.description));
					}
					sigInf.documentation = t.stub?.description.concat(t.stub.parameters).join('  \n');
					ret.signatures.push(sigInf);
					ret.activeParameter = 0;
				}
			}
		}
		if (context.isRetrigger) {
			// quit if line changed or moved before start of parameters
			if (SignatureHelpProvider.startPosition && (position.isBefore(SignatureHelpProvider.startPosition) || position.line > SignatureHelpProvider.startPosition.line)) return undefined;
			// quit if closing bracket reached
			if (document.getText(new vscode.Range(position.translate(0, -1), position)) == ')') return undefined;
			const line = document.lineAt(position.line).text;
			let lb = line.substring(0, position.character).trim();
			let fn = lb.substring(0, lb.lastIndexOf('(') == -1 ? lb.length - 1 : lb.lastIndexOf('('));
			fn = fn.substring(fn.lastIndexOf(' ') + 1).toLowerCase();
			// TODO quit if end of all parameters reached when no parenthesis
			lb = lb.substring(lb.lastIndexOf('('));
			let cnt = 0;
			while (lb.indexOf(',') >= 0) {
				cnt++;
				lb = lb.substring(lb.indexOf(',') + 1);
			}
			ret.activeParameter = cnt;
		}
		// TODO implement functions that don't need parenthesis
		else if (context.triggerCharacter == ' ') {
			SignatureHelpProvider.startPosition = position;
			if (!wr) return undefined;
			for (const stub of stubs) {
				if (stub.declaration.indexOf('(', 2) == -1 && stub.name.toLowerCase() == document.getText(wr).toLowerCase()) {
					let sigInf = new vscode.SignatureInformation(stub.declaration);
					sigInf.documentation = stub.parameters.join('  \n');
					ret.signatures.push(sigInf);
					ret.activeParameter = 0;
				}
			}
		}
		return ret;
	}
}