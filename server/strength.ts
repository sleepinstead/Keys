import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';
import type { StrengthResult } from '../shared/types.ts';

const zxcvbn = new ZxcvbnFactory({
  translations: en.translations,
  graphs: common.adjacencyGraphs,
  dictionary: { ...common.dictionary, ...en.dictionary },
});

/** zxcvbn's cost grows with length; cap the analysed prefix to keep it bounded. */
const MAX_ANALYSED = 100;

export function checkStrength(password: string, userInputs: string[] = []): StrengthResult {
  if (!password) {
    return { score: 0, guessesLog10: 0, crackTime: 'instantly', warning: null, suggestions: [] };
  }
  const r = zxcvbn.check(password.slice(0, MAX_ANALYSED), userInputs.filter(Boolean).slice(0, 10));
  return {
    score: r.score,
    guessesLog10: Math.round(r.guessesLog10 * 10) / 10,
    crackTime: r.crackTimes.offlineSlowHashingXPerSecond.display,
    warning: r.feedback.warning,
    suggestions: r.feedback.suggestions,
  };
}
