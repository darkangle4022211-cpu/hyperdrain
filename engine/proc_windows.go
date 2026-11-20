//go:build windows

package engine

import (
	"fmt"
	"os"
	"os/exec"
)

func prepareProcessGroup(cmd *exec.Cmd) {
	// On Windows, child processes are attached to the current process tree
}

func killProcessGroup(p *os.Process) {
	if p != nil && p.Pid > 0 {
		// Use taskkill with /T (tree kill) and /F (force) to terminate all child processes (ffmpeg, yt-dlp, python)
		_ = exec.Command("taskkill", "/F", "/T", "/PID", fmt.Sprintf("%d", p.Pid)).Run()
		_ = p.Kill()
	}
}
