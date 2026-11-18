import { useLayoutEffect, useRef } from 'react';

export type Session = { grants: string[]; verifiedAt: string };
export type Page<T> = { items: T[]; nextCursor: string | number | null };

export class ApiError extends Error {
  constructor(readonly status: number) { super('Control API request failed'); }
}

export async function call<T>(path: string, body?: object, signal?: AbortSignal, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const response = await fetch('/api/control/v1/' + path, {
    signal, cache: 'no-store', ...(body && {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}

export function pagePath(path: string, cursor: Page<unknown>['nextCursor']) {
  return cursor === null ? path : path + (path.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor);
}

// A write can commit after navigation. Ignore its result when its view is gone.
export function useRequestScope() {
  const scope = useRef<AbortSignal>(undefined);
  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller.signal;
    return () => controller.abort();
  }, []);
  return scope;
}
