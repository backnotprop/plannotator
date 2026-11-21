/** Semantic notes landing late, in Chromium: see `sem-landing.cases.ts`. */

import { chromium } from '@playwright/test';
import { landingCases } from './sem-landing.cases';

landingCases(chromium);
