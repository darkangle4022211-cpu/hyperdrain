//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

func setupSignalHandler() chan os.Signal {
	signal.Ignore(syscall.SIGHUP)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	return sigChan
}
