package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type BatchJob struct {
	ID          string   `json:"id"`
	SeriesTitle string   `json:"series_title"`
	TargetDir   string   `json:"target_dir"`
	AutoZip     bool     `json:"auto_zip"`
	Total       int      `json:"total"`
	Completed   int      `json:"completed"`
	TaskIDs     []string `json:"task_ids"`
	Status      string   `json:"status"` // "downloading", "zipping", "completed"
	ZipFile     string   `json:"zip_file,omitempty"`
}

type Server struct {
	engine         *DownloadEngine
	db             *Database
	settings       *EngineSettings
	upgrader       websocket.Upgrader
	clients        map[*websocket.Conn]bool
	clientMu       sync.Mutex
	batches        map[string]*BatchJob
	batchMu        sync.Mutex
	runningBatches map[string]bool
	runningBatchMu sync.Mutex
}

func NewServer(engine *DownloadEngine, db *Database, settings *EngineSettings) *Server {
	s := &Server{
		engine:   engine,
		db:       db,
		settings: settings,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Allow localhost and extension origins
				return true
			},
		},
		clients:        make(map[*websocket.Conn]bool),
		batches:        make(map[string]*BatchJob),
		runningBatches: make(map[string]bool),
	}

	// Register stream resumer callback
	engine.SetStreamResumer(s.ResumeStreamTask)

	// Start 500ms telemetry broadcasting loop
	go s.telemetryBroadcaster()

	return s
}

func (s *Server) RegisterRoutes(mux *http.ServeMux, webUIDir string) {
	// CORS middleware wrapper
	withCORS := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-HyperDrain-Token")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			h(w, r)
		}
	}

	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/api/tasks", withCORS(s.handleGetTasks))
	mux.HandleFunc("/api/tasks/clear-completed", withCORS(s.handleClearCompleted))
	mux.HandleFunc("/api/tasks/add", withCORS(s.handleAddTask))
	mux.HandleFunc("/api/tasks/", withCORS(s.handleTaskAction))
	mux.HandleFunc("/api/stats", withCORS(s.handleGetStats))
	mux.HandleFunc("/api/settings", withCORS(s.handleSettings))
	mux.HandleFunc("/api/choose-folder", withCORS(s.handleChooseFolder))
	mux.HandleFunc("/api/test-notification", withCORS(s.handleTestNotification))
	mux.HandleFunc("/api/video-info", withCORS(s.handleVideoInfo))
	mux.HandleFunc("/api/download-stream", withCORS(s.handleDownloadStream))
	mux.HandleFunc("/api/download-stream-batch", withCORS(s.handleDownloadStreamBatch))

	// Serve Dashboard UI with no-cache headers to prevent stale UI assets
	fs := http.FileServer(http.Dir(webUIDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		fs.ServeHTTP(w, r)
	})
	mux.HandleFunc("/dashboard", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
	})
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	s.clientMu.Lock()
	s.clients[conn] = true
	s.clientMu.Unlock()

	defer func() {
		s.clientMu.Lock()
		delete(s.clients, conn)
		s.clientMu.Unlock()
		conn.Close()
	}()

	// Read loop to detect disconnects
	for {
		if _, _, err := conn.NextReader(); err != nil {
			break
		}
	}
}

func (s *Server) telemetryBroadcaster() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		telemetry := s.engine.GetTelemetry()
		payload, err := json.Marshal(telemetry)
		if err != nil {
			continue
		}

		s.clientMu.Lock()
		for conn := range s.clients {
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				conn.Close()
				delete(s.clients, conn)
			}
		}
		s.clientMu.Unlock()
	}
}

func (s *Server) handleGetTasks(w http.ResponseWriter, r *http.Request) {
	tasks := s.engine.GetTasks()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tasks)
}

type AddTaskRequest struct {
	URL           string `json:"url"`
	SuggestedName string `json:"suggested_name"`
	TargetDir     string `json:"target_dir"`
	Connections   int    `json:"connections"`
	AutoExtract   bool   `json:"auto_extract"`
	Cookie        string `json:"cookie"`
	Referer       string `json:"referer"`
	UserAgent     string `json:"user_agent"`
}

func (s *Server) handleAddTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AddTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.URL == "" {
		http.Error(w, "URL is required", http.StatusBadRequest)
		return
	}

	// Handle magnet links
	if IsMagnetLink(req.URL) && req.SuggestedName == "" {
		req.SuggestedName = ParseMagnetName(req.URL)
	}

	targetDir := req.TargetDir
	if targetDir == "" {
		targetDir = s.settings.DownloadDir
	}
	targetDir = ResolveExistingDir(targetDir)
	availSpace, errSpace := GetAvailableSpaceForPath(targetDir)
	if errSpace == nil && availSpace < 20*1024*1024 {
		http.Error(w, fmt.Sprintf("Target disk does not have enough space: only %s available", FormatBytes(int64(availSpace))), http.StatusBadRequest)
		return
	}

	task, err := s.engine.AddTask(
		req.URL,
		req.SuggestedName,
		targetDir,
		req.Cookie,
		req.Referer,
		req.UserAgent,
		req.Connections,
		req.AutoExtract,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}

func (s *Server) handleTaskAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/tasks/"), "/")
	if len(parts) < 2 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	taskID := parts[0]
	action := parts[1]
	log.Printf("[TASK_ACTION] taskID=%s action=%s", taskID, action)

	switch action {
	case "pause":
		s.engine.PauseTask(taskID)
		w.Write([]byte(`{"status":"paused"}`))
	case "resume":
		s.engine.ResumeTask(taskID)
		w.Write([]byte(`{"status":"resumed"}`))
	case "delete":
		homeDir, _ := os.UserHomeDir()
		os.RemoveAll(filepath.Join(homeDir, ".cache", "hyperdrain", "staging", taskID))
		s.engine.DeleteTask(taskID)
		w.Write([]byte(`{"status":"deleted"}`))
	case "open":
		s.openFolder(taskID)
		w.Write([]byte(`{"status":"opened"}`))
	case "extract":
		go s.extractTaskArchive(taskID)
		w.Write([]byte(`{"status":"extracting"}`))
	default:
		http.Error(w, "Unknown action", http.StatusBadRequest)
	}
}

func (s *Server) handleClearCompleted(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.engine.ClearCompletedTasks()
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"cleared"}`))
}

func ResolveExistingDir(targetDir string) string {
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

func (s *Server) openFolder(taskID string) {
	s.engine.mu.RLock()
	task, exists := s.engine.activeTasks[taskID]
	s.engine.mu.RUnlock()

	if exists {
		dir := filepath.Dir(task.TargetFile)
		safeDir := ResolveExistingDir(dir)
		exec.Command("xdg-open", safeDir).Start()
	}
}

func (s *Server) extractTaskArchive(taskID string) {
	s.engine.mu.RLock()
	task, exists := s.engine.activeTasks[taskID]
	s.engine.mu.RUnlock()

	if exists {
		destDir := filepath.Join(filepath.Dir(task.TargetFile), strings.TrimSuffix(task.Name, filepath.Ext(task.Name)))
		ExtractArchive(task.TargetFile, destDir)
	}
}

func (s *Server) handleGetStats(w http.ResponseWriter, r *http.Request) {
	s.settings.DownloadDir = ResolveExistingDir(s.settings.DownloadDir)
	telemetry := s.engine.GetTelemetry()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(telemetry)
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	s.settings.DownloadDir = ResolveExistingDir(s.settings.DownloadDir)
	if r.Method == "GET" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.settings)
		return
	}

	var newSettings EngineSettings
	if err := json.NewDecoder(r.Body).Decode(&newSettings); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if newSettings.DownloadDir != "" {
		safeDir := ResolveExistingDir(newSettings.DownloadDir)
		s.settings.DownloadDir = safeDir
		s.db.SetSetting("download_dir", safeDir)
	}
	if newSettings.DefaultConnections > 0 {
		s.settings.DefaultConnections = newSettings.DefaultConnections
	}
	s.settings.AutoExtract = newSettings.AutoExtract

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.settings)
}

func (s *Server) handleChooseFolder(w http.ResponseWriter, r *http.Request) {
	initialDir := ResolveExistingDir(s.settings.DownloadDir)
	if initialDir != s.settings.DownloadDir {
		s.settings.DownloadDir = initialDir
		s.db.SetSetting("download_dir", initialDir)
	}

	cmd := exec.Command("zenity", "--file-selection", "--directory", "--title=Select Download Destination Folder", "--filename="+filepath.Clean(initialDir)+"/")
	
	env := os.Environ()
	hasDisplay := false
	hasWayland := false
	for _, e := range env {
		if strings.HasPrefix(e, "DISPLAY=") {
			hasDisplay = true
		}
		if strings.HasPrefix(e, "WAYLAND_DISPLAY=") {
			hasWayland = true
		}
	}
	if !hasDisplay {
		env = append(env, "DISPLAY=:0")
	}
	if !hasWayland && os.Getenv("XDG_SESSION_TYPE") == "wayland" {
		env = append(env, "WAYLAND_DISPLAY=wayland-0")
	}
	cmd.Env = env

	out, err := cmd.Output()
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.Write([]byte(`{"cancelled":true}`))
		return
	}

	selected := strings.TrimSpace(string(out))
	if selected == "" {
		w.Write([]byte(`{"cancelled":true}`))
		return
	}

	safeSelected := ResolveExistingDir(selected)
	s.settings.DownloadDir = safeSelected
	s.db.SetSetting("download_dir", safeSelected)

	json.NewEncoder(w).Encode(map[string]interface{}{
		"cancelled": false,
		"path":      safeSelected,
	})
}

func (s *Server) handleTestNotification(w http.ResponseWriter, r *http.Request) {
	err := SendUbuntuNotification("HyperDrain ⚡ Notification Test", "Desktop notifications are working perfectly on your system.", "normal")
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "error", "message": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "message": "Desktop notification dispatched successfully"})
}

type VideoInfoRequest struct {
	URL string `json:"url"`
}

type VideoFormatOption struct {
	ID     string `json:"id"`
	Height int    `json:"height,omitempty"`
	Label  string `json:"label"`
	Ext    string `json:"ext"`
	Type   string `json:"type"`
}

type VideoInfoResponse struct {
	Title     string              `json:"title"`
	Thumbnail string              `json:"thumbnail,omitempty"`
	Formats   []VideoFormatOption `json:"formats"`
}

func findExecutable(name string, priorityPaths ...string) string {
	for _, p := range priorityPaths {
		if p != "" {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	homeDir, _ := os.UserHomeDir()
	if homeDir != "" {
		localPath := filepath.Join(homeDir, ".local", "bin", name)
		if _, err := os.Stat(localPath); err == nil {
			return localPath
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return name
}

func getBundledBinDir() string {
	execPath, err := os.Executable()
	if err == nil {
		execDir := filepath.Dir(execPath)
		candidate := filepath.Join(execDir, "bin")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if _, err := os.Stat("/opt/hyperdrain/bin"); err == nil {
		return "/opt/hyperdrain/bin"
	}
	return ""
}

func getYtDlpPath() string {
	bundled := getBundledBinDir()
	var extra []string
	if bundled != "" {
		extra = append(extra, filepath.Join(bundled, "yt-dlp"))
	}
	extra = append(extra, "/opt/pulsar-music-player/bin/yt-dlp")
	return findExecutable("yt-dlp", extra...)
}

func getFfmpegPath() string {
	bundled := getBundledBinDir()
	var extra []string
	if bundled != "" {
		extra = append(extra, filepath.Join(bundled, "ffmpeg"))
	}
	extra = append(extra, "/opt/pulsar-music-player/bin/ffmpeg")
	return findExecutable("ffmpeg", extra...)
}

func getNodePath() string {
	return findExecutable("node")
}

func (s *Server) handleVideoInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req VideoInfoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "Invalid URL", http.StatusBadRequest)
		return
	}

	ytPath := getYtDlpPath()
	nodePath := getNodePath()
	var jsArg []string
	if _, err := os.Stat(nodePath); err == nil {
		jsArg = []string{"--js-runtimes", "node:" + nodePath}
	}

	args := append(jsArg, "-J", "--no-playlist", "--no-warnings", req.URL)
	cmd := exec.Command(ytPath, args...)
	out, err := cmd.Output()
	if err != nil {
		http.Error(w, fmt.Sprintf("Extraction error: %v", err), http.StatusInternalServerError)
		return
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(out, &raw); err != nil {
		http.Error(w, "Failed to parse metadata", http.StatusInternalServerError)
		return
	}

	title, _ := raw["title"].(string)
	thumb, _ := raw["thumbnail"].(string)

	var formats []VideoFormatOption
	rawFormats, _ := raw["formats"].([]interface{})

	seenHeights := make(map[int]bool)
	targetHeights := []int{2160, 1440, 1080, 720, 480, 360}

	for _, targetH := range targetHeights {
		for _, fItem := range rawFormats {
			f, ok := fItem.(map[string]interface{})
			if !ok {
				continue
			}
			h, _ := f["height"].(float64)
			vcodec, _ := f["vcodec"].(string)
			fid, _ := f["format_id"].(string)
			ext, _ := f["ext"].(string)

			if int(h) == targetH && vcodec != "none" && !seenHeights[int(h)] {
				seenHeights[int(h)] = true
				formats = append(formats, VideoFormatOption{
					ID:     fid,
					Height: int(h),
					Label:  fmt.Sprintf("%dp (%s)", int(h), ext),
					Ext:    ext,
					Type:   "video",
				})
				break
			}
		}
	}

	formats = append(formats, VideoFormatOption{
		ID:    "ba/bestaudio",
		Label: "Audio Only (MP3/M4A)",
		Ext:   "mp3",
		Type:  "audio",
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(VideoInfoResponse{
		Title:     title,
		Thumbnail: thumb,
		Formats:   formats,
	})
}

type DownloadStreamRequest struct {
	URL         string `json:"url"`
	FormatID    string `json:"format_id"`
	Title       string `json:"title"`
	TargetDir   string `json:"target_dir"`
	Referer     string `json:"referer"`
	Origin      string `json:"origin"`
	UserAgent   string `json:"user_agent"`
	Cookie      string `json:"cookie"`
	Connections int    `json:"connections"`
}

func (s *Server) handleDownloadStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req DownloadStreamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "Invalid parameters", http.StatusBadRequest)
		return
	}

	targetDir := req.TargetDir
	if targetDir == "" {
		targetDir = s.settings.DownloadDir
	}
	targetDir = ResolveExistingDir(targetDir)

	availSpace, errSpace := GetAvailableSpaceForPath(targetDir)
	if errSpace == nil && availSpace < 20*1024*1024 {
		http.Error(w, fmt.Sprintf("Target disk does not have enough space: only %s available", FormatBytes(int64(availSpace))), http.StatusBadRequest)
		return
	}

	cleanReferer := strings.TrimSpace(req.Referer)
	if cleanReferer != "" {
		if parsed, err := url.Parse(cleanReferer); err == nil && parsed.Path == "" {
			parsed.Path = "/"
			cleanReferer = parsed.String()
		}
	}
	cleanOrigin := strings.TrimRight(strings.TrimSpace(req.Origin), "/")

	cleanTitle := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, req.Title)
	if cleanTitle == "" {
		cleanTitle = fmt.Sprintf("video_%d", time.Now().Unix())
	}

	ext := "mp4"
	if req.FormatID == "ba/bestaudio" || req.FormatID == "audio" || req.FormatID == "mp3" {
		ext = "mp3"
	}

	streamURL := req.URL
	// 1. If an HLS .ts fragment was passed, recover playlist
	reSeg := regexp.MustCompile(`/(seg_[^/?#]+|segment[^/?#]*)\.ts`)
	if reSeg.MatchString(streamURL) {
		streamURL = reSeg.ReplaceAllString(streamURL, "/index.m3u8")
	}

	// 2. If a CMAF / fMP4 fragment was passed (e.g. /144p.av1.mp4/init-v1-a1.mp4), recover the .m3u8 playlist!
	reFrag := regexp.MustCompile(`/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)`)
	if reFrag.MatchString(streamURL) {
		streamURL = reFrag.ReplaceAllString(streamURL, ".m3u8")
	}

	// 3. Auto-route known dead CDN proxies to fast working mirrors
	if strings.Contains(streamURL, "fetch.nexabloom.top") {
		streamURL = strings.Replace(streamURL, "fetch.nexabloom.top", "ncdn.imgnex.top", 1)
	}

	// 3. For multi-bitrate HLS URLs (e.g. multi=...144p:...720p:.../144p.av1.mp4.m3u8):
	// If a specific resolution was selected (e.g. 720p or 1080p), adapt to that stream variant!
	if strings.Contains(streamURL, "multi=") {
		targetRes := ""
		switch req.FormatID {
		case "1080p", "1080", "", "best":
			targetRes = "1080p"
		case "720p", "720":
			targetRes = "720p"
		case "360p", "360":
			targetRes = "360p"
		}
		if targetRes != "" && !strings.Contains(streamURL, "/"+targetRes) {
			reRes := regexp.MustCompile(`/(144p|240p|360p|480p|720p|1080p)\.(av1|h264)\.mp4`)
			if reRes.MatchString(streamURL) {
				candidateURL := reRes.ReplaceAllString(streamURL, "/"+targetRes+".$2.mp4")
				checkReq, _ := http.NewRequest("HEAD", candidateURL, nil)
				if cleanReferer != "" {
					checkReq.Header.Set("Referer", cleanReferer)
				}
				if cleanOrigin != "" {
					checkReq.Header.Set("Origin", cleanOrigin)
				}
				if req.Cookie != "" {
					checkReq.Header.Set("Cookie", req.Cookie)
				}
				client := &http.Client{Timeout: 3 * time.Second}
				if resp, err := client.Do(checkReq); err == nil && resp.StatusCode == 200 {
					streamURL = candidateURL
					resp.Body.Close()
				} else {
					candidateH264 := reRes.ReplaceAllString(streamURL, "/"+targetRes+".h264.mp4")
					checkReq2, _ := http.NewRequest("HEAD", candidateH264, nil)
					if cleanReferer != "" {
						checkReq2.Header.Set("Referer", cleanReferer)
					}
					if cleanOrigin != "" {
						checkReq2.Header.Set("Origin", cleanOrigin)
					}
					if req.Cookie != "" {
						checkReq2.Header.Set("Cookie", req.Cookie)
					}
					if resp2, err := client.Do(checkReq2); err == nil && resp2.StatusCode == 200 {
						streamURL = candidateH264
						resp2.Body.Close()
					}
				}
			}
		}
	}
	formatSelector := req.FormatID

	// Let yt-dlp handle resolution via -f format selector — do NOT alter streamURL path!
	// Signed/HMAC URLs break if the path (e.g. /1080/, /720/) is modified, causing 403/404.
	switch formatSelector {
	case "1080p", "1080", "", "best":
		formatSelector = "bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height=1080]/best[height<=1080]/best"
	case "720p", "720":
		formatSelector = "bestvideo[height=720]+bestaudio/bestvideo[height<=720]+bestaudio/best[height=720]/best[height<=720]/best"
	case "360p", "360":
		formatSelector = "bestvideo[height=360]+bestaudio/bestvideo[height<=360]+bestaudio/best[height=360]/best[height<=360]/best"
	case "ba/bestaudio", "audio", "mp3":
		formatSelector = "ba/bestaudio/best"
		ext = "mp3"
	default:
		if !strings.Contains(formatSelector, "+") && !strings.Contains(formatSelector, "/") && !strings.Contains(formatSelector, "[") {
			formatSelector = formatSelector + "+bestaudio/" + formatSelector + "/best"
		}
	}

	// Prevent starting duplicate simultaneous downloads for the same file
	s.engine.mu.Lock()
	for _, existing := range s.engine.activeTasks {
		if (existing.URL == streamURL || existing.TargetFile == filepath.Join(targetDir, cleanTitle+"."+ext)) && existing.Status == StatusDownloading {
			s.engine.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"status":  "started",
				"task_id": existing.ID,
				"name":    existing.Name,
			})
			return
		}
	}
	s.engine.mu.Unlock()

	conns := req.Connections
	if conns <= 0 {
		conns = 16
	}

	taskID := fmt.Sprintf("task_stream_%d", time.Now().UnixNano())
	task := &DownloadTask{
		ID:                taskID,
		URL:               streamURL,
		Name:              cleanTitle + "." + ext,
		TargetFile:        filepath.Join(targetDir, cleanTitle+"."+ext),
		TotalBytes:        0, // Start at 0 so real size is calculated dynamically as fragments arrive
		Status:            StatusDownloading,
		Connections:       conns,
		ActiveConnections: conns,
		CreatedAt:         time.Now(),
		FormatID:          formatSelector,
		Origin:            cleanOrigin,
		Referer:           cleanReferer,
		UserAgent:         req.UserAgent,
		Cookie:            req.Cookie,
		Segments:          make([]*Segment, 0),
	}
	s.engine.mu.Lock()
	s.engine.activeTasks[taskID] = task
	s.engine.mu.Unlock()
	s.db.SaveTask(task)

	NotifyDownloadStarted(task.Name, task.ActiveConnections)

	go s.executeStreamDownload(task, streamURL, formatSelector)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "started",
		"task_id": taskID,
		"name":    cleanTitle,
	})
}

type BatchStreamRequest struct {
	SeriesTitle string                   `json:"series_title"`
	TargetDir   string                   `json:"target_dir"`
	FormatID    string                   `json:"format_id"`
	AudioType   string                   `json:"audio_type"`
	AutoZip     bool                     `json:"auto_zip"`
	Connections int                      `json:"connections"`
	Episodes    []BatchStreamEpisodeItem `json:"episodes"`
}

type BatchStreamEpisodeItem struct {
	EpisodeNum string `json:"episode_num"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	Referer    string `json:"referer"`
	Origin     string `json:"origin"`
	Cookie     string `json:"cookie"`
	UserAgent  string `json:"user_agent"`
}

func (s *Server) handleDownloadStreamBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req BatchStreamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Episodes) == 0 {
		http.Error(w, "Invalid batch request: no episodes provided", http.StatusBadRequest)
		return
	}

	cleanSeriesTitle := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, req.SeriesTitle)
	cleanSeriesTitle = strings.TrimSpace(cleanSeriesTitle)
	if cleanSeriesTitle == "" {
		cleanSeriesTitle = fmt.Sprintf("Series_%d", time.Now().Unix())
	}

	baseDir := s.settings.DownloadDir
	if req.TargetDir != "" {
		baseDir = req.TargetDir
	}
	baseDir = ResolveExistingDir(baseDir)

	availSpace, errSpace := GetAvailableSpaceForPath(baseDir)
	if errSpace == nil && availSpace < 50*1024*1024 {
		http.Error(w, fmt.Sprintf("Target disk does not have enough space: only %s available", FormatBytes(int64(availSpace))), http.StatusBadRequest)
		return
	}

	formatSelector := req.FormatID
	switch formatSelector {
	case "1080p", "1080", "", "best":
		formatSelector = "bestvideo[height=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height=1080]/best[height<=1080]/best"
	case "720p", "720":
		formatSelector = "bestvideo[height=720]+bestaudio/bestvideo[height<=720]+bestaudio/best[height=720]/best[height<=720]/best"
	case "360p", "360":
		formatSelector = "bestvideo[height=360]+bestaudio/bestvideo[height<=360]+bestaudio/best[height=360]/best[height<=360]/best"
	case "ba/bestaudio", "audio", "mp3":
		formatSelector = "ba/bestaudio/best"
	default:
		if !strings.Contains(formatSelector, "+") && !strings.Contains(formatSelector, "/") && !strings.Contains(formatSelector, "[") {
			formatSelector = formatSelector + "+bestaudio/" + formatSelector + "/best"
		}
	}

	qualityTag := "1080p"
	switch req.FormatID {
	case "1080p", "1080":
		qualityTag = "1080p"
	case "720p", "720":
		qualityTag = "720p"
	case "360p", "360":
		qualityTag = "360p"
	case "ba/bestaudio", "audio", "mp3":
		qualityTag = "MP3"
	default:
		if strings.Contains(req.FormatID, "1080") {
			qualityTag = "1080p"
		} else if strings.Contains(req.FormatID, "720") {
			qualityTag = "720p"
		} else if strings.Contains(req.FormatID, "360") {
			qualityTag = "360p"
		}
	}

	audioTag := ""
	cleanAudio := strings.TrimSpace(req.AudioType)
	if cleanAudio != "" {
		switch strings.ToLower(cleanAudio) {
		case "dub":
			audioTag = "Dub"
		case "sub":
			audioTag = "Sub"
		case "dl":
			audioTag = "DL"
		case "raw":
			audioTag = "Raw"
		default:
			audioTag = cleanAudio
		}
	}

	firstEp := "1"
	lastEp := strconv.Itoa(len(req.Episodes))
	if len(req.Episodes) > 0 {
		if req.Episodes[0].EpisodeNum != "" {
			firstEp = strings.TrimLeft(req.Episodes[0].EpisodeNum, "0")
			if firstEp == "" {
				firstEp = "0"
			}
		}
		if req.Episodes[len(req.Episodes)-1].EpisodeNum != "" {
			lastEp = strings.TrimLeft(req.Episodes[len(req.Episodes)-1].EpisodeNum, "0")
			if lastEp == "" {
				lastEp = "0"
			}
		}
	}
	epRange := fmt.Sprintf("Episodes %s-%s", firstEp, lastEp)
	if firstEp == lastEp {
		epRange = fmt.Sprintf("Episode %s", firstEp)
	}

	var tags []string
	if audioTag != "" && !strings.Contains(strings.ToLower(cleanSeriesTitle), strings.ToLower(audioTag)) {
		tags = append(tags, "["+audioTag+"]")
	}
	if qualityTag != "" && !strings.Contains(strings.ToLower(cleanSeriesTitle), strings.ToLower(qualityTag)) {
		tags = append(tags, "["+qualityTag+"]")
	}

	var tagStr string
	if len(tags) > 0 {
		tagStr = " " + strings.Join(tags, " ")
	}

	zipFileName := fmt.Sprintf("%s (%s)%s.zip", cleanSeriesTitle, epRange, tagStr)
	targetZipFile := filepath.Join(baseDir, zipFileName)

	conns := req.Connections
	if conns <= 0 {
		conns = 32
	}
	if conns > 32 {
		conns = 32
	}

	taskID := fmt.Sprintf("zip_batch_%d", time.Now().UnixNano())
	task := &DownloadTask{
		ID:                taskID,
		BatchID:           taskID,
		AutoZip:           true,
		URL:               req.Episodes[0].URL,
		Name:              zipFileName,
		TargetFile:        targetZipFile,
		TotalBytes:        0,
		DownloadedBytes:   0,
		Status:            StatusDownloading,
		Connections:       conns,
		ActiveConnections: conns,
		CreatedAt:         time.Now(),
		FormatID:          formatSelector,
		ErrorMessage:      fmt.Sprintf("Downloading Episode 1 of %d...", len(req.Episodes)),
		Segments:          make([]*Segment, 0),
	}

	s.engine.mu.Lock()
	s.engine.activeTasks[taskID] = task
	s.engine.mu.Unlock()
	s.db.SaveTask(task)

	NotifyDownloadStarted(zipFileName, conns)

	go s.executeZipBatchDownload(task, cleanSeriesTitle, targetZipFile, req.Episodes, formatSelector, conns)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "started",
		"task_id":        taskID,
		"name":           zipFileName,
		"target_file":    targetZipFile,
		"total_episodes": len(req.Episodes),
	})
}

func (s *Server) executeZipBatchDownload(task *DownloadTask, cleanSeriesTitle, targetZipFile string, episodes []BatchStreamEpisodeItem, formatSelector string, conns int) {
	s.runningBatchMu.Lock()
	if s.runningBatches[task.ID] {
		s.runningBatchMu.Unlock()
		log.Printf("[ZIP_BATCH] Task %s is already executing in an active worker; ignoring duplicate invocation", task.ID)
		return
	}
	s.runningBatches[task.ID] = true
	s.runningBatchMu.Unlock()

	defer func() {
		s.runningBatchMu.Lock()
		delete(s.runningBatches, task.ID)
		s.runningBatchMu.Unlock()
	}()

	if conns <= 0 {
		conns = 32
	}
	if conns > 32 {
		conns = 32
	}
	ytPath := getYtDlpPath()
	nodePath := getNodePath()
	var jsArg []string
	if _, err := os.Stat(nodePath); err == nil {
		jsArg = []string{"--js-runtimes", "node:" + nodePath}
	}

	ffmpegPath := getFfmpegPath()
	ffmpegDir := filepath.Dir(ffmpegPath)

	homeDir, _ := os.UserHomeDir()
	batchStagingDir := filepath.Join(homeDir, ".cache", "hyperdrain", "staging", task.ID)
	episodesDir := filepath.Join(batchStagingDir, "episodes")
	os.MkdirAll(episodesDir, 0755)

	// Save batch info for resume capability
	batchInfoBytes, _ := json.Marshal(map[string]interface{}{
		"series_title":    cleanSeriesTitle,
		"target_zip_file": targetZipFile,
		"episodes":        episodes,
		"format_selector": formatSelector,
	})
	_ = os.WriteFile(filepath.Join(batchStagingDir, "batch_info.json"), batchInfoBytes, 0644)

	ctx, cancel := context.WithCancel(context.Background())
	var currentCmd *exec.Cmd
	var cmdMu sync.Mutex

	task.mu.Lock()
	task.cancel = func() {
		cancel()
		cmdMu.Lock()
		if currentCmd != nil && currentCmd.Process != nil {
			killProcessGroup(currentCmd.Process)
		}
		cmdMu.Unlock()
	}
	task.Status = StatusDownloading
	task.Connections = conns
	task.ActiveConnections = conns
	task.mu.Unlock()

	reSeg := regexp.MustCompile(`/(seg_[^/?#]+|segment[^/?#]*)\.ts`)
	reFrag := regexp.MustCompile(`/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)`)
	totalEps := len(episodes)
	var completedEpsCount int = 0

	for idx, ep := range episodes {
		select {
		case <-ctx.Done():
			task.mu.Lock()
			task.ActiveConnections = 0
			task.Speed = 0
			task.DiskWriteRate = 0
			task.mu.Unlock()
			s.db.SaveTask(task)
			return
		default:
		}

		task.mu.Lock()
		if task.Status == StatusPaused {
			task.ActiveConnections = 0
			task.Speed = 0
			task.DiskWriteRate = 0
			task.mu.Unlock()
			s.db.SaveTask(task)
			return
		}
		task.mu.Unlock()

		streamURL := ep.URL
		if reSeg.MatchString(streamURL) {
			streamURL = reSeg.ReplaceAllString(streamURL, "/index.m3u8")
		}
		if reFrag.MatchString(streamURL) {
			streamURL = reFrag.ReplaceAllString(streamURL, ".m3u8")
		}
		if strings.Contains(streamURL, "fetch.nexabloom.top") {
			streamURL = strings.Replace(streamURL, "fetch.nexabloom.top", "ncdn.imgnex.top", 1)
		}

		epNumStr := strings.TrimSpace(ep.EpisodeNum)
		if n, err := strconv.Atoi(epNumStr); err == nil {
			epNumStr = fmt.Sprintf("%02d", n)
		} else if epNumStr == "" {
			epNumStr = fmt.Sprintf("%02d", idx+1)
		}

		epFileName := fmt.Sprintf("%s - Episode %s.mp4", cleanSeriesTitle, epNumStr)
		epFinalPath := filepath.Join(episodesDir, epFileName)

		// Check if already downloaded
		if fi, err := os.Stat(epFinalPath); err == nil && fi.Size() > 500*1024 {
			log.Printf("[ZIP_BATCH] Episode %s already downloaded (%s), skipping", epNumStr, FormatBytes(fi.Size()))
			completedEpsCount++
			continue
		}

		epTempDir := filepath.Join(batchStagingDir, fmt.Sprintf("ep_%02d", idx+1))
		os.MkdirAll(epTempDir, 0755)
		epOutTemplate := filepath.Join(epTempDir, fmt.Sprintf("ep_%02d.%%(ext)s", idx+1))

		cleanReferer := strings.TrimSpace(ep.Referer)
		if cleanReferer != "" {
			if parsed, err := url.Parse(cleanReferer); err == nil && parsed.Path == "" {
				parsed.Path = "/"
				cleanReferer = parsed.String()
			}
		}

		cleanOrigin := strings.TrimRight(strings.TrimSpace(ep.Origin), "/")
		if cleanOrigin == "" && cleanReferer != "" {
			if parsedRef, err := url.Parse(cleanReferer); err == nil && parsedRef.Scheme != "" && parsedRef.Host != "" {
				cleanOrigin = parsedRef.Scheme + "://" + parsedRef.Host
			}
		}

		// Only pass cookie if stream host matches referer host (prevents deprecation warning & socket timeouts)
		var shouldPassCookie bool = false
		if ep.Cookie != "" {
			parsedStream, err1 := url.Parse(streamURL)
			parsedRef, err2 := url.Parse(cleanReferer)
			if err1 == nil && err2 == nil && parsedStream.Host != "" && parsedRef.Host != "" {
				if parsedStream.Host == parsedRef.Host || strings.HasSuffix(parsedStream.Host, "."+parsedRef.Host) {
					shouldPassCookie = true
				}
			}
		}

		var formatSort string
		if strings.Contains(formatSelector, "1080") {
			formatSort = "res:1080,fps,br"
		} else if strings.Contains(formatSelector, "720") {
			formatSort = "res:720,fps,br"
		} else if strings.Contains(formatSelector, "360") {
			formatSort = "res:360,fps,br"
		}

		args := append(jsArg,
			"--continue",
			"-N", fmt.Sprintf("%d", conns),
			"-f", formatSelector,
		)
		if formatSort != "" {
			args = append(args, "-S", formatSort)
		}
		args = append(args,
			"-o", epOutTemplate,
			"--merge-output-format", "mp4",
			"--newline",
			"--progress-template", "download:HD_PROG:%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s:%(progress.speed)s:%(progress.eta)s:%(info.format_id)s:%(progress.fragment_index)s:%(progress.fragment_count)s",
			"--no-playlist",
			"--ffmpeg-location", ffmpegDir,
			"--hls-use-mpegts",
			"--skip-unavailable-fragments",
		)

		if cleanReferer != "" {
			args = append(args, "--referer", cleanReferer)
		}
		if cleanOrigin != "" {
			args = append(args, "--add-header", "Origin: "+cleanOrigin)
		}
		if ep.UserAgent != "" {
			args = append(args, "--user-agent", ep.UserAgent)
		} else {
			args = append(args, "--user-agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
		}
		if shouldPassCookie {
			args = append(args, "--add-header", "Cookie: "+ep.Cookie)
		}

		args = append(args,
			"--add-header", "Accept: */*",
			"--add-header", "Accept-Language: en-US,en;q=0.9",
			"--add-header", "Sec-Fetch-Mode: cors",
			"--add-header", "Sec-Fetch-Site: cross-site",
			"--socket-timeout", "30",
			"--retries", "10",
			"--fragment-retries", "10",
			"--file-access-retries", "5",
			"--retry-sleep", "1",
			"--no-check-certificates",
			streamURL,
		)

		task.mu.Lock()
		task.ErrorMessage = fmt.Sprintf("Downloading Episode %d of %d (Ep %s)...", idx+1, totalEps, epNumStr)
		task.Connections = conns
		task.ActiveConnections = conns
		task.mu.Unlock()
		s.db.SaveTask(task)

		cmd := exec.CommandContext(ctx, ytPath, args...)
		prepareProcessGroup(cmd)
		cmd.Env = append(os.Environ(),
			"PYTHONUNBUFFERED=1",
			"PATH="+ffmpegDir+":"+getBundledBinDir()+":/usr/local/bin:/usr/bin:/bin:"+filepath.Join(homeDir, ".local", "bin")+":"+os.Getenv("PATH"),
		)

		cmdMu.Lock()
		currentCmd = cmd
		cmdMu.Unlock()

		stdout, err := cmd.StdoutPipe()
		if err == nil {
			go func(currentEpIdx int) {
				scanner := bufio.NewScanner(stdout)
				for scanner.Scan() {
					line := scanner.Text()
					if strings.HasPrefix(line, "HD_PROG:") {
						parts := strings.Split(strings.TrimPrefix(line, "HD_PROG:"), ":")
						if len(parts) >= 5 {
							dlFloat, _ := strconv.ParseFloat(parts[0], 64)
							spFloat, _ := strconv.ParseFloat(parts[3], 64)
							etaFloat, _ := strconv.ParseFloat(parts[4], 64)

							// Calculate completed size from finished episodes on disk
							var completedDiskBytes int64 = 0
							var completedCount int = 0
							if epEntries, err := os.ReadDir(episodesDir); err == nil {
								for _, ee := range epEntries {
									if fi, err := ee.Info(); err == nil && !ee.IsDir() {
										completedDiskBytes += fi.Size()
										completedCount++
									}
								}
							}

							currentEpBytes := int64(dlFloat)
							var currentEpDiskBytes int64 = 0
							if tempEntries, err := os.ReadDir(epTempDir); err == nil {
								for _, te := range tempEntries {
									if fi, err := te.Info(); err == nil && !te.IsDir() {
										currentEpDiskBytes += fi.Size()
									}
								}
							}
							if currentEpDiskBytes > currentEpBytes {
								currentEpBytes = currentEpDiskBytes
							}

							task.mu.Lock()
							cumulativeDl := completedDiskBytes + currentEpBytes
							if cumulativeDl > task.DownloadedBytes {
								task.DownloadedBytes = cumulativeDl
							}
							task.LastProgressTime = time.Now()

							// Rock-solid total batch bytes estimate:
							// Once we have at least 1 completed episode, average completed size is the ground truth!
							if completedCount > 0 {
								avgPerEp := completedDiskBytes / int64(completedCount)
								task.TotalBytes = avgPerEp * int64(totalEps)
							} else if task.TotalBytes <= 0 {
								task.TotalBytes = int64(totalEps) * 280 * 1024 * 1024
							}

							if spFloat > 0 {
								task.Speed = int64(spFloat)
								task.DiskWriteRate = int64(spFloat)
							}
							if etaFloat > 0 {
								task.ETA = int64(etaFloat)
							}

							var fragIdx, fragCnt int64 = 0, 0
							if len(parts) >= 8 {
								fragIdx, _ = strconv.ParseInt(parts[6], 10, 64)
								fragCnt, _ = strconv.ParseInt(parts[7], 10, 64)
							}
							epPct := 0
							if fragCnt > 0 {
								epPct = int((fragIdx * 100) / fragCnt)
							}
							if epPct > 0 {
								task.ErrorMessage = fmt.Sprintf("Downloading Episode %d of %d (Ep %s: %d%%)", currentEpIdx+1, totalEps, epNumStr, epPct)
							} else {
								task.ErrorMessage = fmt.Sprintf("Downloading Episode %d of %d (Ep %s)...", currentEpIdx+1, totalEps, epNumStr)
							}
							task.mu.Unlock()
						}
					}
				}
			}(idx)
		}

		_ = cmd.Run()

		cmdMu.Lock()
		currentCmd = nil
		cmdMu.Unlock()

		// Locate downloaded episode file in temp folder
		var foundEpFile string
		if entries, err := os.ReadDir(epTempDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() && (strings.HasSuffix(e.Name(), ".mp4") || strings.HasSuffix(e.Name(), ".ts") || strings.HasSuffix(e.Name(), ".unknown_video") || strings.HasSuffix(e.Name(), ".mkv")) {
					foundEpFile = filepath.Join(epTempDir, e.Name())
					break
				}
			}
		}

		if foundEpFile != "" {
			if fi, err := os.Stat(foundEpFile); err == nil && fi.Size() > 100*1024 {
				if err := MoveFile(foundEpFile, epFinalPath); err == nil {
					completedEpsCount++
					log.Printf("[ZIP_BATCH] Successfully completed episode %s (%s)", epNumStr, FormatBytes(fi.Size()))
				}
			}
		}
		os.RemoveAll(epTempDir)
	}

	// All episodes finished: package into final ZIP file!
	if completedEpsCount > 0 {
		task.mu.Lock()
		task.ErrorMessage = fmt.Sprintf("Packaging %d episodes into ZIP archive...", completedEpsCount)
		task.Speed = 0
		task.ActiveConnections = 0
		task.mu.Unlock()
		s.db.SaveTask(task)

		log.Printf("[ZIP_BATCH] Packaging %d episodes to ZIP: %s", completedEpsCount, targetZipFile)
		os.MkdirAll(filepath.Dir(targetZipFile), 0755)

		tempZipFile := targetZipFile + ".tmp"
		_ = os.Remove(tempZipFile)
		zipErr := ZipDirectory(episodesDir, tempZipFile)
		if zipErr == nil {
			if fi, err := os.Stat(tempZipFile); err == nil && fi.Size() > 1024*1024 {
				if moveErr := MoveFile(tempZipFile, targetZipFile); moveErr == nil {
					now := time.Now()
					task.mu.Lock()
					task.Status = StatusCompleted
					task.CompletedAt = &now
					task.TotalBytes = fi.Size()
					task.DownloadedBytes = fi.Size()
					task.ErrorMessage = ""
					task.ActiveConnections = 0
					task.Speed = 0
					task.DiskWriteRate = 0
					task.mu.Unlock()

					os.RemoveAll(batchStagingDir)
					s.db.SaveTask(task)

					NotifyBatchComplete(cleanSeriesTitle, fmt.Sprintf("All %d episodes packaged into single ZIP:\n%s (%s)", completedEpsCount, filepath.Base(targetZipFile), FormatBytes(fi.Size())))
					return
				} else {
					zipErr = fmt.Errorf("failed moving finalized zip file: %w", moveErr)
				}
			} else {
				zipErr = fmt.Errorf("temporary zip file missing or corrupted")
			}
		}

		log.Printf("[ZIP_BATCH] ZIP creation failed: %v", zipErr)
		task.mu.Lock()
		task.Status = StatusError
		task.ErrorMessage = fmt.Sprintf("Downloaded %d episodes, but ZIP packaging failed: %v", completedEpsCount, zipErr)
		task.mu.Unlock()
		s.db.SaveTask(task)
	} else {
		task.mu.Lock()
		task.Status = StatusError
		task.ErrorMessage = "Batch download failed: video streams could not be fetched"
		task.mu.Unlock()
		s.db.SaveTask(task)
	}
}

func (s *Server) ResumeStreamTask(task *DownloadTask) {
	if strings.HasPrefix(task.ID, "zip_batch_") {
		homeDir, _ := os.UserHomeDir()
		batchInfoPath := filepath.Join(homeDir, ".cache", "hyperdrain", "staging", task.ID, "batch_info.json")
		if data, err := os.ReadFile(batchInfoPath); err == nil {
			var info struct {
				SeriesTitle    string                   `json:"series_title"`
				TargetZipFile  string                   `json:"target_zip_file"`
				Episodes       []BatchStreamEpisodeItem `json:"episodes"`
				FormatSelector string                   `json:"format_selector"`
			}
			if err := json.Unmarshal(data, &info); err == nil && len(info.Episodes) > 0 {
				task.mu.Lock()
				task.Status = StatusDownloading
				task.ErrorMessage = "Resuming batch download..."
				task.Connections = 32
				task.ActiveConnections = 32
				task.mu.Unlock()
				s.db.SaveTask(task)
				go s.executeZipBatchDownload(task, info.SeriesTitle, info.TargetZipFile, info.Episodes, info.FormatSelector, 32)
				return
			}
		}
	}

	task.mu.Lock()
	task.Status = StatusDownloading
	task.ErrorMessage = ""
	if task.Connections <= 0 {
		task.Connections = 16
	}
	task.ActiveConnections = task.Connections
	formatSelector := task.FormatID
	if formatSelector == "" {
		formatSelector = "best"
	}
	task.mu.Unlock()
	s.db.SaveTask(task)

	s.executeStreamDownload(task, task.URL, formatSelector)
}

func (s *Server) executeStreamDownload(task *DownloadTask, streamURL, formatSelector string) {
	if strings.Contains(streamURL, "fetch.nexabloom.top") {
		streamURL = strings.Replace(streamURL, "fetch.nexabloom.top", "ncdn.imgnex.top", 1)
		task.URL = streamURL
	}

	ytPath := getYtDlpPath()
	nodePath := getNodePath()
	var jsArg []string
	if _, err := os.Stat(nodePath); err == nil {
		jsArg = []string{"--js-runtimes", "node:" + nodePath}
	}

	ffmpegPath := getFfmpegPath()
	ffmpegDir := filepath.Dir(ffmpegPath)

	homeDir, _ := os.UserHomeDir()
	stagingDir := filepath.Join(homeDir, ".cache", "hyperdrain", "staging", task.ID)
	os.MkdirAll(stagingDir, 0755)

	cleanTitle := strings.TrimSuffix(task.Name, filepath.Ext(task.Name))
	outputTemplate := filepath.Join(stagingDir, cleanTitle+".%(ext)s")

	conns := task.Connections
	if conns <= 0 {
		conns = 16
	}

	var formatSort string
	if strings.Contains(formatSelector, "1080") {
		formatSort = "res:1080,fps,br"
	} else if strings.Contains(formatSelector, "720") {
		formatSort = "res:720,fps,br"
	} else if strings.Contains(formatSelector, "360") {
		formatSort = "res:360,fps,br"
	}

	args := append(jsArg,
		"--continue",
		"-N", fmt.Sprintf("%d", conns),
		"-f", formatSelector,
	)
	if formatSort != "" {
		args = append(args, "-S", formatSort)
	}
	args = append(args,
		"-o", outputTemplate,
		"--merge-output-format", "mp4",
		"--newline",
		"--progress-template", "download:HD_PROG:%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s:%(progress.speed)s:%(progress.eta)s:%(info.format_id)s:%(progress.fragment_index)s:%(progress.fragment_count)s",
		"--no-playlist",
		"--ffmpeg-location", ffmpegDir,
		"--hls-use-mpegts",
		"--skip-unavailable-fragments",
	)

	isYouTube := strings.Contains(streamURL, "youtube.com") || strings.Contains(streamURL, "youtu.be") || strings.Contains(streamURL, "googlevideo")

	cleanReferer := strings.TrimSpace(task.Referer)
	if cleanReferer != "" {
		if parsed, err := url.Parse(cleanReferer); err == nil && parsed.Path == "" {
			parsed.Path = "/"
			cleanReferer = parsed.String()
		}
		task.Referer = cleanReferer
		args = append(args, "--referer", cleanReferer)
	}

	cleanOrigin := strings.TrimRight(strings.TrimSpace(task.Origin), "/")
	if cleanOrigin != "" {
		args = append(args, "--add-header", "Origin: "+cleanOrigin)
	} else if cleanReferer != "" && !isYouTube {
		parsedRef, err := url.Parse(cleanReferer)
		if err == nil && parsedRef.Scheme != "" && parsedRef.Host != "" {
			cleanOrigin = parsedRef.Scheme + "://" + parsedRef.Host
			args = append(args, "--add-header", "Origin: "+cleanOrigin)
		}
	}
	if task.UserAgent != "" {
		args = append(args, "--user-agent", task.UserAgent)
	} else {
		args = append(args, "--user-agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
	}
	if task.Cookie != "" {
		parsedStream, err1 := url.Parse(streamURL)
		parsedRef, err2 := url.Parse(cleanReferer)
		if err1 == nil && err2 == nil && parsedStream.Host != "" && parsedRef.Host != "" {
			if parsedStream.Host == parsedRef.Host || strings.HasSuffix(parsedStream.Host, "."+parsedRef.Host) {
				args = append(args, "--add-header", "Cookie: "+task.Cookie)
			}
		}
	}

	if !isYouTube {
		args = append(args,
			"--add-header", "Accept: */*",
			"--add-header", "Accept-Language: en-US,en;q=0.9",
			"--add-header", "Sec-Fetch-Mode: cors",
			"--add-header", "Sec-Fetch-Site: cross-site",
		)
	}

	args = append(args,
		"--socket-timeout", "30",
		"--retries", "10",
		"--fragment-retries", "10",
		"--file-access-retries", "5",
		"--retry-sleep", "1",
		"--no-check-certificates",
		streamURL,
	)

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, ytPath, args...)
	prepareProcessGroup(cmd)
	cmd.Env = append(os.Environ(),
		"PYTHONUNBUFFERED=1",
		"PATH="+ffmpegDir+":"+getBundledBinDir()+":/usr/local/bin:/usr/bin:/bin:"+filepath.Join(homeDir, ".local", "bin")+":"+os.Getenv("PATH"),
	)

	task.mu.Lock()
	task.cancel = func() {
		cancel()
		if cmd.Process != nil {
			killProcessGroup(cmd.Process)
		}
	}
	task.Status = StatusDownloading
	task.ActiveConnections = conns
	task.mu.Unlock()
	NotifyDownloadStarted(task.Name, task.ActiveConnections)

	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	var lastErrText string
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		go func() {
			var baseDownloaded int64 = 0
			var maxDlForCurrentFormat int64 = 0
			var currentFormatId string = ""
			var spaceChecked bool = false
			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				line := scanner.Text()
				if strings.HasPrefix(line, "ERROR:") || strings.Contains(line, "fragment not found") || strings.Contains(line, "HTTP Error 404") || strings.Contains(line, "HTTP Error 403") {
					lastErrText = line
				}
				if strings.HasPrefix(line, "HD_PROG:") {
					parts := strings.Split(strings.TrimPrefix(line, "HD_PROG:"), ":")
					if len(parts) >= 5 {
						dlFloat, _ := strconv.ParseFloat(parts[0], 64)
						totFloat, _ := strconv.ParseFloat(parts[1], 64)
						estFloat, _ := strconv.ParseFloat(parts[2], 64)
						spFloat, _ := strconv.ParseFloat(parts[3], 64)
						etaFloat, _ := strconv.ParseFloat(parts[4], 64)

						streamTotal := int64(totFloat)
						if streamTotal <= 0 {
							streamTotal = int64(estFloat)
						}
						if streamTotal > 0 && !spaceChecked {
							spaceChecked = true
							availTarget, errSpace := GetAvailableSpaceForPath(filepath.Dir(task.TargetFile))
							if errSpace == nil && int64(availTarget) < streamTotal {
								errStr := fmt.Sprintf("Target disk does not have enough space: %s required, but only %s available", FormatBytes(streamTotal), FormatBytes(int64(availTarget)))
								log.Printf("[HyperDrain Stream] %s for %s", errStr, task.Name)
								task.mu.Lock()
								task.Status = StatusError
								task.ErrorMessage = errStr
								task.mu.Unlock()
								s.db.SaveTask(task)
								NotifyInsufficientDiskSpace(task.Name, streamTotal, int64(availTarget))
								if cmd != nil && cmd.Process != nil {
									_ = cmd.Process.Kill()
								}
								return
							}
						}

						formatId := ""
						if len(parts) >= 6 {
							formatId = parts[5]
						}

						currentDl := int64(dlFloat)

						// Detect legitimate format switch (ONLY when yt-dlp explicitly switches format ID, e.g. video to audio)
						formatSwitched := false
						if currentFormatId != "" && formatId != "" && formatId != currentFormatId {
							formatSwitched = true
						}

						if formatSwitched {
							baseDownloaded += maxDlForCurrentFormat
							maxDlForCurrentFormat = 0
							currentFormatId = formatId
						} else if currentFormatId == "" && formatId != "" {
							currentFormatId = formatId
						}

						if currentDl > maxDlForCurrentFormat {
							maxDlForCurrentFormat = currentDl
						}

						// Ground truth: inspect staging directory file sizes on disk
						var stagingDiskBytes int64 = 0
						if entries, err := os.ReadDir(stagingDir); err == nil {
							for _, e := range entries {
								if !e.IsDir() {
									if fi, err := e.Info(); err == nil {
										stagingDiskBytes += fi.Size()
									}
								}
							}
						}

						task.mu.Lock()
						cumulativeDl := baseDownloaded + maxDlForCurrentFormat
						if stagingDiskBytes > cumulativeDl {
							cumulativeDl = stagingDiskBytes
						}
						if cumulativeDl > task.DownloadedBytes {
							task.DownloadedBytes = cumulativeDl
							task.LastProgressTime = time.Now()
						}

						var fragIndex, fragCount int64 = 0, 0
						if len(parts) >= 8 {
							fragIndex, _ = strconv.ParseInt(parts[6], 10, 64)
							fragCount, _ = strconv.ParseInt(parts[7], 10, 64)
						}

						// Calculate real total bytes dynamically:
						if totFloat > 0 {
							// Exact total size known from Content-Length or playlist
							task.TotalBytes = baseDownloaded + int64(totFloat)
						} else if estFloat > 5*1024*1024 {
							newEstimate := baseDownloaded + int64(estFloat)
							if task.TotalBytes <= 0 || task.TotalBytes < 10*1024*1024 {
								task.TotalBytes = newEstimate
							} else {
								task.TotalBytes = int64(0.85*float64(task.TotalBytes) + 0.15*float64(newEstimate))
							}
						} else if fragIndex > 0 && fragCount > 0 {
							// For HLS/DASH fragments: dynamically calculate real total file size!
							calcTotal := baseDownloaded + (currentDl*fragCount)/fragIndex
							if calcTotal > 10*1024*1024 || fragIndex > 5 {
								if task.TotalBytes <= 0 || task.TotalBytes < 10*1024*1024 {
									task.TotalBytes = calcTotal
								} else {
									task.TotalBytes = int64(0.75*float64(task.TotalBytes) + 0.25*float64(calcTotal))
								}
							}
						}

						if task.TotalBytes > 0 && stagingDiskBytes > task.TotalBytes {
							task.TotalBytes = stagingDiskBytes
						}

						if spFloat > 0 {
							task.Speed = int64(spFloat)
							task.DiskWriteRate = int64(spFloat)
						}
						if etaFloat > 0 {
							task.ETA = int64(etaFloat)
						}
						task.ActiveConnections = conns
						task.mu.Unlock()
					}
				}
			}
		}()
	}

	runErr := cmd.Run()
	task.mu.Lock()
	if task.Status == StatusPaused {
		task.Speed = 0
		task.DiskWriteRate = 0
		task.ActiveConnections = 0
		task.mu.Unlock()
		s.db.SaveTask(task)
		return
	}
	if ctx.Err() == context.Canceled {
		task.Speed = 0
		task.DiskWriteRate = 0
		task.ActiveConnections = 0
		task.mu.Unlock()
		return
	}

	var completedFile string
	var completedSize int64
	var completedName string

	entries, _ := os.ReadDir(stagingDir)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasSuffix(name, ".part") || strings.HasSuffix(name, ".ytdl") || strings.Contains(name, ".part-Frag") {
			continue
		}
		fullPath := filepath.Join(stagingDir, name)
		if fi, err := os.Stat(fullPath); err == nil {
			// Skip standalone raw .ts fragments under 5 MB if multiple files exist
			if strings.HasSuffix(name, ".ts") && fi.Size() < 5*1024*1024 && len(entries) > 1 {
				continue
			}
			if fi.Size() > completedSize && fi.Size() > 10*1024 {
				completedFile = fullPath
				completedSize = fi.Size()
				completedName = name
			}
		}
	}

	// Secondary check: look in target directory in case yt-dlp placed file there
	if completedFile == "" {
		targetDir := filepath.Dir(task.TargetFile)
		if targetEntries, err := os.ReadDir(targetDir); err == nil {
			for _, te := range targetEntries {
				if !te.IsDir() && strings.HasPrefix(te.Name(), cleanTitle) {
					tfPath := filepath.Join(targetDir, te.Name())
					if fi, err := os.Stat(tfPath); err == nil && fi.Size() > completedSize && fi.Size() > 10*1024 {
						completedFile = tfPath
						completedSize = fi.Size()
						completedName = te.Name()
					}
				}
			}
		}
	}

	if completedFile != "" {
		// Assembled file exists! Mark completed without showing error or requiring Retry
		now := time.Now()
		task.Status = StatusCompleted
		task.CompletedAt = &now
		task.ErrorMessage = ""

		cleanEntryName := completedName
		if strings.HasSuffix(cleanEntryName, ".unknown_video") {
			cleanEntryName = strings.TrimSuffix(cleanEntryName, ".unknown_video") + ".mp4"
		} else if strings.HasSuffix(cleanEntryName, ".ts") {
			cleanEntryName = strings.TrimSuffix(cleanEntryName, ".ts") + ".mp4"
		}
		destFile := filepath.Join(filepath.Dir(task.TargetFile), cleanEntryName)
		os.MkdirAll(filepath.Dir(destFile), 0755)

		if completedFile != destFile {
			if err := MoveFile(completedFile, destFile); err == nil {
				task.TargetFile = destFile
				task.Name = cleanEntryName
				if fi, err := os.Stat(destFile); err == nil {
					task.TotalBytes = fi.Size()
					task.DownloadedBytes = fi.Size()
				}
				os.RemoveAll(stagingDir)
			} else {
				log.Printf("[STREAM] MoveFile failed: %v, keeping file at %s", err, completedFile)
				task.TargetFile = completedFile
				task.TotalBytes = completedSize
				task.DownloadedBytes = completedSize
			}
		} else {
			task.TargetFile = destFile
			task.Name = cleanEntryName
			if fi, err := os.Stat(destFile); err == nil {
				task.TotalBytes = fi.Size()
				task.DownloadedBytes = fi.Size()
			}
			os.RemoveAll(stagingDir)
		}
		NotifyDownloadComplete(task.Name, FormatBytes(task.TotalBytes))
	} else if runErr == nil {
		if fi, err := os.Stat(task.TargetFile); err == nil && fi.Size() > 10*1024 {
			now := time.Now()
			task.Status = StatusCompleted
			task.CompletedAt = &now
			task.TotalBytes = fi.Size()
			task.DownloadedBytes = fi.Size()
			task.ErrorMessage = ""
			os.RemoveAll(stagingDir)
			NotifyDownloadComplete(task.Name, FormatBytes(task.TotalBytes))
		} else {
			task.Status = StatusError
			task.ErrorMessage = "Download finished but output file could not be located"
			NotifyDownloadStopped(task.Name, task.ErrorMessage)
		}
	} else {
		task.Status = StatusError
		errMsg := strings.TrimSpace(stderrBuf.String())
		if errMsg == "" && lastErrText != "" {
			errMsg = lastErrText
		}
		if errMsg == "" {
			errMsg = runErr.Error()
		}
		if strings.Contains(errMsg, "Deprecated Feature:") {
			lines := strings.Split(errMsg, "\n")
			var filtered []string
			for _, l := range lines {
				if !strings.Contains(l, "Deprecated Feature:") {
					filtered = append(filtered, l)
				}
			}
			errMsg = strings.TrimSpace(strings.Join(filtered, "\n"))
		}
		if strings.Contains(errMsg, "Read timed out") {
			errMsg = "Connection timed out to video server. Please click Retry."
		} else if strings.Contains(errMsg, "HTTP Error 404") || strings.Contains(errMsg, "fragment not found") || strings.Contains(errMsg, "unable to continue") {
			errMsg = "Video stream link expired. Please refresh the episode page and click Download."
		} else if strings.Contains(errMsg, "HTTP Error 403") {
			errMsg = "Access forbidden (403). Please refresh the episode page."
		}
		task.ErrorMessage = errMsg
		NotifyDownloadStopped(task.Name, task.ErrorMessage)
	}
	task.ActiveConnections = 0
	task.Speed = 0
	task.DiskWriteRate = 0
	task.mu.Unlock()
	s.db.SaveTask(task)
}


