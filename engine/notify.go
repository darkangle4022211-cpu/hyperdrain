package engine

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	lastNotificationTime = make(map[string]time.Time)
	notifyMu             sync.Mutex
)

// SendUbuntuNotification triggers a native Ubuntu desktop notification via libnotify (notify-send)
func SendUbuntuNotification(title, message, urgency string) error {
	notifySend, err := exec.LookPath("notify-send")
	if err != nil {
		notifySend = "/usr/bin/notify-send"
		if _, err := os.Stat(notifySend); err != nil {
			return fmt.Errorf("notify-send not found on system: %w", err)
		}
	}

	homeDir, _ := os.UserHomeDir()
	iconPath := filepath.Join(homeDir, ".local", "share", "icons", "hyperdrain.png")
	hasIcon := false
	if _, err := os.Stat(iconPath); err == nil {
		hasIcon = true
	} else if _, err := os.Stat("/usr/share/icons/hicolor/512x512/apps/hyperdrain.png"); err == nil {
		iconPath = "/usr/share/icons/hicolor/512x512/apps/hyperdrain.png"
		hasIcon = true
	}

	if urgency == "" || urgency == "critical" {
		urgency = "normal"
	}

	args := []string{
		"-u", urgency,
	}
	if hasIcon {
		args = append(args, "-i", iconPath)
	}
	args = append(args, title, message)

	cmd := exec.Command(notifySend, args...)

	// Build environment preserving all existing variables (PATH, USER, HOME, WAYLAND_DISPLAY, etc.)
	cmdEnv := append([]string{}, os.Environ()...)
	hasDisplay := false
	hasWayland := false
	hasDbus := false
	hasXdgRuntime := false
	for _, e := range cmdEnv {
		if strings.HasPrefix(e, "DISPLAY=") {
			hasDisplay = true
		}
		if strings.HasPrefix(e, "WAYLAND_DISPLAY=") {
			hasWayland = true
		}
		if strings.HasPrefix(e, "DBUS_SESSION_BUS_ADDRESS=") {
			hasDbus = true
		}
		if strings.HasPrefix(e, "XDG_RUNTIME_DIR=") {
			hasXdgRuntime = true
		}
	}
	uid := os.Getuid()
	if !hasDisplay {
		cmdEnv = append(cmdEnv, "DISPLAY=:0")
	}
	if !hasWayland {
		cmdEnv = append(cmdEnv, "WAYLAND_DISPLAY=wayland-0")
	}
	if !hasXdgRuntime {
		cmdEnv = append(cmdEnv, fmt.Sprintf("XDG_RUNTIME_DIR=/run/user/%d", uid))
	}
	if !hasDbus {
		cmdEnv = append(cmdEnv, fmt.Sprintf("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%d/bus", uid))
	}
	cmd.Env = cmdEnv

	if err := cmd.Run(); err != nil {
		log.Printf("[NOTIFY] notify-send failed (%s): %v", title, err)
		return err
	}
	log.Printf("[NOTIFY] Notification successfully shown: %s", title)
	return nil
}

// PlayCompleteSound plays the native Ubuntu completion chime
func PlayCompleteSound() {
	if _, err := exec.LookPath("canberra-gtk-play"); err == nil {
		cmd := exec.Command("canberra-gtk-play", "-i", "complete")
		_ = cmd.Start()
		return
	}
	if _, err := exec.LookPath("paplay"); err == nil {
		for _, p := range []string{
			"/usr/share/sounds/Yaru/stereo/complete.oga",
			"/usr/share/sounds/freedesktop/stereo/complete.oga",
		} {
			if _, err := os.Stat(p); err == nil {
				cmd := exec.Command("paplay", p)
				_ = cmd.Start()
				return
			}
		}
	}
}

// PlayErrorSound plays the native Ubuntu error/warning chime
func PlayErrorSound() {
	if _, err := exec.LookPath("canberra-gtk-play"); err == nil {
		cmd := exec.Command("canberra-gtk-play", "-i", "dialog-warning")
		_ = cmd.Start()
		return
	}
	if _, err := exec.LookPath("paplay"); err == nil {
		for _, p := range []string{
			"/usr/share/sounds/Yaru/stereo/dialog-warning.oga",
			"/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
			"/usr/share/sounds/Yaru/stereo/dialog-error.oga",
		} {
			if _, err := os.Stat(p); err == nil {
				cmd := exec.Command("paplay", p)
				_ = cmd.Start()
				return
			}
		}
	}
}

// NotifyDownloadStarted alerts the user when a download commences
func NotifyDownloadStarted(fileName string, connections int) {
	notifyMu.Lock()
	key := "started_" + fileName
	lastTime, exists := lastNotificationTime[key]
	if exists && time.Since(lastTime) < 10*time.Second {
		notifyMu.Unlock()
		return
	}
	lastNotificationTime[key] = time.Now()
	notifyMu.Unlock()

	title := "HyperDrain ⚡ Download Started"
	body := fmt.Sprintf("File: %s\nAccelerated with %d connections.", fileName, connections)
	if connections <= 1 {
		body = fmt.Sprintf("File: %s\nDownloading...", fileName)
	}
	go func() {
		_ = SendUbuntuNotification(title, body, "normal")
	}()
}

// NotifyDownloadStopped sends a native desktop notification when a download stops midway.
// Sound is NOT played here — only the system notification sound from notify-send.
func NotifyDownloadStopped(fileName, reason string) {
	notifyMu.Lock()
	key := "stopped_" + fileName
	lastTime, exists := lastNotificationTime[key]
	if exists && time.Since(lastTime) < 10*time.Second {
		notifyMu.Unlock()
		return
	}
	lastNotificationTime[key] = time.Now()
	notifyMu.Unlock()

	cleanReason := reason
	if strings.Contains(cleanReason, "lookup") || strings.Contains(cleanReason, "dial tcp") || strings.Contains(cleanReason, "i/o timeout") || strings.Contains(cleanReason, "connection refused") {
		cleanReason = "Internet connection dropped or DNS unreachable."
	} else if strings.Contains(cleanReason, "connection reset") || strings.Contains(cleanReason, "broken pipe") {
		cleanReason = "Connection reset by server midway."
	} else if len(cleanReason) > 100 {
		cleanReason = cleanReason[:97] + "..."
	}
	if cleanReason == "" {
		cleanReason = "Download interrupted or stopped midway."
	}

	title := "HyperDrain ⚠️ Download Stopped Midway"
	body := fmt.Sprintf("File: %s\nError: %s", fileName, cleanReason)
	log.Printf("[NOTIFY] Download stopped: %s (%s)", fileName, cleanReason)
	go func() {
		_ = SendUbuntuNotification(title, body, "normal")
	}()
}

// NotifyDownloadStalled sends a native desktop notification when a download stalls.
func NotifyDownloadStalled(fileName string, secondsWithoutData int) {
	notifyMu.Lock()
	key := "stalled_" + fileName
	lastTime, exists := lastNotificationTime[key]
	if exists && time.Since(lastTime) < 1*time.Minute {
		notifyMu.Unlock()
		return
	}
	lastNotificationTime[key] = time.Now()
	notifyMu.Unlock()

	title := "HyperDrain ⚠️ Download Stalled"
	body := fmt.Sprintf("File: %s has stalled.\nNo data received for %d seconds.", fileName, secondsWithoutData)
	log.Printf("[NOTIFY] Download stalled: %s (%ds without data)", fileName, secondsWithoutData)
	go func() {
		_ = SendUbuntuNotification(title, body, "normal")
	}()
}

// NotifyDownloadComplete sends a native desktop notification when a download completes.
// No extra sound is played — only the system notification sound from notify-send.
func NotifyDownloadComplete(fileName, fileSize string) {
	log.Printf("[NOTIFY] Download complete: %s (%s)", fileName, fileSize)
	title := "HyperDrain ⚡ Download Complete"
	body := fmt.Sprintf("File: %s (%s)\nSaved to disk successfully.", fileName, fileSize)
	go func() {
		_ = SendUbuntuNotification(title, body, "normal")
	}()
}

// NotifyBatchComplete sends a native desktop notification when an entire series batch has completed and/or zipped.
func NotifyBatchComplete(seriesTitle, details string) {
	log.Printf("[NOTIFY] Batch complete: %s (%s)", seriesTitle, details)
	title := "HyperDrain ⚡ Batch Download Complete"
	body := fmt.Sprintf("Series: %s\n%s", seriesTitle, details)
	go func() {
		_ = SendUbuntuNotification(title, body, "normal")
		PlayCompleteSound()
	}()
}

func FormatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
