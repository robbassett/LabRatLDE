import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from './Toasts';

export type DetailRow = { label: string; value: string | null | undefined; term?: string };

// RecordDetails keeps identifiers and digests out of the way but one click
// from copying (SPEC-025-R18). `term` is the data term behind a plain label.
export default function RecordDetails({ rows, summary = 'Record details', children }: { rows: DetailRow[]; summary?: string; children?: ReactNode }) {
  const shown = rows.filter((r) => r.value);
  if (shown.length === 0 && !children) return null;
  function copy(r: DetailRow) {
    navigator.clipboard
      .writeText(r.value!)
      .then(() => toast(`Copied ${r.label.toLowerCase()}`, 'info'))
      .catch(() => toast(`Couldn't copy ${r.label.toLowerCase()}. Select it and copy by hand.`, 'error'));
  }
  return (
    <details className="record-details">
      <summary>{summary}</summary>
      <dl>
        {shown.map((r) => (
          <div key={r.label} style={{ display: 'contents' }}>
            <dt title={r.term}>{r.label}</dt>
            <dd>{r.value}</dd>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Copy ${r.label}`} title={`Copy ${r.label}`} onClick={() => copy(r)}>
              <Copy size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </dl>
      {children}
    </details>
  );
}
