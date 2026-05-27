import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { useSessionFetch } from '@plannotator/ui/hooks/useSessionFetch';
import { createReviewStore, type ReviewStore } from './create-review-store';

const ReviewStoreContext = createContext<StoreApi<ReviewStore> | null>(null);

export function ReviewStoreProvider({ children }: { children: ReactNode }) {
  const fetch = useSessionFetch();
  const storeRef = useRef<StoreApi<ReviewStore> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createReviewStore({ fetch });
  }
  return (
    <ReviewStoreContext value={storeRef.current}>
      {children}
    </ReviewStoreContext>
  );
}

export function useReviewStore<T>(selector: (state: ReviewStore) => T): T {
  const store = useContext(ReviewStoreContext);
  if (!store) throw new Error('useReviewStore must be used within ReviewStoreProvider');
  return useStore(store, selector);
}

export function useReviewStoreApi(): StoreApi<ReviewStore> {
  const store = useContext(ReviewStoreContext);
  if (!store) throw new Error('useReviewStoreApi must be used within ReviewStoreProvider');
  return store;
}
