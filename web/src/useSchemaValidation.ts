import { useEffect, useRef, useState } from 'react';
import { validateAgainstSchema, type SchemaProblem } from './api';

function publish(source: string, problems: SchemaProblem[]) {
  window.dispatchEvent(new CustomEvent('labrat:problems', { detail: { source, problems } }));
}

// useSchemaValidation dry-runs the value against the schema on the server, 300 ms after the last change,
// and publishes the problems for the Problems panel under `source`. A null target clears them.
export function useSchemaValidation(
  source: string,
  target: { schemaVersionId: string } | { bodyText: string } | null,
  value: unknown,
): SchemaProblem[] {
  const [problems, setProblems] = useState<SchemaProblem[]>([]);
  const latest = useRef(0);
  // Compare by content: callers build a new target and value on every render.
  const targetKey = JSON.stringify(target);
  const valueKey = JSON.stringify(value);

  useEffect(() => {
    const n = ++latest.current;
    if (!target) {
      setProblems([]);
      publish(source, []);
      return;
    }
    const timer = window.setTimeout(() => {
      validateAgainstSchema(target, value)
        .then((r) => {
          // Drop an answer for a value that has since changed.
          if (n !== latest.current) return;
          setProblems(r.errors);
          publish(source, r.errors);
        })
        .catch(() => {
          // A failed check is not a problem with the value; keep what we had.
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [source, targetKey, valueKey]);

  useEffect(() => {
    return () => {
      latest.current++;
      publish(source, []);
    };
  }, [source]);

  return problems;
}
