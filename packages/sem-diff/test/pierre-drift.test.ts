import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, declarations } from '../scripts/pierre-drift.ts';

const meta = `export interface FileDiffMetadata {
  name: string;
  semanticOperations?: SemanticDiffOperation[];
  semanticFolds?: SemanticDiffFold[];
}`;
const ours = `export interface SemanticDiffFold { old: number; }
export type SemanticDiffRole = 'a' | 'b';
export interface SemanticDiffOperation { folds: SemanticDiffFold[] }`;

test('declarations ignores comments and formatting', () => {
  const d = declarations(`/** doc */\nexport type SemanticDiffRole =\n  | 'a' // first\n  | 'b';\ninterface Base { x: number; }`);
  assert.equal(d.get('SemanticDiffRole'), "typeSemanticDiffRole='a'|'b'");
  assert.equal(d.get('Base'), 'interfaceBase{x:number}');
});

test('matching types report nothing', () => {
  const theirs = `/** Pierre */\nexport interface SemanticDiffFold {\n  /** doc */\n  old: number;\n}\nexport type SemanticDiffRole =\n  | 'a'\n  | 'b';\nexport interface SemanticDiffOperation {\n  folds: SemanticDiffFold[];\n}\n${meta}`;
  assert.deepEqual(compare(ours, theirs), []);
});

test('a rename, a changed field, a new helper and a missing output field are all reported', () => {
  const theirs = `export interface SemanticDiffCollapsed { old: number }
export type SemanticDiffRole = 'a' | 'b' | 'c';
export interface SemanticDiffOperation { folds: SemanticDiffCollapsed[]; extra: SemanticDiffExtra }
export interface FileDiffMetadata { semanticOperations?: SemanticDiffOperation[] }`;
  const problems = compare(ours, theirs).map((p) => p.split('\n')[0]);
  assert.deepEqual(problems, [
    'SemanticDiffFold: Pierre no longer declares it (renamed or removed)',
    'SemanticDiffRole differs',
    'SemanticDiffOperation differs',
    'SemanticDiffOperation uses SemanticDiffCollapsed, which our copy does not declare',
    'SemanticDiffOperation uses SemanticDiffExtra, which our copy does not declare',
    'FileDiffMetadata has no field semanticFolds (the engine fills it)',
  ]);
});
