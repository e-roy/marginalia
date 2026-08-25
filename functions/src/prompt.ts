import type { BookDoc } from './types';

/**
 * Whisper accepts an initial prompt that biases decoding, and SPEC §7 calls this the
 * highest-leverage detail in the whole document. Feeding it the book means proper
 * nouns, author names, and the book's own jargon transcribe correctly instead of
 * becoming phonetic mush. It costs nothing.
 *
 *   Notes on "Thinking, Fast and Slow" by Daniel Kahneman, chapter 12,
 *   "The Science of Availability".
 */
export function buildPrompt(
  bookTitle: string,
  book: BookDoc | null,
  chapter: number | null,
): string | null {
  const title = book?.title ?? bookTitle;
  if (!title) return null;

  // The subtitle is where a book's actual subject matter usually lives — "Timeless Lessons
  // on Wealth, Greed, and Happiness" primes Whisper for a whole vocabulary that "The
  // Psychology of Money" does not. Free accuracy on the books that have one.
  const subtitle = book?.subtitle?.trim();
  let prompt = `Notes on "${subtitle ? `${title}: ${subtitle}` : title}"`;

  const authors = book?.authors?.filter((a) => a.trim().length > 0) ?? [];
  if (authors.length > 0) prompt += ` by ${authors.join(', ')}`;

  if (chapter !== null) {
    prompt += `, chapter ${chapter}`;
    const chapterTitle = book?.chapterTitles?.[String(chapter)];
    if (chapterTitle) prompt += `, "${chapterTitle}"`;
  }

  return `${prompt}.`;
}
