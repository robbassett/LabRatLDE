import { useEffect, useState } from 'react';
import { getExperiment, type Experiment, type ExperimentSummary } from './api';
import EmptyState from './EmptyState';
import ErrorMessage from './ErrorMessage';
import { openNew } from './events';
import Field from './Field';
import NewRunForm from './NewRunForm';
import type { Tab } from './tabs';
import { Dialog } from './ui';

// NewRunDialog (design §3.3): pick the experiment, then plan the run with NewRunForm.
export default function NewRunDialog({
  isOpen,
  onClose,
  open,
  experiments,
  experimentId,
}: {
  isOpen: boolean;
  onClose: () => void;
  open: (t: Tab) => void;
  experiments: ExperimentSummary[];
  experimentId?: string;
}) {
  const [picked, setPicked] = useState(experimentId ?? '');
  const [exp, setExp] = useState<Experiment | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (isOpen) setPicked(experimentId ?? (experiments.length === 1 ? experiments[0].id : ''));
  }, [isOpen, experimentId, experiments]);

  useEffect(() => {
    setExp(null);
    setError(null);
    if (!picked) return;
    let live = true;
    getExperiment(picked)
      .then((e) => live && setExp(e))
      .catch((err: unknown) => live && setError(err));
    return () => {
      live = false;
    };
  }, [picked]);

  return (
    <Dialog title="Plan a run" isOpen={isOpen} onClose={onClose} wide>
      {experiments.length === 0 ? (
        <EmptyState
          text="A run belongs to an experiment. Create the experiment first."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onClose();
                openNew('experiment');
              }}
            >
              New experiment
            </button>
          }
        />
      ) : (
        <>
          <Field label="Experiment">
            <select value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Choose an experiment…</option>
              {experiments.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title} ({x.slug})
                </option>
              ))}
            </select>
          </Field>
          <ErrorMessage error={error} action="load the experiment" />
          {picked && !exp && !error && <p className="muted">Loading the protocol…</p>}
          {exp && <NewRunForm key={exp.id} exp={exp} open={open} onCreated={onClose} />}
        </>
      )}
    </Dialog>
  );
}
