import { Copy, Send } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog as AriaDialog, DialogTrigger, Popover } from 'react-aria-components';
import type { Instrument, RunDetail } from './api';
import EmptyState from './EmptyState';
import { DataArt } from './illustrations';
import { toast } from './Toasts';
import { ComboBox } from './ui';

// sendCommand is the example in design §3.6, filled in for this run.
export function sendCommand(origin: string, instrumentId: string, runId: string): string {
  return [
    `curl --data-binary @readings.ndjson -H 'Content-Type: application/x-ndjson' \\`,
    `     -H 'Authorization: Bearer <your token>' \\`,
    `     "${origin}/v1/instruments/${instrumentId}/stream?run_id=${runId}&label=<label>"`,
    `# each line: {"ts":"2026-11-06T09:30:00Z","channel":"UV_254nm","value":0.0012,"unit":"AU"}`,
  ].join('\n');
}

function SendData({ run, instruments }: { run: RunDetail; instruments: Instrument[] }) {
  const [instrument, setInstrument] = useState<string | null>(instruments.length === 1 ? instruments[0].id : null);
  const cmd = sendCommand(location.origin, instrument ?? '<instrument id>', run.id);
  return (
    <div className="send-data">
      <h3>Send readings to this run</h3>
      <p className="muted" style={{ margin: 0 }}>
        Instrument PCs usually send this automatically. Ask your lab's automation contact.
      </p>
      {instruments.length === 0 ? (
        <p className="muted">Register the instrument first (New → Register instrument).</p>
      ) : (
        <ComboBox
          label="Instrument"
          items={instruments.map((i) => ({ id: i.id, name: i.name, hint: i.kind }))}
          selectedKey={instrument}
          onSelectionChange={setInstrument}
        />
      )}
      <pre aria-label="Command">{cmd}</pre>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() =>
            navigator.clipboard
              .writeText(cmd)
              .then(() => toast('Command copied', 'info'))
              .catch(() => toast("Couldn't copy. Select the command and copy it by hand.", 'error'))
          }
        >
          <Copy size={16} aria-hidden="true" /> Copy command
        </button>
      </div>
    </div>
  );
}

// RunData (SPEC-025-R26): the datasets instruments sent, and while running,
// how to send more.
export default function RunData({ run, instruments }: { run: RunDetail; instruments: Instrument[] }) {
  return (
    <section className="card" aria-labelledby="data-heading" style={{ marginBottom: 'var(--space-4)' }}>
      <div className="card-head">
        <h2 id="data-heading">Data</h2>
        {run.state === 'running' && (
          <DialogTrigger>
            <Button className="btn">
              <Send size={16} aria-hidden="true" /> Send data
            </Button>
            <Popover className="popover" placement="bottom end">
              <AriaDialog aria-label="Send data" className="dialog-plain">
                <SendData run={run} instruments={instruments} />
              </AriaDialog>
            </Popover>
          </DialogTrigger>
        )}
      </div>
      {run.datasets.length === 0 ? (
        <EmptyState
          compact
          icon={<DataArt />}
          text={
            run.state === 'running'
              ? 'No data yet. Use Send data to see how an instrument sends readings to this run.'
              : run.state === 'planned'
                ? 'Data arrives once the run is started.'
                : 'This run received no data.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Datasets produced by this run</caption>
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col" className="num">
                  Readings
                </th>
              </tr>
            </thead>
            <tbody>
              {run.datasets.map((d) => (
                <tr key={d.node_id}>
                  <td>{d.label}</td>
                  <td className="num">{d.count === null ? 'not recorded' : d.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
