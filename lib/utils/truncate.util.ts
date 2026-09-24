/** One line of at most `max` characters, for server replies quoted in error messages. */
export function truncate(text: string, max = 300): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
