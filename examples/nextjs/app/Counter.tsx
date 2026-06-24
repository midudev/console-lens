'use client';

import { useEffect, useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    // No Console Lens import needed — the agent auto-injects the browser
    // client into the served HTML (`npm run dev:lens`).
    console.log('Next.js client component mounted', { hydrated: true });
    const id = setInterval(() => console.info('next heartbeat'), 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <button
      onClick={() => {
        const next = count + 1;
        setCount(next);
        console.log('next button clicked', next);
      }}
    >
      Clicked {count} times
    </button>
  );
}
