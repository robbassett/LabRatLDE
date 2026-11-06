package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// RunState is a stage in an experiment run's lifecycle.
//
//	planned ──► running ◄──► paused
//	running ──► completed | failed ──► signed
//	planned | running | paused ──► aborted
//
// Signing happens only through the signatures endpoint, and only a committed
// correction returns a signed run to completed or failed (SPEC-008).
type RunState string

const (
	RunPlanned   RunState = "planned"
	RunRunning   RunState = "running"
	RunPaused    RunState = "paused"
	RunCompleted RunState = "completed"
	RunFailed    RunState = "failed"
	RunAborted   RunState = "aborted"
	RunSigned    RunState = "signed"
)

var runTransitions = map[RunState][]RunState{
	RunPlanned:   {RunRunning, RunAborted},
	RunRunning:   {RunPaused, RunCompleted, RunFailed, RunAborted},
	RunPaused:    {RunRunning, RunAborted},
	RunCompleted: {RunSigned},
	RunFailed:    {RunSigned},
}

var ErrInvalidTransition = errors.New("run: invalid state transition")

func (s RunState) Valid() bool {
	_, ok := runTransitions[s]
	return ok || s == RunAborted || s == RunSigned
}

// Terminal reports whether no further transitions are possible. Only a
// committed correction reopens a signed run (SPEC-008-R10), and the database
// does that, not a transition.
func (s RunState) Terminal() bool { return len(runTransitions[s]) == 0 }

// CanTransition validates a move from s to next.
func (s RunState) CanTransition(next RunState) error {
	for _, allowed := range runTransitions[s] {
		if allowed == next {
			return nil
		}
	}
	return fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, s, next)
}

// Run is a single execution of an experiment protocol.
type Run struct {
	ID                string          `json:"id"`
	TenantID          string          `json:"tenant_id"`
	ExperimentID      string          `json:"experiment_id"`
	ProtocolVersionID string          `json:"protocol_version_id"` // pinned at creation, never changed
	NodeID            string          `json:"node_id"`             // this run's vertex in the lineage graph
	State             RunState        `json:"state"`
	Params            json.RawMessage `json:"params"`
	SigningPolicy     json.RawMessage `json:"signing_policy"` // copied from the experiment at creation
	Signatures        []Signature     `json:"signatures"`     // never null; the API fills it
	StartedAt         *time.Time      `json:"started_at,omitempty"`
	FinishedAt        *time.Time      `json:"finished_at,omitempty"`
	CreatedBy         string          `json:"created_by"`
	CreatedAt         time.Time       `json:"created_at"`
	// ParamsSchemaVersionID is the schema the pinned protocol version checks params against, if any.
	ParamsSchemaVersionID *string `json:"params_schema_version_id,omitempty"`
}

// Signature is a signature's JSON (SPEC-008-R12). It is valid until a
// committed correction invalidates it.
type Signature struct {
	ID                     string     `json:"id"`
	Step                   int        `json:"step"`
	Meaning                string     `json:"meaning"`
	Signer                 string     `json:"signer"`
	PrintedName            string     `json:"printed_name"`
	SignedAt               time.Time  `json:"signed_at"`
	ManifestSHA256         string     `json:"manifest_sha256"`
	Comment                *string    `json:"comment"`
	ReauthMethod           string     `json:"reauth_method"`
	Valid                  bool       `json:"valid"`
	InvalidatedAt          *time.Time `json:"invalidated_at"`
	InvalidatedByChangeSet *string    `json:"invalidated_by_change_set"`
	InvalidatedReason      *string    `json:"invalidated_reason"`
}

// Apply moves the run to next, stamping lifecycle timestamps. Aborting and
// signing require a reason; for signing it is the §11.50 signature meaning.
func (r *Run) Apply(next RunState, reason string, at time.Time) error {
	if err := r.State.CanTransition(next); err != nil {
		return err
	}
	if (next == RunSigned || next == RunAborted) && strings.TrimSpace(reason) == "" {
		return fmt.Errorf("%w: %s requires a reason", ErrInvalidTransition, next)
	}
	if next == RunRunning && r.StartedAt == nil {
		r.StartedAt = &at
	}
	if next == RunCompleted || next == RunFailed || next == RunAborted {
		r.FinishedAt = &at
	}
	r.State = next
	return nil
}
