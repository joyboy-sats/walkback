/**
 * Plain-English void reasons.
 *
 * The stored sentence is what the feed and the source page show. A provider
 * error is rewritten once, here, so the UI never has to know a Rust error
 * shape. The raw message stays in the evidence payload.
 */

const EMPTY_EFFECT =
  "Could not check this transfer. A transaction in the page has no effects, " +
  "so balance changes could not be derived and the total is unknown.";

/** The sentence a person should read. Unrecognised text is returned as stored. */
export function explainVoidReason(reason: string): string {
  if (/effect is empty/i.test(reason)) return EMPTY_EFFECT;
  return reason;
}
