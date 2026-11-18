/** Semantic notes landing late, in WebKit: see `sem-landing.cases.ts`. */

import { webkit } from '@playwright/test';
import { landingCases } from './sem-landing.cases';

landingCases(webkit);
