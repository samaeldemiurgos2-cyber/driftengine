/**
 * How the shell's scheme answers a request for a file: whole, or the one byte range it asked for.
 *
 * **A `<video>` seeks by range.** It asks for the bytes from the point it wants on, and a scheme
 * that streamed every file whole, with neither a length nor an answer to `Range`, sent it back to
 * its first frames each time: a game seeking its movie to keep up with the frame it showed watched
 * it restart, forty-two times in half a minute. So every answer carries `Accept-Ranges` and a
 * `Content-Length`, and a single range is answered `206` with `Content-Range` (RFC 9110 §14).
 *
 * **One range, and only one.** Several at once would be a `multipart/byteranges` body, which no
 * media element asks for; the RFC lets a server answer such a request whole, and this does. So
 * does it a header it cannot read. A range starting past the end is `416`, naming the length.
 *
 * Pure, so it is tested without Electron; `window.ts` stats the file and streams what this says.
 */
export interface FileAnswer {
  readonly status: 200 | 206 | 416;
  /** The first byte to send and the last, inclusive; `end` below `start` sends nothing. */
  readonly start: number;
  readonly end: number;
  readonly headers: Readonly<Record<string, string>>;
}

export function fileAnswer(range: string | null, size: number): FileAnswer {
  const asked = askedRange(range, size);
  if (asked === 'unsatisfiable') {
    return {
      status: 416,
      start: 0,
      end: -1,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': '0',
        'content-range': `bytes */${size}`,
      },
    };
  }
  if (asked === null) {
    return {
      status: 200,
      start: 0,
      end: size - 1,
      headers: { 'accept-ranges': 'bytes', 'content-length': String(size) },
    };
  }
  const [start, end] = asked;
  return {
    status: 206,
    start,
    end,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
    },
  };
}

/** The range asked for, clamped to the file; null for none this takes, as the RFC allows. */
function askedRange(
  header: string | null,
  size: number,
): readonly [number, number] | 'unsatisfiable' | null {
  if (header === null) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  if (first === '') {
    if (last === '') return null;
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return [start, last === '' ? size - 1 : Math.min(Number(last), size - 1)];
}
