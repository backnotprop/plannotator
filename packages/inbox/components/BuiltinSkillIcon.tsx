import type { ReactNode } from 'react';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { PlannotatorMark } from '../icons';

export function builtinSkillIcon(item: SkillCatalogEntry): ReactNode {
  return item.root === 'plannotator' ? <PlannotatorMark className="w-4 h-4 shrink-0 text-primary" /> : null;
}
