import { optionCatalog } from './catalog';
import type { HelpParseResult, OptionDefinition } from './types';

/**
 * Best-effort parser of `ffmpeg -h full`. AVOption enum/continuation lines stay
 * in the unparsed count. This output is a discovery aid, never a coverage claim.
 */
export function parseHelp(text: string): HelpParseResult {
  const lines = text.split(/\r?\n/);
  const options: OptionDefinition[] = [];
  let unparsedLines = 0;
  let category = '帮助发现';
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('-') && /^[^\r\n]+(?:options|AVOptions):$/i.test(trimmed)) {
      category = trimmed.replace(/:$/, '');
      continue;
    }
    const match = /^\s*(-[A-Za-z][^\s]*)(?:[ \t]+(.+))?$/.exec(line);
    if (!match || !match[2]) { unparsedLines++; continue; }
    const [, name, help] = match;
    const explicitScope = /\binput\b/i.test(category) ? 'input' : /\boutput\b/i.test(category) ? 'output' : /\bglobal\b/i.test(category) ? 'global' : undefined;
    // Component AVOptions can reuse a tool option's name with different
    // semantics. Do not transfer curated scope/arity across that boundary.
    const candidates = /AVOptions$/i.test(category) ? [] : optionCatalog.filter((entry) => entry.name === name && (!explicitScope || entry.scope === explicitScope));
    const known = candidates.length === 1 ? candidates[0] : undefined;
    const typed = /^<([^>]+)>\s*(?:[A-Z.]{3,}\s+)?(.*)$/.exec(help);
    const rawType = typed?.[1].toLowerCase();
    const valueType: OptionDefinition['type'] = rawType === 'boolean' ? 'boolean' : rawType && /^(?:int|int64|float|double|uint|uint64)$/.test(rawType) ? 'number' : known?.type ?? 'text';
    const defaultMatch = /\(default\s+(.+?)\)(?:\s|$)/.exec(help);
    const definition: OptionDefinition = {
      id: `help.${index + 1}.${name.slice(1)}`,
      name,
      label: known?.label ?? name,
      category,
      // Required by the first-version form contract; scopeVerified=false tells
      // the UI that this fallback is not an established FFmpeg scope rule.
      scope: explicitScope ?? known?.scope ?? 'output',
      scopeVerified: !!known || !!explicitScope,
      type: valueType,
      description: typed?.[2] || help,
      arity: typed ? 1 : known?.arity ?? 'unknown',
      source: 'help',
      sourceLine: index + 1,
      ...(known?.values ? { values: [...known.values] } : {}),
      ...(defaultMatch ? { defaultValue: defaultMatch[1].replace(/^"(.*)"$/, '$1') } : {}),
    };
    options.push(definition);
  }
  const uncertain = options.filter((entry) => !entry.scopeVerified || entry.arity === 'unknown').length;
  return {
    options,
    unparsedLines,
    totalLines: lines.length,
    warnings: [
      '仅解析帮助中的参数行；组件枚举、取值约束、流选择器及组合语义尚未完整解析。',
      ...(uncertain ? [`${uncertain} 个条目的作用域或参数个数仍待确认。`] : []),
    ],
  };
}
