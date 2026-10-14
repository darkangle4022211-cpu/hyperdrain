//go:build windows

package engine

import (
	"os"
	"os/exec"
)

func prepareProcessGroup(cmd *exec.Cmd) {
	// Process groups on Windows are managed via job objects or direct process kill
}

func killProcessGroup(p *os.Process) {
	if p != nil {
		_ = p.Kill()
	}
}
