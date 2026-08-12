// Which messages are worth embedding.
//
// `embeddings` already covers docs, tasks and pages. The place people and
// agents actually argue — channels and task comments — was unindexed, so "has
// anyone discussed this?" was unreachable by the one tool built to answer it.
// It was deferred on embedding-traffic grounds, and that concern was correct:
// indexing every message means an OpenAI call per "ok", per "@Ada ptal", per
// thumbs-up in prose.
//
// A floor is what makes it affordable, and this module is the floor. It is
// pure because the decision is the whole feature — the indexing plumbing is
// the same three lines pages already use — and because the interesting cases
// are all about text rather than about the database.
//
// Two rules, and the second is the one that does the work:
//
// **Long enough to say something.** A short message is not necessarily
// worthless, but it is worthless to a SEARCH: nobody recovers a decision by
// finding the word "agreed".
//
// **Measured after the tokens are stripped.** `@[Priya](user_x) have a look at
// #[Deploy pipeline](task:abc)` is 60 characters of which none are meaning —
// the ids inflate the length past any floor while carrying nothing anybody
// would search for. Stripping first is what stops the floor being defeated by
// exactly the messages it exists to exclude.

/** Minimum meaningful characters. */
export const MIN_INDEXABLE_CHARS = 140;

/**
 * A message body with the app's three inline tokens reduced to their words.
 *
 * `@[Priya](user_x)` → `Priya`, `#[Deploy pipeline](task:abc)` → `Deploy
 * pipeline`, `[[Runbook]]` → `Runbook`. The labels are kept rather than
 * dropped: a message whose only content is a reference to something still
 * names that thing, and the name is the searchable part.
 */
export function indexableText(body: string): string {
  return body
    .replace(/@\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/#\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    // Markdown links: keep the text, drop the URL. A wall of URLs embeds as
    // noise and matches nothing anybody types into a search box.
    .replace(/\[([^\]]*)\]\((?:https?:\/\/)[^)]*\)/g, "$1")
    // Bare URLs, same reason.
    .replace(/https?:\/\/\S+/g, " ")
    // Quoted text is somebody else's message, already indexed on its own.
    // Indexing it again makes the same paragraph win twice.
    .replace(/^>.*$/gm, " ")
    // Fenced code is not deliberation, and it is the single biggest source of
    // long-but-unsearchable bodies.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is this message worth an embedding?
 *
 * Deliberately independent of who wrote it. An agent's reasoning is exactly as
 * worth finding as a person's — more so, since the agent will not be around to
 * remember it.
 */
export function shouldIndexMessage(body: string): boolean {
  return indexableText(body).length >= MIN_INDEXABLE_CHARS;
}
