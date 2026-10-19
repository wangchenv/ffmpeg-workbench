import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancedSettings, applyAdvancedSetting, applyFeatureConfig, readAdvancedSetting, readFeatureConfig, serializeProject, deserializeProject, compileProject } from '../src/core/index';
import type { ProjectDocument } from '../src/core/index';

function project(): ProjectDocument {
  return { id: 'advanced-control-contract', schemaVersion: 1, name: 'Control contract', nodes: [
    { id: 'input', kind: 'input', enabled: true, tokens: ['-i','input.mp4'] },
    { id: 'video', kind: 'option', enabled: true, tokens: ['-c:v','libx264'] },
    { id: 'audio', kind: 'option', enabled: true, tokens: ['-c:a','aac'] },
    { id: 'output', kind: 'output', enabled: true, tokens: ['output.mp4'] },
  ] };
}
test('all 28 advanced settings have unique IDs, Chinese explanations and bounded controls', () => {
  assert.equal(advancedSettings.length,28); assert.equal(new Set(advancedSettings.map(d=>d.id)).size,28);
  for(const definition of advancedSettings) {
    assert.ok(definition.label.length>0); assert.ok(definition.description.length>10); assert.match(definition.option,/^-/);
    if(definition.control==='select') {assert.ok(definition.choices?.length);assert.equal(new Set(definition.choices?.map(c=>c.value)).size,definition.choices?.length);}
    if(definition.control==='number')assert.ok(Number.isFinite(definition.min)&&Number.isFinite(definition.max));
  }
});
for(const definition of advancedSettings) {
  const values: Array<string|boolean> = definition.control==='select'?definition.choices!.map(c=>c.value):definition.control==='toggle'?[true,false]:definition.control==='number'?[String(definition.min),String(definition.max)]:['中文标题 = value "quotes" / path',''];
  for(const value of values) test(`advanced choice ${definition.id}=${String(value)} round-trips without affecting sibling metadata`,()=>{
    let p=project(); if(definition.id==='flac-compression')p=applyFeatureConfig(p,{purpose:'audio',format:'flac'});
    if(definition.id==='audio-sample-format'&&value==='s16')p=applyFeatureConfig(p,{purpose:'audio',format:'wav'});
    if(definition.id==='audio-sample-format'&&value==='s32')p=applyFeatureConfig(p,{purpose:'audio',format:'flac'});
    p.nodes.splice(p.nodes.findIndex(n=>n.kind==='output'),0,{id:'unrelated-metadata',kind:'option',enabled:true,tokens:['-metadata','copyright=untouched']});
    const next=applyAdvancedSetting(p,definition.id,value); const restored=deserializeProject(serializeProject(next));
    assert.equal(readAdvancedSetting(restored,definition.id),value===''?undefined:value); assert.deepEqual(compileProject(restored),compileProject(next));
    assert.deepEqual(restored.nodes.find(n=>n.id==='unrelated-metadata')?.tokens,['-metadata','copyright=untouched']);
    const cleared=applyAdvancedSetting(restored,definition.id,undefined);assert.equal(readAdvancedSetting(cleared,definition.id),definition.control==='toggle'?false:undefined);
    assert.deepEqual(cleared.nodes.find(n=>n.id==='unrelated-metadata')?.tokens,['-metadata','copyright=untouched']);
  });
}
for(const purpose of ['compress','convert','trim','resize','audio','mute'] as const) test(`friendly purpose ${purpose} is preserved in saved project`,()=>{
  const next=applyFeatureConfig(project(),{purpose});assert.equal(readFeatureConfig(deserializeProject(serializeProject(next))).config.purpose,purpose);
});
