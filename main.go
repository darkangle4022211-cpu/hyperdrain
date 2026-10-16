package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"hyperdrain/engine"
)

const (
	DefaultPort  = "6880"
	DefaultToken = "hyperdrain_secret_token"
)

func main() {
	homeDir, _ := os.UserHomeDir()
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		if homeDir != "" {
			configDir = filepath.Join(homeDir, ".config")
		} else {
			configDir = "."
		}
	}
	appDataDir := filepath.Join(configDir, "hyperdrain")
	if customDir := os.Getenv("HYPERDRAIN_DATA_DIR"); customDir != "" {
		appDataDir = customDir
	}
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		appDataDir = "."
	}

	downloadDir := filepath.Join(homeDir, "Downloads")
	if homeDir == "" {
		downloadDir = appDataDir
	}
	webUIDir := resolveWebUIDir()

	// Ensure desktop integration (only for standalone/portable mode, not deb package)
	ensureDesktopIntegration(appDataDir)

	// 1. Initialize SQLite WAL Database in user config dir (guaranteed writable)
	db, err := engine.InitDB(appDataDir)
	if err != nil {
		log.Fatalf("[HyperDrain] Failed to initialize SQLite database: %v", err)
	}

	// 2. Load engine settings
	settings := &engine.EngineSettings{
		DownloadDir:        downloadDir,
		DefaultConnections: 16,
		MaxConcurrentTasks: 2,
		AutoExtract:        false,
		AuthToken:          DefaultToken,
	}
	savedDir := db.GetSetting("download_dir", "")
	if savedDir != "" {
		healedDir := resolveExistingDir(savedDir, downloadDir)
		settings.DownloadDir = healedDir
		if healedDir != savedDir {
			db.SetSetting("download_dir", healedDir)
			fmt.Printf("[HyperDrain] Auto-healed deleted/unmounted download directory: '%s' -> '%s'\n", savedDir, healedDir)
		}
	}

	fmt.Println("=========================================================")
	fmt.Println(" ⚡ HyperDrain — 32GB High-Speed Resilient Downloader ⚡")
	fmt.Println("=========================================================")
	fmt.Printf("[HyperDrain] Target Download Dir : %s\n", settings.DownloadDir)
	fmt.Printf("[HyperDrain] Local Server Port   : %s\n", DefaultPort)
	fmt.Println("[HyperDrain] Zero Web Hosting    : 100% Localhost Engine")

	// 3. Initialize Download Engine
	downEngine := engine.NewDownloadEngine(db, settings)

	// 4. Restore existing tasks from database
	tasks, err := db.LoadTasks()
	if err == nil {
		fmt.Printf("[HyperDrain] Restored %d saved download tasks from database\n", len(tasks))
		for _, t := range tasks {
			if t.Status == engine.StatusDownloading {
				t.Status = engine.StatusPaused // Pause on startup for user safety
			}
		}
		downEngine.RestoreTasks(tasks)
	}

	// 5. Initialize Server & Register Routes
	server := engine.NewServer(downEngine, db, settings)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux, webUIDir)

	// 6. Start Local HTTP & WebSocket Server
	activePort := DefaultPort
	if p := os.Getenv("HYPERDRAIN_PORT"); p != "" {
		activePort = p
	}
	serverAddr := "127.0.0.1:" + activePort
	httpServer := &http.Server{
		Addr:    serverAddr,
		Handler: mux,
	}

	go func() {
		fmt.Printf("[HyperDrain] Telemetry and API active at http://%s\n", serverAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[HyperDrain] Server error: %v", err)
		}
	}()

	// 7. Check if running in headless / daemon mode
	noWindow := false
	for _, arg := range os.Args[1:] {
		if arg == "--no-window" || arg == "--daemon" {
			noWindow = true
			break
		}
	}
	if !noWindow {
		go func() {
			time.Sleep(600 * time.Millisecond) // brief wait for server startup
			launchDesktopWindow("http://" + serverAddr)
		}()
	}

	// 8. Graceful Shutdown on SIGINT / SIGTERM
	sigChan := setupSignalHandler()

	<-sigChan
	fmt.Println("\n[HyperDrain] Shutting down gracefully... saving active states to SQLite WAL")
	for _, t := range downEngine.GetTasks() {
		if t.Status == engine.StatusDownloading {
			downEngine.PauseTask(t.ID)
		}
	}
	time.Sleep(500 * time.Millisecond)
	fmt.Println("[HyperDrain] Goodbye!")
}

// launchDesktopWindow opens the WebUI in a native standalone desktop app window
func launchDesktopWindow(targetURL string) {
	// Try Chrome or Brave in app mode (provides a dedicated, address-bar-free native desktop window)
	browsers := []string{"google-chrome-stable", "google-chrome", "brave-browser", "brave", "chromium-browser", "chromium"}

	profileDir := filepath.Join(os.TempDir(), "hyperdrain_desktop_profile")

	for _, b := range browsers {
		if path, err := exec.LookPath(b); err == nil {
			cmd := exec.Command(path,
				fmt.Sprintf("--app=%s", targetURL),
				fmt.Sprintf("--user-data-dir=%s", profileDir),
				"--window-size=1240,840",
				"--class=hyperdrain",
			)
			if err := cmd.Start(); err == nil {
				fmt.Printf("[HyperDrain] Launched native desktop app window using %s\n", b)
				return
			}
		}
	}

	// Fallback to default system browser
	exec.Command("xdg-open", targetURL).Start()
}

func resolveWebUIDir() string {
	var candidates []string

	// 1. Check current working directory
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "webui"))
	}

	// 2. Check relative to executable location
	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		candidates = append(candidates,
			filepath.Join(exeDir, "webui"),
			filepath.Join(exeDir, "..", "webui"),
			filepath.Join(exeDir, "..", "resources", "app", "webui"),
			filepath.Join(exeDir, "resources", "app", "webui"),
		)
	}

	// 3. Check installed system package path
	candidates = append(candidates,
		"/opt/hyperdrain/resources/app/webui",
		"/opt/hyperdrain/webui",
	)

	for _, c := range candidates {
		if stat, err := os.Stat(filepath.Join(c, "index.html")); err == nil && !stat.IsDir() {
			return c
		}
	}
	return "webui"
}

func ensureDesktopIntegration(dataDir string) {
	homeDir, err := os.UserHomeDir()
	if err != nil || homeDir == "" {
		return
	}

	// If system deb package /usr/share/applications/hyperdrain.desktop exists,
	// do NOT create a conflicting user desktop file
	if _, err := os.Stat("/usr/share/applications/hyperdrain.desktop"); err == nil {
		// Clean up any stale user-level entry pointing to engine directly
		staleUserDesktop := filepath.Join(homeDir, ".local", "share", "applications", "HyperDrain.desktop")
		if _, err := os.Stat(staleUserDesktop); err == nil {
			_ = os.Remove(staleUserDesktop)
		}
		return
	}

	exePath, err := os.Executable()
	if err == nil && strings.HasPrefix(exePath, "/opt/hyperdrain") {
		return
	}

	iconDest := filepath.Join(homeDir, ".local", "share", "icons", "hyperdrain.png")
	desktopDest := filepath.Join(homeDir, ".local", "share", "applications", "HyperDrain.desktop")

	// 1. Copy icon if missing
	localIcon := "icon.png"
	if exePath != "" {
		localIcon = filepath.Join(filepath.Dir(exePath), "icon.png")
	}
	if _, err := os.Stat(localIcon); err == nil {
		_ = os.MkdirAll(filepath.Dir(iconDest), 0755)
		if in, err := os.ReadFile(localIcon); err == nil {
			_ = os.WriteFile(iconDest, in, 0644)
		}
	}

	// 2. Ensure desktop entry exists and points to current executable
	if exePath == "" {
		exePath = "hyperdrain"
	}

	desktopContent := fmt.Sprintf(`[Desktop Entry]
Version=1.0
Type=Application
Name=HyperDrain
Comment=High-Speed Resilient Downloader
Exec="%s"
Icon=hyperdrain
Terminal=false
Categories=Network;FileTransfer;
StartupWMClass=hyperdrain
`, exePath)

	_ = os.MkdirAll(filepath.Dir(desktopDest), 0755)
	_ = os.WriteFile(desktopDest, []byte(desktopContent), 0755)
	if updateDb, err := exec.LookPath("update-desktop-database"); err == nil {
		_ = exec.Command(updateDb, filepath.Dir(desktopDest)).Run()
	}
}

func resolveExistingDir(targetDir, fallbackDir string) string {
	curr := filepath.Clean(targetDir)
	for curr != "" && curr != "." && curr != "/" {
		if fi, err := os.Stat(curr); err == nil && fi.IsDir() {
			return curr
		}
		parent := filepath.Dir(curr)
		if parent == curr {
			break
		}
		curr = parent
	}
	if fi, err := os.Stat(fallbackDir); err == nil && fi.IsDir() {
		return fallbackDir
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		dl := filepath.Join(home, "Downloads")
		if fi, err := os.Stat(dl); err == nil && fi.IsDir() {
			return dl
		}
		return home
	}
	return "."
}
