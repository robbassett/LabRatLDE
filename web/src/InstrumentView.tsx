import { useEffect, useState } from 'react';
import { listInstruments, type Instrument } from './api';
import { tabKey, type Tab } from './tabs';
import ErrorMessage from './ErrorMessage';
import RecordDetails from './RecordDetails';

// instruments is the explorer's already-loaded list; the view only pages the API when the id is not in it.
type Props = {
  id: string;
  instruments: Instrument[];
  open: (t: Tab) => void;
  rename: (key: string, title: string) => void;
};

type Fetched = { status: 'loading' } | { status: 'error'; message: unknown } | { status: 'ready'; instrument: Instrument };

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export default function InstrumentView({ id, instruments, open, rename }: Props) {
  const fromList = instruments.find((i) => i.id === id);
  const inList = fromList !== undefined;
  const [fetched, setFetched] = useState<Fetched>({ status: 'loading' });

  // Depends on inList, not on the list itself, so growing the list does not restart the search.
  useEffect(() => {
    if (inList) return;
    let live = true;
    setFetched({ status: 'loading' });
    (async () => {
      let cursor: string | undefined;
      do {
        const page = await listInstruments(cursor);
        const found = page.items.find((i) => i.id === id);
        if (found) return setFetched({ status: 'ready', instrument: found });
        cursor = page.next_cursor ?? undefined;
      } while (cursor && live);
      setFetched({ status: 'error', message: 'Instrument not found' });
    })().catch((err: unknown) => {
      if (live) setFetched({ status: 'error', message: err });
    });
    return () => {
      live = false;
    };
  }, [id, inList]);

  const instrument = fromList ?? (fetched.status === 'ready' ? fetched.instrument : undefined);
  const name = instrument?.name;

  useEffect(() => {
    if (name !== undefined) rename(tabKey({ kind: 'instrument', id }), name);
  }, [id, name, rename]);

  if (!instrument) {
    if (fetched.status === 'error') return <ErrorMessage error={fetched.message} action="load the instrument" />;
    return <p className="muted">Loading instrument…</p>;
  }

  const attrs = Object.entries(instrument.attrs ?? {});

  return (
    <article className="view">
      <div className="view-head">
        <div>
          <h1>{instrument.name}</h1>
          <p className="subtitle">
            Instrument · <span className="mono">{instrument.kind}</span>
          </p>
        </div>
        <button type="button" className="btn" onClick={() => open({ kind: 'lineage', id: instrument.node_id, title: instrument.name })}>
          Open lineage
        </button>
      </div>
      <p className="muted">To send readings, open a running run and choose Send data.</p>

      <h2>Details</h2>
      {attrs.length === 0 ? (
        <p className="muted">No details recorded.</p>
      ) : (
        <table className="data">
          <caption className="sr-only">Instrument attributes</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {attrs.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className="mono">{show(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RecordDetails
        rows={[
          { label: 'Instrument ID', value: instrument.id },
          { label: 'Item ID (lineage)', value: instrument.node_id, term: 'lineage node id' },
        ]}
      />
    </article>
  );
}
