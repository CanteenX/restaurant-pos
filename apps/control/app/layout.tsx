import type { ReactNode } from 'react';
import './styles.css';
import './helpdesk.css';

export const metadata = { title: 'Nventra Control Center' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}