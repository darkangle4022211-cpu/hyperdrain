//go:build !windows

package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// PreallocateFile attempts instant fallocate to reserve disk space and eliminate fragmentation.
// If the target filesystem (such as external NTFS/FAT) does not support fallocate, it falls back to Truncate.
func PreallocateFile(file *os.File, size int64) error {
	if size <= 0 {
		return nil
	}

	// 1. Try Linux native fallocate (mode 0 = allocate and zero-fill blocks via filesystem)
	err := syscall.Fallocate(int(file.Fd()), 0, 0, size)
	if err == nil {
		return nil
	}

	// 2. Fallback to Truncate for filesystems lacking fallocate (e.g. NTFS-3g, exFAT)
	if err == syscall.EOPNOTSUPP || err == syscall.ENOSYS {
		return file.Truncate(size)
	}

	return fmt.Errorf("fallocate failed: %w", err)
}

// GetDiskFreeSpace returns the available free disk space in bytes for the given filesystem path.
func GetDiskFreeSpace(path string) (uint64, error) {
	var stat syscall.Statfs_t
	err := syscall.Statfs(path, &stat)
	if err != nil {
		return 0, err
	}
	// Available blocks * block size
	return stat.Bavail * uint64(stat.Bsize), nil
}

// GetAvailableSpaceForPath returns available free disk space for any target file or directory path,
// walking up to the nearest existing directory or mount point.
func GetAvailableSpaceForPath(targetPath string) (uint64, error) {
	cleanPath := filepath.Clean(targetPath)
	dir := cleanPath
	for {
		fi, err := os.Stat(dir)
		if err == nil {
			if fi.IsDir() {
				return GetDiskFreeSpace(dir)
			}
			return GetDiskFreeSpace(filepath.Dir(dir))
		}
		parent := filepath.Dir(dir)
		if parent == dir || parent == "" || parent == "." {
			break
		}
		dir = parent
	}
	// Fallback to home dir or current working dir
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if free, err := GetDiskFreeSpace(home); err == nil {
			return free, nil
		}
	}
	return GetDiskFreeSpace(".")
}

