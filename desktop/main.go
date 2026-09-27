// AudioSpace desktop launcher.
//
// A single self-contained executable: the complete web app is embedded and
// served on the loopback interface, then opened in a chromeless browser app
// window (Edge/Chrome/Chromium), falling back to the default browser. The
// port is fixed so the origin — and with it the browser's IndexedDB music
// library and settings — stays the same from one launch to the next. The
// launcher exits by itself shortly after the last window has closed.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

//go:embed all:webapp
var embedded embed.FS

// Set at build time with -ldflags "-X main.version=…".
var version = "dev"

const (
	basePort   = 47810
	portTries  = 10
	startGrace = 3 * time.Minute   // time for the first window to connect
	idleAfter  = 150 * time.Second // background tabs may throttle heartbeats to 1/min
)

func main() {
	var (
		port        = flag.Int("port", 0, "port to serve on (default: first free port from 47810)")
		noBrowser   = flag.Bool("no-browser", false, "only run the server; do not open a window (keeps running)")
		keepRunning = flag.Bool("keep-running", false, "do not exit when the last window closes")
		showVersion = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()
	if *showVersion {
		fmt.Println("AudioSpace", version)
		return
	}
	if err := run(*port, *noBrowser, *keepRunning || *noBrowser); err != nil {
		fatal(err)
	}
}

func webFiles() (fs.FS, error) {
	sub, err := fs.Sub(embedded, "webapp")
	if err != nil {
		return nil, err
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, errors.New("this build does not contain the web app (run packaging/stage-webapp.sh before go build)")
	}
	return sub, nil
}

func run(fixedPort int, noBrowser, keepRunning bool) error {
	files, err := webFiles()
	if err != nil {
		return err
	}
	ports := []int{fixedPort}
	if fixedPort == 0 {
		ports = ports[:0]
		for i := 0; i < portTries; i++ {
			ports = append(ports, basePort+i)
		}
	}
	var ln net.Listener
	var port int
	for _, p := range ports {
		if url, ok := runningInstance(p); ok {
			// Already running: just open another window onto it.
			if noBrowser {
				fmt.Println("AudioSpace is already running at", url)
				return nil
			}
			return openAppWindow(url)
		}
		l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			ln, port = l, p
			break
		}
	}
	if ln == nil {
		return fmt.Errorf("no free port in %d–%d; close the program using them or start with --port", ports[0], ports[len(ports)-1])
	}
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/"
	srv := NewServer(files, version, port)
	httpSrv := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- httpSrv.Serve(ln) }()
	fmt.Println("AudioSpace", version, "serving at", url)

	if !noBrowser {
		if err := openAppWindow(url); err != nil {
			fmt.Fprintln(os.Stderr, "could not open a browser window:", err)
			fmt.Println("Open", url, "in Chrome, Edge or Firefox.")
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	idle := make(chan struct{})
	if !keepRunning {
		go watchIdle(srv, time.Now(), idle)
	}
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-sig:
	case <-idle:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return httpSrv.Shutdown(ctx)
}

// watchIdle closes done once no window has sent a heartbeat for idleAfter
// (or none connected within startGrace).
func watchIdle(srv *Server, started time.Time, done chan<- struct{}) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for range t.C {
		if shouldExit(srv, started, time.Now()) {
			close(done)
			return
		}
	}
}

func shouldExit(srv *Server, started, now time.Time) bool {
	last, n := srv.LastHeartbeat()
	if n == 0 {
		return now.Sub(started) > startGrace
	}
	return now.Sub(last) > idleAfter
}

// runningInstance reports whether an AudioSpace launcher already serves on port.
func runningInstance(port int) (string, bool) {
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/"
	client := &http.Client{Timeout: 700 * time.Millisecond}
	resp, err := client.Get(url + "__desktop/ping")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var info struct {
		App string `json:"app"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&info) != nil || info.App != "audiospace" {
		return "", false
	}
	return url, true
}
