import type { CommandNode, ProjectDocument, ValidationIssue } from './types';
import { optionCatalog } from './catalog';

export const PROJECT_SCHEMA_VERSION = 1;

export function compileProject(project: ProjectDocument): string[] {
  assertProjectDocument(project);
  return project.nodes.filter((node) => node.enabled).flatMap((node) => [...node.tokens]);
}

/** POSIX display/export only. Execution must use executable + argv directly. */
export function formatCommand(executable: string, args: string[]): string {
  const quote = (value: string): string => {
    if (value.includes('\0')) throw new Error('命令不能包含 NUL 字符。');
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
  };
  return [executable, ...args].map(quote).join(' ');
}

export function createDemoProject(): ProjectDocument {
  const node = (id: string, kind: CommandNode['kind'], tokens: string[], scope?: string): CommandNode => ({ id, kind, enabled: true, tokens, ...(scope ? { scope } : {}) });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: 'demo-project',
    name: '测试画面 · 5 秒转码',
    nodes: [
      node('input-format', 'option', ['-f', 'lavfi'], 'input-1'),
      node('input-1', 'input', ['-i', 'testsrc2=size=1280x720:rate=30']),
      node('duration', 'option', ['-t', '5'], 'output-1'),
      node('video-codec', 'option', ['-c:v', 'mpeg4'], 'output-1'),
      node('video-quality', 'option', ['-q:v', '4'], 'output-1'),
      node('disable-audio', 'option', ['-an'], 'output-1'),
      node('output-1', 'output', ['sample-output.mp4']),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate known structure without stripping unknown extension fields or tokens. */
export function assertProjectDocument(value: unknown): asserts value is ProjectDocument {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !Array.isArray(value.nodes)) {
    throw new Error('工程格式无效：需要 id、name 和 nodes 数组。');
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`不支持工程版本 ${String(value.schemaVersion)}，当前支持版本 ${PROJECT_SCHEMA_VERSION}。`);
  }
  const ids = new Set<string>();
  for (const [index, entry] of value.nodes.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.kind !== 'string' || !['option', 'input', 'output', 'opaque'].includes(entry.kind) || typeof entry.enabled !== 'boolean' || !Array.isArray(entry.tokens) || !entry.tokens.every((token) => typeof token === 'string') || (entry.scope !== undefined && typeof entry.scope !== 'string')) {
      throw new Error(`工程节点 ${index + 1} 格式无效。`);
    }
    if (ids.has(entry.id)) throw new Error(`工程节点 ID 重复：${entry.id}。`);
    ids.add(entry.id);
  }
}

export function serializeProject(project: ProjectDocument): string {
  assertProjectDocument(project);
  return JSON.stringify(project, null, 2);
}

export function deserializeProject(json: string): ProjectDocument {
  let document: unknown;
  try { document = JSON.parse(json); } catch { throw new Error('无法读取工程：JSON 语法错误。'); }
  assertProjectDocument(document);
  return document;
}

export const saveProject = serializeProject;
export const loadProject = deserializeProject;

type CodecAssignment = { selector: string; value: string; node: CommandNode };
const getCodec = (node: CommandNode): CodecAssignment | undefined => {
  const [name, value] = node.tokens;
  if (!value) return undefined;
  if (name === '-vcodec') return { selector: 'v', value, node };
  if (name === '-acodec') return { selector: 'a', value, node };
  const match = /^-(?:c|codec)(?::(.*))?$/.exec(name);
  return match ? { selector: match[1] ?? '', value, node } : undefined;
};

function checkOutputOptions(nodes: CommandNode[], issues: ValidationIssue[]): void {
  const assignments = nodes.map(getCodec).filter((value): value is CodecAssignment => !!value);
  const isDisabled = (media: string) => nodes.some((node) => node.tokens[0] === (media === 'v' ? '-vn' : '-an'));
  for (const node of nodes) {
    const name = node.tokens[0];
    const filter = name === '-vf' ? 'v' : name === '-af' ? 'a' : /^-filter(?::(.+))?$/.exec(name)?.[1];
    if (!filter) continue;
    const media = filter.split(':')[0];
    if ((media !== 'v' && media !== 'a') || isDisabled(media)) continue;
    const relevant = assignments.filter((codec) => codec.selector === '' || codec.selector === media || codec.selector === filter || (!filter.includes(':') && codec.selector.startsWith(`${media}:`)));
    const last = relevant[relevant.length - 1];
    if (!last) continue;
    const hasPartialOverride = !filter.includes(':') && relevant.some((codec) => codec.selector.startsWith(`${media}:`));
    if (hasPartialOverride) {
      if (relevant.some((codec) => codec.value === 'copy')) issues.push({ severity: 'warning', message: `${media === 'v' ? '视频' : '音频'}滤镜与流级 copy 设置可能冲突；请检查实际流选择器。`, nodeId: node.id });
    } else if (last.value === 'copy') {
      issues.push({ severity: 'error', message: `${media === 'v' ? '视频' : '音频'}流使用 copy 时不能应用 ${name}，请改用编码器或移除滤镜。`, nodeId: node.id });
    }
  }
  if (nodes.some((node) => node.tokens[0] === '-t') && nodes.some((node) => node.tokens[0] === '-to')) {
    issues.push({ severity: 'warning', message: '-t 和 -to 同时设置，FFmpeg 会优先采用 -t。' });
  }
}

/** Initial semantic checks only; FFmpeg remains authoritative for unsupported combinations. */
export function validateProject(project: ProjectDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try { assertProjectDocument(project); } catch (error) { return [{ severity: 'error', message: error instanceof Error ? error.message : '工程结构无效。' }]; }
  const nodes = project.nodes.filter((node) => node.enabled);
  const inputs = nodes.filter((node) => node.kind === 'input');
  const outputs = nodes.filter((node) => node.kind === 'output');
  const diagnostic = nodes.some((node) => /^-(?:h|help|version|buildconf|encoders|decoders|filters|formats|muxers|demuxers|devices|protocols|bsfs|hwaccels|pix_fmts|sample_fmts|layouts|dispositions|colors)$/.test(node.tokens[0] ?? ''));
  if (!outputs.length && !diagnostic) issues.push({ severity: 'error', message: '至少添加一个输出目标。' });
  if (!inputs.length && !diagnostic) issues.push({ severity: 'warning', message: '未添加输入；仅滤镜源等特殊命令可以无输入运行。' });
  let pending: CommandNode[] = [];
  for (const node of nodes) {
    if (!node.tokens.length) issues.push({ severity: 'error', message: '启用的节点不能没有参数。', nodeId: node.id });
    if (node.tokens.some((token) => token.includes('\0'))) issues.push({ severity: 'error', message: '参数不能包含 NUL 字符。', nodeId: node.id });
    if (node.kind === 'input' && (node.tokens.length !== 2 || node.tokens[0] !== '-i' || !node.tokens[1])) issues.push({ severity: 'error', message: '输入节点需要 -i 与一个非空输入地址。', nodeId: node.id });
    if (node.kind === 'output' && (node.tokens.length !== 1 || !node.tokens[0])) issues.push({ severity: 'error', message: '输出节点需要一个非空输出地址。', nodeId: node.id });
    if (node.kind === 'option' && !node.tokens[0]?.startsWith('-')) issues.push({ severity: 'error', message: '参数节点必须以 CLI 参数名开始。', nodeId: node.id });
    if (node.kind === 'option') {
      const definition = optionCatalog.find((option) => option.name === node.tokens[0]);
      if (definition?.arity !== undefined && definition.arity !== 'unknown' && node.tokens.length !== definition.arity + 1) {
        issues.push({ severity: 'error', message: `${node.tokens[0]} 需要 ${definition.arity === 0 ? '不带取值' : '一个取值'}，请检查参数节点。`, nodeId: node.id });
      }
    }
    if (node.kind === 'opaque') issues.push({ severity: 'warning', message: '保留原始参数片段；其参数个数、作用域与组合尚未验证。', nodeId: node.id });
    if (node.kind === 'input') pending = [];
    else if (node.kind === 'output') { checkOutputOptions(pending, issues); pending = []; }
    else pending.push(node);
  }
  const outputPaths = new Set<string>();
  for (const node of outputs) {
    const path = node.tokens[0];
    if (path && inputs.some((input) => input.tokens[1] === path)) issues.push({ severity: 'error', message: '输出地址与输入相同，会覆盖源文件。', nodeId: node.id });
    if (path && outputPaths.has(path) && !/^(?:-|pipe:|https?:|rtmps?:|udp:|tcp:)/i.test(path)) issues.push({ severity: 'error', message: '多个输出使用相同目标，请更换输出路径。', nodeId: node.id });
    if (path) outputPaths.add(path);
  }
  if (nodes.some((node) => node.tokens[0] === '-y') && nodes.some((node) => node.tokens[0] === '-n')) issues.push({ severity: 'error', message: '-y 和 -n 不能同时启用。' });
  return issues;
}
