import { useEffect, useState } from 'react';
import { useStdout } from 'ink';
export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  return size;
}
