import { Copy, Send } from 'lucide-react';
import { useState } from 'react';
import { streamAuthHeaders, type Instrument, type RunDetail } from './api';
import EmptyState from './EmptyState';
import Field from './Field';
import { DataArt } from './illustrations';
import { toast } from './Toasts';
import { ComboBox, Dialog } from './ui';

// sendCommand builds a one-line curl command for this run (design §3.6). One line and double
// quotes only, so it pastes unchanged into Git Bash, macOS and Linux shells, PowerShell and cmd.
export function sendCommand(o: { origin: string; instrumentId: string; runId: string; label: string; file: string; headers: string[] }): string {
  const url = `${o.origin}/v1/instruments/${o.instrumentId}/stream?run_id=${o.runId}&label=${encodeURIComponent(o.label)}`;
  const headers = ['Content-Type: application/x-ndjson', ...o.headers].map((h) => `-H "${h}"`).join(' ');
  return `curl --data-binary "@${o.file}" ${headers} "${url}"`;
}

const EXAMPLE_LINE = '{"ts":"2026-11-06T09:30:00Z","channel":"UV_254nm","value":0.0012,"unit":"AU"}';

function copy(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${what} copied`, 'info'))
    .catch(() => toast(`Couldn't copy. Select the ${what.toLowerCase()} and copy it by hand.`, 'error'));
}

function SendData({ run, instruments, onDone }: { run: RunDetail; instruments: Instrument[]; onDone: () => void }) {
  const [instrument, setInstrument] = useState<string | null>(instruments.length === 1 ? instruments[0].id : null);
  const [label, setLabel] = useState('Readings 1');
  const [file, setFile] = useState('readings.ndjson');
  const auth = streamAuthHeaders();
  const ready = instrument !== null && label.trim() !== '' && file.trim() !== '';
  const cmd = sendCommand({
    origin: location.origin,
    instrumentId: instrument ?? 'INSTRUMENT_ID',
    runId: run.id,
    label: label.trim(),
    file: file.trim(),
    headers: auth.headers,
  });
  return (
    <div className="send-data">
      <p className="muted">
        Instrument PCs usually send readings automatically; ask your lab's automation contact. To send a file by hand: fill in the
        fields, copy the command, and run it in a terminal opened in the folder that holds the file.
      </p>
      {instruments.length === 0 ? (
        <p className="field-error">Register the instrument first: New → Register instrument.</p>
      ) : (
        <ComboBox
          label="Instrument"
          items={instruments.map((i) => ({ id: i.id, name: i.name, hint: i.kind }))}
          selectedKey={instrument}
          onSelectionChange={setInstrument}
        />
      )}
      <div className="field-row">
        <Field label="Dataset label" hint="How these readings appear in the Data list.">
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="File" hint="Path from the terminal's folder; one JSON reading per line.">
          <input className="mono" value={file} onChange={(e) => setFile(e.target.value)} />
        </Field>
      </div>
      <div>
        <p className="field-label" id="send-cmd-label">
          Command
        </p>
        <pre aria-labelledby="send-cmd-label">{cmd}</pre>
        {auth.needsToken ? (
          <p className="field-hint">Replace YOUR_TOKEN with a service account token from your administrator.</p>
        ) : (
          <p className="field-hint">Signed in to a development server: the command sends as you ({auth.headers[1].split(': ')[1]}).</p>
        )}
        <p className="field-hint">In Windows PowerShell type curl.exe instead of curl.</p>
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => copy(cmd, 'Command')}>
          <Copy size={16} aria-hidden="true" /> Copy command
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Done, show new data
        </button>
        {!instrument && instruments.length > 0 && <span className="muted">Choose an instrument first.</span>}
      </div>
      <details>
        <summary className="field-label" style={{ cursor: 'pointer' }}>
          What goes in the file
        </summary>
        <p className="field-hint">Each line is one reading: a time, a channel, a value and a unit. For example:</p>
        <pre>{EXAMPLE_LINE}</pre>
      </details>
    </div>
  );
}

// RunData (SPEC-025-R26): the datasets instruments sent, and while running,
// how to send more.
export default function RunData({ run, instruments, onChanged }: { run: RunDetail; instruments: Instrument[]; onChanged: () => void }) {
  const [sending, setSending] = useState(false);
  return (
    <section className="card" aria-labelledby="data-heading" style={{ marginBottom: 'var(--space-4)' }}>
      <div className="card-head">
        <h2 id="data-heading">Data</h2>
        {run.state === 'running' && (
          <button type="button" className="btn" onClick={() => setSending(true)}>
            <Send size={16} aria-hidden="true" /> Send data
          </button>
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
      <Dialog title="Send readings to this run" isOpen={sending} onClose={() => setSending(false)} wide>
        <SendData
          run={run}
          instruments={instruments}
          onDone={() => {
            setSending(false);
            onChanged();
          }}
        />
      </Dialog>
    </section>
  );
}
