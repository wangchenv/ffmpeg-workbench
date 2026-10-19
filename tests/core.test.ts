import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { compileProject, createDemoProject, deserializeProject, formatCommand, getOutputOption, optionCatalog, parseHelp, replaceInputs, replaceOptionValue, serializeProject, validateProject } from '../src/core/index';
import type { CommandNode, ProjectDocument } from '../src/core/types';

const node = (id: string, kind: CommandNode['kind'], tokens: string[], enabled = true): CommandNode => ({ id, kind, tokens, enabled });
const project = (nodes: CommandNode[]): ProjectDocument => ({ id: 'test', name: '保真测试', nodes });

test('compile keeps input/output boundaries, repeated options and exact order', () => {
  const document = project([
    node('seek-before', 'option', ['-ss', '00:01:00']),
    node('in-1', 'input', ['-i', 'first.mp4']),
    node('in-2', 'input', ['-i', 'second.wav']),
    node('map-1', 'option', ['-map', '0:v']),
    node('map-2', 'option', ['-map', '1:a']),
    node('seek-after', 'option', ['-ss', '2']),
    node('out-1', 'output', ['first-out.mkv']),
    node('codec', 'option', ['-c', 'copy']),
    node('out-2', 'output', ['second-out.mkv']),
  ]);
  assert.deepEqual(compileProject(document), ['-ss', '00:01:00', '-i', 'first.mp4', '-i', 'second.wav', '-map', '0:v', '-map', '1:a', '-ss', '2', 'first-out.mkv', '-c', 'copy', 'second-out.mkv']);
});

test('disabled nodes stay saved but do not enter argv', () => {
  const document = createDemoProject();
  document.nodes.splice(2, 0, node('disabled', 'option', ['-metadata', 'title=hidden'], false));
  assert.ok(!compileProject(document).includes('title=hidden'));
  assert.equal(deserializeProject(serializeProject(document)).nodes[2].enabled, false);
});

test('demo references a built-in lavfi source and native mpeg4 encoder', () => {
  assert.deepEqual(compileProject(createDemoProject()), ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '5', '-c:v', 'mpeg4', '-q:v', '4', '-an', 'sample-output.mp4']);
  assert.deepEqual(validateProject(createDemoProject()), []);
});

test('copy and a same-media filter report a definite conflict', () => {
  const document = project([node('in', 'input', ['-i', 'in.mp4']), node('copy', 'option', ['-c:v', 'copy']), node('filter', 'option', ['-vf', 'scale=640:-2']), node('out', 'output', ['out.mp4'])]);
  assert.ok(validateProject(document).some((issue) => issue.severity === 'error' && issue.nodeId === 'filter'));
});

test('later video codec override removes copy/filter conflict while audio copy remains valid', () => {
  const document = project([node('in', 'input', ['-i', 'in.mp4']), node('copy', 'option', ['-c', 'copy']), node('codec', 'option', ['-c:v', 'mpeg4']), node('filter', 'option', ['-vf', 'scale=640:-2']), node('out', 'output', ['out.mp4'])]);
  assert.deepEqual(validateProject(document), []);
});

test('copy/filter checks belong to each output, rather than all outputs together', () => {
  const document = project([node('in', 'input', ['-i', 'in.mp4']), node('copy', 'option', ['-c:v', 'copy']), node('out1', 'output', ['first.mp4']), node('codec', 'option', ['-c:v', 'mpeg4']), node('filter', 'option', ['-vf', 'scale=640:-2']), node('out2', 'output', ['second.mp4'])]);
  assert.deepEqual(validateProject(document), []);
});

test('special characters, empty values and Unicode survive compile and JSON', () => {
  const values = ['', '-5', '中文路径 /a b.mp4', 'a\nb', String.raw`C:\video\file.mp4`, `title=It's $HOME; $(exit 3) "hello"`, 'drawtext=text=你好\\:世界'];
  const document = project([node('opaque', 'opaque', values)]);
  assert.deepEqual(compileProject(deserializeProject(serializeProject(document))), values);
});

test('POSIX display quoting roundtrips literal tokens without evaluating metacharacters', { skip: process.platform === 'win32' }, () => {
  const args = ['', 'with space', "single'quote", 'double"quote', '$(echo unsafe)', '`echo unsafe`', '$HOME', 'line\nbreak', '中文', String.raw`back\slash`];
  // The shell is used only to verify the exported display representation. The
  // runner itself always executes argv directly.
  const command = formatCommand('printf', ['%s\\0', ...args]);
  const result = spawnSync('/bin/sh', ['-c', command]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout.toString().split('\0').slice(0, -1), args);
});

test('unknown options and extension data survive JSON without normalization', () => {
  const document = project([node('unknown', 'opaque', ['-future_opt', 'a=b:c,d', '-7']), node('out', 'output', ['out.mkv'])]);
  document.vendorExtension = { version: 8, custom: ['unchanged'] };
  document.nodes[0].futureAnnotation = { arity: 'uncertain' };
  assert.deepEqual(deserializeProject(serializeProject(document)), document);
});

test('JSON import rejects malformed structures, duplicate IDs and unsupported versions', () => {
  for (const invalid of ['{', '{}', JSON.stringify({ id: 'x', name: 'x', nodes: [{ id: 'x', kind: 'input', enabled: true, tokens: [123] }] }), JSON.stringify({ ...createDemoProject(), schemaVersion: 99 }), JSON.stringify(project([node('same', 'option', ['-y']), node('same', 'output', ['out.mp4'])]))]) {
    assert.throws(() => deserializeProject(invalid));
  }
});

test('same input/output path and NUL characters are rejected', () => {
  const document = project([node('in', 'input', ['-i', 'in.mp4']), node('bad', 'option', ['-metadata', 'title=a\0b']), node('out', 'output', ['in.mp4'])]);
  assert.equal(validateProject(document).filter((issue) => issue.severity === 'error').length, 2);
  assert.throws(() => formatCommand('ffmpeg', ['a\0b']));
});

test('known option arity is validated without guessing unknown option arguments', () => {
  const document = project([node('in', 'input', ['-i', 'in.mp4']), node('duration', 'option', ['-t']), node('unknown', 'opaque', ['-future', 'maybe-value']), node('out', 'output', ['out.mp4'])]);
  assert.ok(validateProject(document).some((issue) => issue.severity === 'error' && issue.nodeId === 'duration'));
  assert.deepEqual(compileProject(document), ['-i', 'in.mp4', '-t', '-future', 'maybe-value', 'out.mp4']);
});

test('curated catalog has typed descriptions, unique IDs and both -ss scopes', () => {
  assert.ok(optionCatalog.length >= 35);
  assert.equal(new Set(optionCatalog.map((option) => option.id)).size, optionCatalog.length);
  assert.ok(optionCatalog.every((option) => option.description && option.name.startsWith('-') && option.arity !== 'unknown'));
  assert.deepEqual(optionCatalog.filter((option) => option.name === '-ss').map((option) => option.scope), ['input', 'output']);
});

test('help parser preserves duplicate definitions and reports unsupported lines', () => {
  const help = `ffmpeg version sample\nGlobal options:\n-hide_banner        do not show program banner\n-loglevel loglevel  set logging level\nAVCodecContext AVOptions:\n  -threads <int> ED.VA...... set the number of threads (from 0 to INT_MAX) (default 1)\n  -future_boolean <boolean> E.......... future boolean (default false)\n     auto 0 ED.V....... automatic\nOther component AVOptions:\n  -threads <int> E.......... other threads (default 2)\nUNKNOWN EXTENSION LINE\n`;
  const result = parseHelp(help);
  assert.equal(result.options.length, 5);
  assert.equal(result.options.filter((option) => option.name === '-threads').length, 2);
  assert.equal(result.unparsedLines, 3);
  assert.equal(result.options.find((option) => option.name === '-future_boolean')?.arity, 1);
  assert.equal(result.options.find((option) => option.name === '-future_boolean')?.scopeVerified, false);
  assert.equal(result.options.find((option) => option.name === '-threads')?.defaultValue, '1');
  assert.ok(result.warnings?.length);
});

test('output lookup ignores input options, disabled instances and later output groups', () => {
  const document = project([
    node('decoder', 'option', ['-c:v', 'h264']),
    node('in', 'input', ['-i', 'in.mp4']),
    node('first-codec', 'option', ['-c:v', 'mpeg4']),
    node('override-codec', 'option', ['-c:v', 'libx264']),
    node('disabled-codec', 'option', ['-c:v', 'copy'], false),
    node('out-1', 'output', ['out.mp4']),
    node('next-codec', 'option', ['-c:v', 'libx265']),
    node('out-2', 'output', ['other.mp4']),
  ]);
  assert.equal(getOutputOption(document, '-c:v')?.id, 'override-codec');
  assert.equal(getOutputOption(document, '-vf'), undefined);
  assert.equal(getOutputOption(project(document.nodes.slice(0, 2)), '-c:v'), undefined);
});

test('output lookup treats disabled output nodes exactly as the compiler does', () => {
  const document = project([
    node('in', 'input', ['-i', 'in.mp4']),
    node('codec-1', 'option', ['-c:v', 'mpeg4']),
    node('disabled-output', 'output', ['skip.mp4'], false),
    node('codec-2', 'option', ['-c:v', 'libx264']),
    node('out', 'output', ['out.mp4']),
  ]);
  assert.equal(getOutputOption(document, '-c:v')?.id, 'codec-2');
});

test('replacing demo input leaves output arguments after the new input and does not mutate the project', () => {
  const original = createDemoProject();
  const snapshot = structuredClone(original);
  const replaced = replaceInputs(original, ['真实视频 file.mp4']);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(compileProject(replaced), ['-i', '真实视频 file.mp4', '-t', '5', '-c:v', 'mpeg4', '-q:v', '4', '-an', 'sample-output.mp4']);
  assert.equal(replaced.nodes.find((entry) => entry.tokens[0] === '-t')?.id, 'duration');
});

test('appending real inputs keeps all output arguments and unknown fragments after inputs', () => {
  const document = project([
    node('format', 'option', ['-f', 'mp4']),
    node('in-1', 'input', ['-i', 'first.mp4']),
    node('map', 'option', ['-map', '0:v']),
    node('unknown', 'opaque', ['-future', 'x', 'y']),
    node('codec', 'option', ['-c:v', 'mpeg4']),
    node('out', 'output', ['out.mp4']),
  ]);
  const appended = replaceInputs(document, ['second.wav', 'third.srt']);
  assert.deepEqual(compileProject(appended), ['-f', 'mp4', '-i', 'first.mp4', '-i', 'second.wav', '-i', 'third.srt', '-map', '0:v', '-future', 'x', 'y', '-c:v', 'mpeg4', 'out.mp4']);
  assert.equal(appended.nodes.filter((entry) => entry.kind === 'input').length, 3);
});

test('input replacement removes only the matching test source format and leaves unrelated lavfi inputs', () => {
  const document = createDemoProject();
  document.nodes.splice(2, 0, node('other-lavfi', 'option', ['-f', 'lavfi']), node('audio-source', 'input', ['-i', 'sine=frequency=440']));
  const replaced = replaceInputs(document, ['real.mp4']);
  assert.ok(replaced.nodes.some((entry) => entry.id === 'other-lavfi'));
  assert.ok(replaced.nodes.some((entry) => entry.id === 'audio-source'));
  assert.ok(!replaced.nodes.some((entry) => entry.id === 'input-format'));
  assert.deepEqual(replaceInputs(document, []), document);
  assert.throws(() => replaceInputs(document, ['']));
});

test('single-value editing changes exactly one repeated parameter and preserves literal spaces', () => {
  const document = project([node('meta-1', 'option', ['-metadata', 'title=old']), node('meta-2', 'option', ['-metadata', 'artist=original']), node('out', 'output', ['out.mp4'])]);
  const edited = replaceOptionValue(document, 'meta-2', 'artist=中文 artist');
  assert.deepEqual(edited.nodes[0].tokens, ['-metadata', 'title=old']);
  assert.deepEqual(edited.nodes[1].tokens, ['-metadata', 'artist=中文 artist']);
  assert.deepEqual(document.nodes[1].tokens, ['-metadata', 'artist=original']);
});

test('single-value editing rejects opaque arrays, flags and unknown arity without losing tokens', () => {
  const document = project([node('opaque', 'opaque', ['-future', 'one', '-an']), node('flag', 'option', ['-an']), node('unknown', 'option', ['-future', 'value'])]);
  const snapshot = structuredClone(document);
  for (const id of ['opaque', 'flag', 'unknown']) assert.throws(() => replaceOptionValue(document, id, 'replacement'));
  assert.deepEqual(document, snapshot);
  const dynamic = project([{ ...node('dynamic', 'option', ['-future_boolean', 'false']), arity: 1 }]);
  assert.deepEqual(replaceOptionValue(dynamic, 'dynamic', 'true').nodes[0].tokens, ['-future_boolean', 'true']);
});
