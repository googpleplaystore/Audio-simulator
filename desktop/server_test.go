package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testServer() *Server {
	files := fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><html><head><title>x</title></head><body></body></html>")},
		"src/main.js":          {Data: []byte("export {};")},
		"css/base.css":         {Data: []byte("body{}")},
		"manifest.webmanifest": {Data: []byte("{}")},
	}
	return NewServer(files, "9.9.9", 47810)
}

func get(t *testing.T, s *Server, method, target, host string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestServesEmbeddedFilesWithCorrectTypes(t *testing.T) {
	s := testServer()
	cases := map[string]string{
		"/src/main.js":          "text/javascript; charset=utf-8",
		"/css/base.css":         "text/css; charset=utf-8",
		"/manifest.webmanifest": "application/manifest+json",
		"/":                     "text/html; charset=utf-8",
	}
	for path, want := range cases {
		rec := get(t, s, http.MethodGet, path, "127.0.0.1:47810")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", path, rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != want {
			t.Errorf("%s: content type %q, want %q", path, got, want)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing nosniff", path)
		}
	}
}

func TestIndexGetsHeartbeatClient(t *testing.T) {
	s := testServer()
	body := get(t, s, http.MethodGet, "/", "localhost:47810").Body.String()
	i := strings.Index(body, `<script src="/__desktop/client.js"></script>`)
	if i < 0 || i > strings.Index(body, "</head>") {
		t.Fatalf("client script not injected into <head>: %s", body)
	}
	js := get(t, s, http.MethodGet, "/__desktop/client.js", "localhost:47810")
	if !strings.Contains(js.Body.String(), "/__desktop/heartbeat") {
		t.Fatal("client script does not send heartbeats")
	}
}

func TestRejectsForeignHosts(t *testing.T) {
	s := testServer()
	for _, host := range []string{"evil.example:47810", "127.0.0.1:1234", "192.168.1.5:47810", "127.0.0.1"} {
		if rec := get(t, s, http.MethodGet, "/", host); rec.Code != http.StatusForbidden {
			t.Errorf("host %q: status %d, want 403", host, rec.Code)
		}
	}
	for _, host := range []string{"127.0.0.1:47810", "localhost:47810", "[::1]:47810"} {
		if rec := get(t, s, http.MethodGet, "/", host); rec.Code != http.StatusOK {
			t.Errorf("host %q: status %d, want 200", host, rec.Code)
		}
	}
}

func TestNoPathTraversalOrUnknownFiles(t *testing.T) {
	s := testServer()
	for _, p := range []string{"/../main.go", "/%2e%2e/main.go", "/nope.js", "/src/../../etc/passwd"} {
		if rec := get(t, s, http.MethodGet, p, "127.0.0.1:47810"); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", p, rec.Code)
		}
	}
	if rec := get(t, s, http.MethodPost, "/src/main.js", "127.0.0.1:47810"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST to a file: status %d", rec.Code)
	}
}

func TestPingAndHeartbeat(t *testing.T) {
	s := testServer()
	rec := get(t, s, http.MethodGet, "/__desktop/ping", "127.0.0.1:47810")
	var info map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&info); err != nil || info["app"] != "audiospace" || info["version"] != "9.9.9" {
		t.Fatalf("ping: %v %v", info, err)
	}
	if _, n := s.LastHeartbeat(); n != 0 {
		t.Fatal("no heartbeat yet")
	}
	if rec := get(t, s, http.MethodGet, "/__desktop/heartbeat", "127.0.0.1:47810"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET heartbeat: %d", rec.Code)
	}
	if rec := get(t, s, http.MethodPost, "/__desktop/heartbeat", "127.0.0.1:47810"); rec.Code != http.StatusNoContent {
		t.Fatalf("POST heartbeat: %d", rec.Code)
	}
	if last, n := s.LastHeartbeat(); n != 1 || time.Since(last) > time.Second {
		t.Fatalf("heartbeat not recorded: %v %d", last, n)
	}
}

func TestIdleShutdownPolicy(t *testing.T) {
	s := testServer()
	start := time.Now()
	if shouldExit(s, start, start.Add(time.Minute)) {
		t.Fatal("must wait for the first window")
	}
	if !shouldExit(s, start, start.Add(startGrace+time.Second)) {
		t.Fatal("must exit when no window ever connects")
	}
	get(t, s, http.MethodPost, "/__desktop/heartbeat", "127.0.0.1:47810")
	now := time.Now()
	if shouldExit(s, start, now.Add(idleAfter-time.Second)) {
		t.Fatal("must keep running while windows send heartbeats")
	}
	if !shouldExit(s, start, now.Add(idleAfter+time.Second)) {
		t.Fatal("must exit after the last window closed")
	}
}

func TestRunningInstanceDetection(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__desktop/ping" {
			_, _ = w.Write([]byte(`{"app":"audiospace","version":"1"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()
	if _, ok := runningInstance(portOf(t, ts)); !ok {
		t.Fatal("did not detect a running instance")
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("hello")) }))
	defer other.Close()
	if _, ok := runningInstance(portOf(t, other)); ok {
		t.Fatal("a foreign server must not be mistaken for AudioSpace")
	}
}

func portOf(t *testing.T, ts *httptest.Server) int {
	t.Helper()
	_, p, err := net.SplitHostPort(ts.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		t.Fatal(err)
	}
	return n
}
