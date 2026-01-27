'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100">
        <main className="mx-auto max-w-3xl px-6 py-16">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="mt-3 text-neutral-300">{error.message}</p>
          {error.digest ? (
            <p className="mt-2 text-xs text-neutral-500">{error.digest}</p>
          ) : null}
          <button
            className="mt-6 rounded border border-neutral-700 px-3 py-2 text-sm"
            onClick={() => reset()}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
