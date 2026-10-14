//go:build !windows

package engine

import (
	"os"
	"os/exec"
	"syscall"
)

func prepareProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessGroup(p *os.Process) {
	if p != nil && p.Pid > 0 {
		_ = syscall.Kill(-p.Pid, syscall.SIGKILL)
	}
}
