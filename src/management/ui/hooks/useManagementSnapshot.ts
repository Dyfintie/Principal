import { useEffect, useRef, useState } from 'react';
import { managementRpc } from '../../client.js';
import type { Snapshot } from '../../model.js';
export function useManagementSnapshot(callbacks: {
  initial: (value: Snapshot) => void;
  update: (value: Snapshot) => void;
  error: (message: string) => void;
}) {
  const handlers = useRef(callbacks);
  handlers.current = callbacks;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const lastSeq = useRef<number | null>(null);
  const lastExpanded = useRef<string>('');
  const lastSelected = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true,
      polling = false,
      first = true;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const value: Snapshot = await managementRpc('snapshot');
        if (!mounted) return;
        const currentExpanded = JSON.stringify(value.ui?.expanded ?? []);
        if (
          !first &&
          lastSeq.current === value.seq &&
          lastSelected.current === value.ui?.selected &&
          lastExpanded.current === currentExpanded
        ) {
          return;
        }
        lastSeq.current = value.seq;
        lastSelected.current = value.ui?.selected ?? null;
        lastExpanded.current = currentExpanded;

        if (first) {
          first = false;
          handlers.current.initial(value);
        }
        setSnapshot(value);
        handlers.current.update(value);
      } catch (error) {
        if (mounted) handlers.current.error(`Management disconnected: ${(error as Error).message}`);
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  return { snapshot, setSnapshot };
}
