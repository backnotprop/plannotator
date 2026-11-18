/** The review window keep-place table in Chromium: see `review-keep-place.cases.ts`. */

import { chromium } from '@playwright/test';
import { reviewCases } from './review-keep-place.cases';

reviewCases(chromium);
