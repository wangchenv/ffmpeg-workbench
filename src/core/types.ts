/** Ordered command nodes are the source of truth; tokens never pass through a shell. */
export interface CommandNode {
  id: string;
  kind: 'option' | 'input' | 'output' | 'opaque';
  enabled: boolean;
  tokens: string[];
  scope?: string;
  [extension: string]: unknown;
}

export interface ProjectDocument {
  id: string;
  name: string;
  nodes: CommandNode[];
  schemaVersion?: number;
  [extension: string]: unknown;
}

export interface OptionDefinition {
  id: string;
  name: string;
  label: string;
  category: string;
  scope: 'global' | 'input' | 'output';
  type: 'boolean' | 'number' | 'text' | 'select';
  description: string;
  values?: string[];
  defaultValue?: string;
  /** Dynamic help often omits scope and arity; keep that uncertainty visible. */
  scopeVerified?: boolean;
  arity?: 0 | 1 | 'unknown';
  source?: 'curated' | 'help';
  sourceLine?: number;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export interface HelpParseResult {
  options: OptionDefinition[];
  /** Nonempty, nonheading lines not represented by a parsed option. */
  unparsedLines: number;
  totalLines?: number;
  warnings?: string[];
}
