import { optionCatalog } from './catalog';
import { assertProjectDocument } from './project';
import type { CommandNode, ProjectDocument } from './types';

/** Boundaries follow enabled argv nodes, rather than potentially stale UI scope labels. */
function firstOutputRange(project: ProjectDocument): { start: number; end: number } | undefined {
  let start = 0;
  for (let index = 0; index < project.nodes.length; index++) {
    const node = project.nodes[index];
    if (!node.enabled) continue;
    if (node.kind === 'output') return { start, end: index };
    if (node.kind === 'input') start = index + 1;
  }
  return undefined;
}

/** Last enabled exact spelling within the first enabled output's actual argv group. */
export function getOutputOption(project: ProjectDocument, name: string): CommandNode | undefined {
  assertProjectDocument(project);
  const range = firstOutputRange(project);
  if (!range) return undefined;
  let found: CommandNode | undefined;
  for (let index = range.start; index < range.end; index++) {
    const node = project.nodes[index];
    if (node.enabled && node.kind === 'option' && node.tokens[0] === name) found = node;
  }
  return found;
}

/**
 * Replace the built-in test source, otherwise append inputs before the first
 * output parameter group. Existing output options and opaque tokens stay put.
 */
export function replaceInputs(project: ProjectDocument, paths: string[]): ProjectDocument {
  assertProjectDocument(project);
  if (!paths.every((path) => typeof path === 'string' && path.length > 0 && !path.includes('\0'))) {
    throw new Error('输入路径必须是非空且不包含 NUL 的字符串。');
  }
  const next = structuredClone(project);
  if (!paths.length) return next;

  // Only replace one recognizable built-in lavfi test source, not arbitrary
  // files with a similar name or unrelated lavfi inputs in an advanced project.
  for (let index = 0; index < next.nodes.length; index++) {
    const input = next.nodes[index];
    if (!input.enabled || input.kind !== 'input' || !/^testsrc2(?:=|$)/.test(input.tokens[1] ?? '')) continue;
    let precedingBoundary = index - 1;
    while (precedingBoundary >= 0 && !(next.nodes[precedingBoundary].enabled && ['input', 'output'].includes(next.nodes[precedingBoundary].kind))) precedingBoundary--;
    let format: CommandNode | undefined;
    for (let candidate = precedingBoundary + 1; candidate < index; candidate++) {
      const node = next.nodes[candidate];
      if (node.enabled && node.kind === 'option' && node.tokens[0] === '-f') format = node;
    }
    if (format?.tokens[1] !== 'lavfi') continue;
    const removed = new Set([input.id, format.id]);
    next.nodes = next.nodes.filter((node) => !removed.has(node.id));
    break;
  }

  const range = firstOutputRange(next);
  let insertion = range?.start;
  if (insertion === undefined) {
    let lastInput = -1;
    for (let index = 0; index < next.nodes.length; index++) {
      if (next.nodes[index].enabled && next.nodes[index].kind === 'input') lastInput = index;
    }
    insertion = lastInput >= 0 ? lastInput + 1 : next.nodes.length;
  }
  next.nodes.splice(insertion, 0, ...paths.map((path): CommandNode => ({
    id: crypto.randomUUID(),
    kind: 'input',
    enabled: true,
    tokens: ['-i', path],
    scope: 'input',
  })));
  return next;
}

/**
 * Edit a confirmed single-value option. Raw/opaque node editing needs an
 * explicit token-array editor; joining or splitting its text would lose argv.
 */
export function replaceOptionValue(project: ProjectDocument, nodeId: string, value: string): ProjectDocument {
  assertProjectDocument(project);
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('参数值必须是不包含 NUL 的字符串。');
  const original = project.nodes.find((node) => node.id === nodeId);
  if (!original) throw new Error('找不到要编辑的参数实例。');
  const known = optionCatalog.find((definition) => definition.name === original.tokens[0]);
  const arity = known?.arity ?? original.arity;
  if (original.kind !== 'option' || original.tokens.length !== 2 || arity !== 1) {
    throw new Error('仅可编辑已确认的单值参数；高级片段和无值开关请保留原始 token。');
  }
  const next = structuredClone(project);
  const target = next.nodes.find((node) => node.id === nodeId)!;
  target.tokens = [target.tokens[0], value];
  return next;
}
