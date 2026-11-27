/** Parse stored provider credentials, including line breaks and commas escaped as \\,. */
export function splitApiKeyString(value = ''): string[] {
  return value
    .split(/(?<!\\),|\r\n?|\n/)
    .map((key) => key.trim().replace(/\\,/g, ','))
    .filter(Boolean)
}
