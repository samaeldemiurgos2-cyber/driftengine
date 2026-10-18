import { describe, expect, it } from 'vitest';

import { localProperties, propertiesValue } from './localProperties.ts';

describe('propertiesValue', () => {
  /*
   * **The case the rule exists for**: a properties file reads a backslash as an escape, so a
   * Windows folder written as it is comes back as another one, `\t` a tab and `\n` a new line,
   * and Gradle's lint stopped on a directory name it could not open.
   */
  it('doubles every backslash, so a Windows folder reads back as itself', () => {
    expect(propertiesValue('C:\\tools\\new\\android-sdk')).toBe(
      'C:\\\\tools\\\\new\\\\android-sdk',
    );
    expect(localProperties('C:\\tools\\new\\android-sdk')).toBe(
      'sdk.dir=C:\\\\tools\\\\new\\\\android-sdk\n',
    );
  });

  /* Past printable ASCII as `\uXXXX`, which reads the same whatever encoding opens the file. */
  it('writes a letter past ASCII as a unicode escape', () => {
    expect(propertiesValue('C:\\Users\\Jörg\\sdk')).toBe('C:\\\\Users\\\\J\\u00F6rg\\\\sdk');
    expect(propertiesValue('/home/渡辺/sdk')).toBe('/home/\\u6E21\\u8FBA/sdk');
    expect(propertiesValue('a\tb')).toBe('a\\u0009b');
  });

  /* A leading space is skipped by the reader, so it is escaped to stay part of the value. */
  it('keeps a leading space and leaves an ordinary path as it is', () => {
    expect(propertiesValue(' sdk')).toBe('\\ sdk');
    expect(propertiesValue('/opt/android sdk/x:y=z')).toBe('/opt/android sdk/x:y=z');
  });
});
