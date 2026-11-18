const MAX_HEADER_LENGTH = 8_192;
const MAX_MESSAGE_ID_LENGTH = 254;

type ThreadHeaders = {
  messageId?: string;
  inReplyTo?: string;
  references?: string;
};

// RFC 5322 modern dot-atoms and no-fold literals. The ASCII ranges in noFoldLiteral
// omit the opening and closing square brackets and the backslash.
const atom = "[A-Za-z0-9!#$%&'*+/=?^_\x60{|}~-]+";
const dotAtom = atom + '(?:\\.' + atom + ')*';
const noFoldLiteral = '\\[[\\x21-\\x5a\\x5e-\\x7e]*\\]';
const messageIdPattern = '<' + dotAtom + '@(?:' + dotAtom + '|' + noFoldLiteral + ')>';

function parseField(value: string | undefined): string[] {
  if (!value || value.length > MAX_HEADER_LENGTH) return [];

  // Unfold only standard CRLF + whitespace. Require the entire field to match so
  // IDs embedded in comments, prose, or an injected header cannot become candidates.
  const unfolded = value.replace(/\r\n(?=[ \t])/g, '').replace(/^[ \t]+/, '');
  const token = new RegExp('(' + messageIdPattern + ')[ \\t]*', 'y');
  const ids: string[] = [];
  while (token.lastIndex < unfolded.length) {
    const match = token.exec(unfolded);
    if (!match || match[1].length > MAX_MESSAGE_ID_LENGTH) return [];
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Direct parents precede reference ancestors, which are walked newest first.
 * These are unverified lookup candidates. The caller must authorize any match.
 */
export function normalizeThreadIdentity(headers: ThreadHeaders): {
  messageId: string | null;
  candidates: string[];
} {
  const ownIds = parseField(headers.messageId);
  const messageId = ownIds.length === 1 ? ownIds[0] : null;
  // Compare the original case, as required for thread identities by RFC 5256.
  const ordered = [
    ...parseField(headers.inReplyTo),
    ...parseField(headers.references).reverse(),
  ];
  return {
    messageId,
    candidates: [...new Set(ordered)].filter((candidate) => candidate !== messageId),
  };
}
