//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Chromium-based browsers with an --app (chromeless window) mode, in order
// of preference; Firefox has no app mode and is reached via the fallback.
var appBrowsers = []string{
	"chromium", "chromium-browser", "google-chrome-stable", "google-chrome",
	"brave-browser", "brave", "microsoft-edge-stable", "microsoft-edge", "vivaldi-stable",
}

func openAppWindow(url string) error {
	if custom := os.Getenv("AUDIOSPACE_BROWSER"); custom != "" {
		fields := strings.Fields(custom)
		return start(exec.Command(fields[0], append(fields[1:], url)...))
	}
	if runtime.GOOS == "darwin" {
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"} {
			if _, err := os.Stat("/Applications/" + app + ".app"); err == nil {
				return start(exec.Command("open", "-na", app, "--args", "--app="+url))
			}
		}
		return start(exec.Command("open", url))
	}
	for _, b := range appBrowsers {
		if path, err := exec.LookPath(b); err == nil {
			return start(exec.Command(path, "--app="+url, "--new-window"))
		}
	}
	for _, opener := range []string{"xdg-open", "gio", "sensible-browser"} {
		if path, err := exec.LookPath(opener); err == nil {
			args := []string{url}
			if opener == "gio" {
				args = []string{"open", url}
			}
			return start(exec.Command(path, args...))
		}
	}
	return errors.New("no browser found; set AUDIOSPACE_BROWSER or open the URL manually")
}

func start(cmd *exec.Cmd) error {
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait() //nolint:errcheck // reap; the browser outlives us
	return nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "AudioSpace:", err)
	os.Exit(1)
}
