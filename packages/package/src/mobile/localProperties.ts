/**
 * The staged Android project's `local.properties`: where Gradle finds the SDK.
 *
 * **A properties file is not plain text, and a Windows folder is where that shows.** Its reader
 * takes a backslash as an escape, so `C:\tools\new\android-sdk` written as it is reads back with a
 * tab for `\t`, a new line for `\n`, and every other backslash dropped. A build on Windows then
 * stopped at lint with "The filename, directory name, or volume label syntax is incorrect", about
 * a folder nobody named. So the value is written as `Properties.store` writes one: each backslash
 * doubled, a leading space escaped, and everything past printable ASCII as `\uXXXX`, one UTF-16
 * unit at a time, which reads the same whatever encoding the file is opened with.
 *
 * What it leaves alone: `:` and `=` matter in a key and not in a value, so a path keeps them.
 */
export function propertiesValue(value: string): string {
  let out = '';
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    if (unit === 0x5c) out += '\\\\';
    else if (unit === 0x20 && at === 0) out += '\\ ';
    else if (unit < 0x20 || unit > 0x7e)
      out += `\\u${unit.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += value[at];
  }
  return out;
}

/** The whole file, for an SDK at `sdkRoot`. */
export function localProperties(sdkRoot: string): string {
  return `sdk.dir=${propertiesValue(sdkRoot)}\n`;
}
