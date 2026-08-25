import { redirect } from 'next/navigation';

/** The CRM has no marketing surface; the root is just a doorway. */
export default function Home() {
  redirect('/dashboard');
}
