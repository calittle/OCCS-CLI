// Extract text from rich-text token payloads without decoding their entities.
// Repeat because removing a tag can join surrounding text into another tag.
// This is text extraction, not a sanitizer for HTML that will be rendered.
export function stripHtmlTags(value, pattern = /<[^<>]*>/g) {
  let previous;
  do {
    previous = value;
    value = value.replace(pattern, '');
  } while (value !== previous);
  return value;
}
