import Link from 'next/link';

export default function PortalNotFound() {
  return <main><section className="signin">
    <h1>Portal page not found</h1>
    <p>Check the address or return to your customer portal.</p>
    <Link href="/portal">Back to customer portal</Link>
  </section></main>;
}
