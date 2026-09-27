package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Explicit content types: on Windows, Go's mime package consults the
// registry, which some installers corrupt (e.g. .js → text/plain), and
// browsers refuse to run ES modules served with the wrong type.
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".ico":         "image/x-icon",
	".wasm":        "application/wasm",
	".txt":         "text/plain; charset=utf-8",
}

const clientScript = `// Injected by the AudioSpace desktop launcher: lets the launcher know a
// window is still open, so it can exit once the last one closes.
(function () {
  var beat = function () {
    fetch('/__desktop/heartbeat', { method: 'POST', cache: 'no-store', keepalive: true }).catch(function () {});
  };
  beat();
  setInterval(beat, 15000);
  document.addEventListener('visibilitychange', beat);
})();
`

// Server serves the embedded web app on the loopback interface.
type Server struct {
	files   fs.FS
	version string
	port    int

	mu        sync.Mutex
	lastBeat  time.Time
	beatCount int
}

func NewServer(files fs.FS, version string, port int) *Server {
	return &Server{files: files, version: version, port: port}
}

// LastHeartbeat returns the time of the most recent heartbeat and how many
// have been received.
func (s *Server) LastHeartbeat() (time.Time, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastBeat, s.beatCount
}

// allowedHost guards against DNS rebinding: only loopback host names with
// our port may talk to the server.
func (s *Server) allowedHost(host string) bool {
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		return false
	}
	if p != strconv.Itoa(s.port) {
		return false
	}
	switch strings.ToLower(h) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.allowedHost(r.Host) {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Referrer-Policy", "no-referrer")

	switch r.URL.Path {
	case "/__desktop/ping":
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"app": "audiospace", "version": s.version})
		return
	case "/__desktop/heartbeat":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.mu.Lock()
		s.lastBeat = time.Now()
		s.beatCount++
		s.mu.Unlock()
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	case "/__desktop/client.js":
		h.Set("Content-Type", contentTypes[".js"])
		h.Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte(clientScript))
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := path.Clean("/" + r.URL.Path)
	if strings.HasSuffix(r.URL.Path, "/") {
		name = path.Join(name, "index.html")
	}
	name = strings.TrimPrefix(name, "/")
	data, err := fs.ReadFile(s.files, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(path.Ext(name))
	if name == "index.html" {
		data = injectClient(data)
	}
	if ct, ok := contentTypes[ext]; ok {
		h.Set("Content-Type", ct)
	} else {
		h.Set("Content-Type", "application/octet-stream")
	}
	// Revalidate every load so an updated installation is picked up at once.
	h.Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, name, buildTime, bytes.NewReader(data))
}

// buildTime is used as Last-Modified for the embedded files.
var buildTime = time.Now()

func injectClient(html []byte) []byte {
	tag := []byte(`<script src="/__desktop/client.js"></script>`)
	i := bytes.Index(bytes.ToLower(html), []byte("</head>"))
	if i < 0 {
		return append(html, tag...)
	}
	out := make([]byte, 0, len(html)+len(tag)+1)
	out = append(out, html[:i]...)
	out = append(out, tag...)
	out = append(out, '\n')
	out = append(out, html[i:]...)
	return out
}
