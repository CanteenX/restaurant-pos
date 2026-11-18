/** Only these provider-selected headers are used for threading or loop suppression. */
export function selectedInboxHeaders(headers?: Buffer) {
  if (headers && headers.length > 8192) return null;
  const fields = { references: '', autoSubmitted: false, mailingList: false };
  const unfolded = (headers?.toString('latin1') ?? '').replace(/\r\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\r\n')) {
    if (!line) break;
    if (/[\r\n\0]/.test(line)) return null;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'references') {
      if (fields.references) return null;
      fields.references = value;
    }
    if (name === 'auto-submitted' && value.toLowerCase() !== 'no') fields.autoSubmitted = true;
    if (name === 'list-id') fields.mailingList = true;
  }
  return fields;
}
