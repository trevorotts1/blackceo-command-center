/** Pure text helpers shared by the server store and the board panel (no server imports). */

export function cleanPhrase(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

/** Pull "<label>" out of "I recommend: <label>, because ..." */
export function labelFromRecommendation(rec: string): string {
  const body = rec.replace(/^i recommend:\s*/i, '');
  const cut = body.split(/,\s*because\b|\.\s/i)[0];
  return cleanPhrase(cut);
}
