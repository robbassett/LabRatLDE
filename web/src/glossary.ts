import type { NodeKind, Relation, RunState } from './api';

// Plain-language labels for data terms (SPEC-025-R17, design §3.4). The data
// keeps its PROV and LabRat terms; the UI shows these.
export const RELATION_LABEL: Record<Relation, string> = {
  used: 'used as input',
  wasGeneratedBy: 'produced by',
  wasDerivedFrom: 'derived from',
  wasInformedBy: 'informed by',
  wasAssociatedWith: 'carried out with',
  wasAttributedTo: 'recorded by',
};

export const KIND_LABEL: Record<NodeKind, string> = {
  sample: 'Sample',
  reagent: 'Reagent',
  protocol: 'Protocol',
  run: 'Run',
  instrument: 'Instrument',
  dataset: 'Dataset',
  analysis: 'Analysis',
};

export const STATE_WORD: Record<RunState, string> = {
  planned: 'Planned',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
  signed: 'Signed',
};

export const STATE_TONE: Record<RunState, string> = {
  planned: 'muted',
  running: 'info',
  paused: 'warn',
  completed: 'ok',
  failed: 'danger',
  aborted: 'muted',
  signed: 'signed',
};

export const TERM = {
  changeSet: 'change request',
  changeSets: 'change requests',
  manifestDigest: 'record fingerprint',
  principal: 'user or service account',
  principals: 'users and service accounts',
  attrs: 'details',
  params: 'parameters',
  item: 'item',
};
