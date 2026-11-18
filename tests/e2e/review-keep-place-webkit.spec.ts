/** The review window keep-place table in WebKit: see `review-keep-place.cases.ts`. */

import { webkit } from '@playwright/test';
import { reviewCases } from './review-keep-place.cases';

reviewCases(webkit);
