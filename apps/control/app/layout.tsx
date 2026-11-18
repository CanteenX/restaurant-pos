import type { ReactNode } from 'react';

export const metadata = { title: 'Nventra Control Center' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}