import { describe, expect, it } from 'vitest';

import { fileAnswer } from './byteRange.ts';

describe('fileAnswer', () => {
  /* Every answer says its length and that it takes ranges, which is what lets a `<video>` seek. */
  it('answers a request with no range whole, with its length', () => {
    expect(fileAnswer(null, 1000)).toEqual({
      status: 200,
      start: 0,
      end: 999,
      headers: { 'accept-ranges': 'bytes', 'content-length': '1000' },
    });
  });

  /*
   * **The case the answer exists for**: a `<video>` seeks by asking for the bytes from a point
   * on, and a scheme that streamed the file whole sent it back to its first frames each time.
   */
  it('answers a range with those bytes alone, saying which', () => {
    expect(fileAnswer('bytes=200-499', 1000)).toEqual({
      status: 206,
      start: 200,
      end: 499,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': '300',
        'content-range': 'bytes 200-499/1000',
      },
    });
    expect(fileAnswer('bytes=900-', 1000)).toMatchObject({ status: 206, start: 900, end: 999 });
    expect(fileAnswer('bytes=900-5000', 1000)).toMatchObject({ start: 900, end: 999 });
    expect(fileAnswer('bytes=-100', 1000)).toMatchObject({ status: 206, start: 900, end: 999 });
    expect(fileAnswer('bytes=-5000', 1000)).toMatchObject({ start: 0, end: 999 });
    expect(fileAnswer(' bytes = 0 - 0 ', 1000)).toMatchObject({ status: 206, start: 0, end: 0 });
  });

  /* A range wholly past the end is 416, naming the length, as a browser expects. */
  it('refuses a range that starts past the end', () => {
    expect(fileAnswer('bytes=1000-', 1000)).toEqual({
      status: 416,
      start: 0,
      end: -1,
      headers: { 'accept-ranges': 'bytes', 'content-length': '0', 'content-range': 'bytes */1000' },
    });
    expect(fileAnswer('bytes=-0', 1000)).toMatchObject({ status: 416 });
    expect(fileAnswer('bytes=0-', 0)).toMatchObject({ status: 416 });
  });

  /* What it cannot read, or several ranges at once, it may ignore: the file whole, as before. */
  it('answers whole what it does not take', () => {
    for (const header of ['bytes=0-1,5-9', 'bytes=9-2', 'items=0-1', 'bytes=a-b', 'bytes=-', '']) {
      expect(fileAnswer(header, 1000)).toMatchObject({ status: 200, start: 0, end: 999 });
    }
    expect(fileAnswer(null, 0)).toMatchObject({ status: 200, start: 0, end: -1 });
  });
});
