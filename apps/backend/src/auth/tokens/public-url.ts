/**
 * The public base URL that emailed links point at. Always taken from the
 * operator's PUBLIC_URL setting, never from a request's Host header (which a
 * caller controls, so a reset mail could otherwise link to their own site).
 * Returns null unless it is a plain http(s) URL with no credentials, query
 * or fragment.
 */
export function publicBaseUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !value.includes('?') &&
    !value.includes('#');
  if (!plain) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * A link to a web page with the token in the URL fragment: browsers never
 * send the fragment to the server, so it stays out of access logs and
 * Referer headers.
 */
export function authLink(base: string, path: string, token: string): string {
  return `${base}${path}#token=${encodeURIComponent(token)}`;
}
