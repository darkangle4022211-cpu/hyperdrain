package engine

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetAvailableSpaceForPath(t *testing.T) {
	// 1. Current working directory
	space, err := GetAvailableSpaceForPath(".")
	if err != nil {
		t.Fatalf("GetAvailableSpaceForPath(.) failed: %v", err)
	}
	if space == 0 {
		t.Errorf("Available space for current directory reported 0 bytes")
	}

	// 2. Non-existent subpath on real directory
	tmpDir := os.TempDir()
	nonExistentPath := filepath.Join(tmpDir, "hyperdrain_test_sub", "deep_dir", "test_file.bin")
	spaceNonExistent, err := GetAvailableSpaceForPath(nonExistentPath)
	if err != nil {
		t.Fatalf("GetAvailableSpaceForPath for non-existent path failed: %v", err)
	}
	if spaceNonExistent == 0 {
		t.Errorf("Available space for non-existent subpath reported 0 bytes")
	}

	// 3. Verify FormatBytes
	if fb := FormatBytes(1024 * 1024 * 500); fb != "500.00 MB" {
		t.Errorf("Expected 500.00 MB, got %s", fb)
	}
	if fb := FormatBytes(1024 * 1024 * 1024 * 32); fb != "32.00 GB" {
		t.Errorf("Expected 32.00 GB, got %s", fb)
	}
}
