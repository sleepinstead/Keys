// The EFF large wordlist for passphrases (7,776 words, CC BY 3.0 US, Electronic Frontier
// Foundation), as shipped compressed (~33 KB) in @zxcvbn-ts/language-common.
// Every word picked uniformly at random adds log2(7776) ≈ 12.9 bits of entropy.
import diceware from '@zxcvbn-ts/language-common/dist/diceware.json.mjs';

export const WORDS: readonly string[] = diceware;
