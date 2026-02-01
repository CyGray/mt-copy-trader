import { useEffect, useRef } from 'react';

export function useInfiniteScroll(callback: () => void, hasMore: boolean, deps: any[] = []) {
  const loader = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          callback();
        }
      },
      { rootMargin: '100px' }
    );
    if (loader.current) observer.observe(loader.current);
    return () => {
      if (loader.current) observer.unobserve(loader.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader.current, hasMore, ...deps]);

  return loader;
}
