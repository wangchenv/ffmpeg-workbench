export type { CommandNode, ProjectDocument, OptionDefinition, ValidationIssue, HelpParseResult } from './types';
export { optionCatalog } from './catalog';
export { parseHelp } from './help';
export { getOutputOption, replaceInputs, replaceOptionValue } from './editing';
export { PROJECT_SCHEMA_VERSION, compileProject, formatCommand, validateProject, createDemoProject, assertProjectDocument, serializeProject, deserializeProject, saveProject, loadProject } from './project';
export type { FeatureConfig, FeaturePurpose, FeatureFormat, FeatureWarning, FeatureReadResult, AdvancedSettingDefinition } from './features';
export { advancedSettings, readFeatureConfig, applyFeatureConfig, readAdvancedSetting, applyAdvancedSetting, getAdvancedChoiceIssue, getAudioBitrateIssue, getAudioSampleRateIssue } from './features';
