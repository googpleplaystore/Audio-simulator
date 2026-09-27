//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Chromium-based browsers that support --app (chromeless window). Edge ships
// with every Windows 10/11 installation.
func browserCandidates() []string {
	var out []string
	roots := []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")}
	rel := []string{
		`Microsoft\Edge\Application\msedge.exe`,
		`Google\Chrome\Application\chrome.exe`,
		`BraveSoftware\Brave-Browser\Application\brave.exe`,
		`Chromium\Application\chrome.exe`,
	}
	for _, r := range rel {
		for _, root := range roots {
			if root != "" {
				out = append(out, filepath.Join(root, r))
			}
		}
	}
	return out
}

func openAppWindow(url string) error {
	if custom := os.Getenv("AUDIOSPACE_BROWSER"); custom != "" {
		return exec.Command(custom, url).Start()
	}
	for _, exe := range browserCandidates() {
		if st, err := os.Stat(exe); err == nil && !st.IsDir() {
			cmd := exec.Command(exe, "--app="+url, "--new-window")
			if err := cmd.Start(); err == nil {
				go cmd.Wait() //nolint:errcheck // reap; the browser outlives us
				return nil
			}
		}
	}
	// Default browser.
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	if err := cmd.Start(); err != nil {
		return errors.New("no browser found: " + err.Error())
	}
	go cmd.Wait() //nolint:errcheck
	return nil
}

// fatal reports an error in a message box (the GUI build has no console).
func fatal(err error) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	title, _ := syscall.UTF16PtrFromString("AudioSpace")
	text, _ := syscall.UTF16PtrFromString("AudioSpace could not start:\n\n" + err.Error())
	const mbIconError = 0x10
	_, _, _ = box.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), mbIconError)
	os.Exit(1)
}
