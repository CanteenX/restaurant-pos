export type Session = { grants: string[]; verifiedAt: string };
export type Page<T> = { items: T[]; nextCursor: string | number | null };

export class ApiError extends Error {
  constructor(readonly status: number) { super('Control API request failed'); }
}

export async function call<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/control/v1/' + path, {
    signal, cache: 'no-store', ...(body && {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}

export function pagePath(path: string, cursor: Page<unknown>['nextCursor']) {
  return cursor === null ? path : path + '?cursor=' + encodeURIComponent(cursor);
}