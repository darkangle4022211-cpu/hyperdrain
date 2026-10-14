//go:build !windows

package engine

import (
	"fmt"
	"os"
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
