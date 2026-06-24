import Counter from './Counter';

// Server Component: this runs on the SERVER (Node). The Console Lens agent
// (NODE_OPTIONS --require) captures these logs.
export default function Home() {
  const data = { framework: 'next', items: [1, 2, 3] };
  console.log('Next.js server component rendered', data);
  console.warn('server-side warning from Next.js');

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Next.js + Console Lens</h1>
      <p>Server logs come from this server component; browser logs from the client component.</p>
      <Counter />
    </main>
  );
}
