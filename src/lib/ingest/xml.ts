/**
 * @file A chunk-fed XML **scanner** — not a parser, and deliberately so.
 *
 * ## Why this is hand-rolled
 *
 * `integration-apple-health.md` §3.7 recommends `saxes`. It is a good library.
 * It is also a dependency, and `AGENTS.md` rule 3 asks for pure zero-dependency
 * TypeScript in the parsing layer. The alternative is ~150 lines, because
 * `export.xml` needs almost nothing a real XML parser provides:
 *
 * - no text content is read (every datum is an attribute)
 * - no namespaces
 * - no entity definitions beyond the five predefined ones
 * - the only DTD is Apple's own internal subset, which we skip wholesale
 *
 * What it *does* need is the thing `DOMParser` cannot do: stay flat in memory
 * while 3,000,000 elements go past. A 500 MB string handed to `DOMParser` will
 * take an iPhone tab out instantly.
 *
 * ## What it handles that a regex would get wrong
 *
 * 1. **Attribute values containing `>`.** Workout notes and device strings do
 *    contain angle brackets; `/<[^>]*>/` corrupts them. The scanner tracks
 *    quote state.
 * 2. **The internal DTD subset.** `<!DOCTYPE HealthData [ <!ELEMENT …> ]>`
 *    contains nested `>` characters. Bracket depth is tracked so the whole
 *    subset is skipped as one unit.
 * 3. **Chunk boundaries.** A tag split across two 64 KB reads is buffered and
 *    resumed, so nothing depends on where the network or the decompressor
 *    happened to cut.
 * 4. **Multi-byte UTF-8 split across chunks** — handled upstream by
 *    `TextDecoderStream`, which is stateful. This scanner only ever sees whole
 *    code points.
 */

/** Callbacks invoked as elements go past. Neither may throw. */
export interface XmlHandlers {
  /**
   * An element opened.
   *
   * @param name the element name
   * @param attrs its attributes, entity-decoded
   * @param selfClosing true for `<Foo/>`, which fires no `onEnd`
   */
  onStart(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  /** An element closed. Not called for self-closing tags. */
  onEnd(name: string): void;
}

/** The five predefined XML entities. Apple's export uses no others. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode XML entity references in an attribute value.
 *
 * @param s the raw attribute text
 * @returns the decoded text
 */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Characters that terminate an attribute or element name. */
function isNameEnd(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '=' || ch === '/' || ch === '>';
}

/**
 * Split the body of a start tag into a name and its attributes.
 *
 * @param body everything between `<` and `>`, exclusive
 * @returns the element name and decoded attributes
 */
function parseTagBody(body: string): { name: string; attrs: Record<string, string> } {
  let i = 0;
  const n = body.length;
  while (i < n && !isNameEnd(body[i])) i++;
  const name = body.slice(0, i);
  const attrs: Record<string, string> = {};

  while (i < n) {
    const ch = body[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '/') {
      i++;
      continue;
    }
    const keyStart = i;
    while (i < n && !isNameEnd(body[i])) i++;
    const key = body.slice(keyStart, i);
    if (key === '') {
      i++;
      continue;
    }
    while (i < n && (body[i] === ' ' || body[i] === '\t' || body[i] === '\n' || body[i] === '\r')) i++;
    if (body[i] !== '=') {
      // A valueless attribute. XML forbids it; producers occasionally emit it.
      attrs[key] = '';
      continue;
    }
    i++; // past '='
    while (i < n && (body[i] === ' ' || body[i] === '\t' || body[i] === '\n' || body[i] === '\r')) i++;
    const quote = body[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valueStart = i;
      while (i < n && body[i] !== quote) i++;
      attrs[key] = decodeEntities(body.slice(valueStart, i));
      i++; // past the closing quote
    } else {
      const valueStart = i;
      while (i < n && !isNameEnd(body[i])) i++;
      attrs[key] = decodeEntities(body.slice(valueStart, i));
    }
  }

  return { name, attrs };
}

/**
 * Find the `>` that closes a start or end tag, ignoring any inside quotes.
 *
 * @param s the buffer
 * @param from index of the `<`
 * @returns the index of the closing `>`, or `-1` when the tag is incomplete
 */
function findTagEnd(s: string, from: number): number {
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/**
 * Find the `>` that closes a `<!DOCTYPE …>`, including any internal subset.
 *
 * @param s the buffer
 * @param from index of the `<`
 * @returns the index of the closing `>`, or `-1` when more input is needed
 */
function findDoctypeEnd(s: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) return i;
  }
  return -1;
}

/**
 * A streaming XML scanner.
 *
 * Feed it decoded text with {@link write}; it invokes the handlers for every
 * complete element it can see and buffers whatever is left over.
 */
export class XmlScanner {
  private buf = '';
  private readonly handlers: XmlHandlers;

  /**
   * @param handlers callbacks for element start and end
   */
  constructor(handlers: XmlHandlers) {
    this.handlers = handlers;
  }

  /**
   * Feed the next chunk of decoded text.
   *
   * @param chunk any amount of text, including a partial tag
   */
  write(chunk: string): void {
    this.buf = this.buf.length === 0 ? chunk : this.buf + chunk;
    const s = this.buf;
    let i = 0;

    for (;;) {
      const lt = s.indexOf('<', i);
      if (lt === -1) {
        // Nothing but character data left; none of it is meaningful here.
        i = s.length;
        break;
      }

      const next = s[lt + 1];
      if (next === undefined) {
        i = lt;
        break;
      }

      if (next === '!') {
        if (s.startsWith('<!--', lt)) {
          const end = s.indexOf('-->', lt + 4);
          if (end === -1) {
            i = lt;
            break;
          }
          i = end + 3;
          continue;
        }
        if (s.startsWith('<![CDATA[', lt)) {
          const end = s.indexOf(']]>', lt + 9);
          if (end === -1) {
            i = lt;
            break;
          }
          i = end + 3;
          continue;
        }
        const end = findDoctypeEnd(s, lt);
        if (end === -1) {
          i = lt;
          break;
        }
        i = end + 1;
        continue;
      }

      if (next === '?') {
        const end = s.indexOf('?>', lt + 2);
        if (end === -1) {
          i = lt;
          break;
        }
        i = end + 2;
        continue;
      }

      const gt = findTagEnd(s, lt);
      if (gt === -1) {
        i = lt;
        break;
      }

      if (next === '/') {
        this.handlers.onEnd(s.slice(lt + 2, gt).trim());
        i = gt + 1;
        continue;
      }

      let body = s.slice(lt + 1, gt);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const { name, attrs } = parseTagBody(body);
      if (name !== '') this.handlers.onStart(name, attrs, selfClosing);
      i = gt + 1;
    }

    this.buf = i >= s.length ? '' : s.slice(i);
  }

  /**
   * Signal end of input.
   *
   * A truncated final tag is discarded rather than guessed at — Apple exports
   * are sometimes simply corrupt (`integration-apple-health.md` §3.1) and
   * inventing the missing half of a record is worse than dropping it.
   */
  end(): void {
    this.buf = '';
  }
}
