package api_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Accelerate-Biotech/LabRatLDE/internal/api"
	"github.com/Accelerate-Biotech/LabRatLDE/internal/config"
)

// SPEC-023-R01
func TestUploadDoesNotBlockAuditedWrites(t *testing.T) {
	db := openTestDB(t)
	tenant := newTenant(t, db)
	srv := httptest.NewServer(api.New(config.Config{Env: "dev", MaxIngestBytes: 1 << 20}, db, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, nil).Handler())
	defer srv.Close()
	dev := map[string]string{"X-LDE-Tenant": tenant, "X-LDE-Actor": "it@lab"}

	var inst struct {
		ID string `json:"id"`
	}
	sendWant(t, srv, "", dev, http.StatusCreated, "POST", "/v1/instruments", map[string]string{"name": "slow", "kind": "plate-reader"}, &inst)

	// An upload that has started and is still sending.
	body, sender := io.Pipe()
	defer sender.Close()
	req, err := http.NewRequest("POST", srv.URL+"/v1/instruments/"+inst.ID+"/stream", body)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range dev {
		req.Header.Set(k, v)
	}
	uploaded := make(chan int, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			uploaded <- 0
			return
		}
		resp.Body.Close()
		uploaded <- resp.StatusCode
	}()
	const reading = `{"ts":"2026-01-01T00:00:00Z","channel":"od600","value":0.5,"unit":"AU"}` + "\n"
	// The pipe is unbuffered, so a finished write means the handler's side took it:
	// the second write can't finish until the handler is reading the body.
	for range 2 {
		if _, err := sender.Write([]byte(reading)); err != nil {
			t.Fatal(err)
		}
	}

	// An audited write in the same tenant finishes while the upload is open.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	write, err := http.NewRequestWithContext(ctx, "POST", srv.URL+"/v1/instruments", strings.NewReader(`{"name":"other","kind":"plate-reader"}`))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range dev {
		write.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(write)
	if err != nil {
		t.Errorf("audited write during an upload: %v", err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Errorf("audited write during an upload = %d, want 201", resp.StatusCode)
		}
	}

	// The upload still finishes.
	sender.Close()
	if status := <-uploaded; status != http.StatusCreated {
		t.Errorf("upload = %d, want 201", status)
	}
}
