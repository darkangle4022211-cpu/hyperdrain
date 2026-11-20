package engine

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestResolveEffectiveProxyURL(t *testing.T) {
	// 1. Empty -> Direct
	eff, err := ResolveEffectiveProxyURL("", true)
	if err != nil || eff != "" {
		t.Fatalf("expected empty proxy, got eff=%q err=%v", eff, err)
	}

	// 2. Invalid scheme rejected
	if _, err := NormalizeAndValidateProxyURL("ftp://127.0.0.1:21"); err == nil {
		t.Fatalf("expected error for unsupported proxy scheme")
	}

	// 3. Bare 127.0.0.1:1080 and socks5://127.0.0.1:1080 normalize to socks5h://
	norm, err := NormalizeAndValidateProxyURL("127.0.0.1:1080")
	if err != nil || norm != "socks5h://127.0.0.1:1080" {
		t.Fatalf("expected socks5h://127.0.0.1:1080, got %q (err=%v)", norm, err)
	}
	normS5, err := NormalizeAndValidateProxyURL("socks5://127.0.0.1:1080")
	if err != nil || normS5 != "socks5h://127.0.0.1:1080" {
		t.Fatalf("expected socks5:// to normalize to socks5h://127.0.0.1:1080, got %q (err=%v)", normS5, err)
	}

	// 4. Active loopback listener resolves to configured proxy
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()

	activeURL := "socks5h://" + ln.Addr().String()
	eff, err = ResolveEffectiveProxyURL(activeURL, true)
	if err != nil || eff != activeURL {
		t.Fatalf("expected active proxy %q, got %q (err=%v)", activeURL, eff, err)
	}

	settings := &EngineSettings{
		ProxyURL:      activeURL,
		ProxyFallback: true,
	}
	applied := ApplyProxySettings(settings)
	if applied != activeURL || settings.EffectiveProxyURL != activeURL {
		t.Fatalf("ApplyProxySettings mismatch: applied=%q effective=%q", applied, settings.EffectiveProxyURL)
	}
	wantEnvURL := EnvProxyURL(activeURL)
	if os.Getenv("HTTPS_PROXY") != wantEnvURL || os.Getenv("ALL_PROXY") != wantEnvURL {
		t.Fatalf("expected HTTPS_PROXY and ALL_PROXY to equal %q, got %q / %q", wantEnvURL, os.Getenv("HTTPS_PROXY"), os.Getenv("ALL_PROXY"))
	}
	if args := YtDlpProxyArgs(settings); len(args) != 2 || args[0] != "--proxy" || args[1] != activeURL {
		t.Fatalf("expected YtDlpProxyArgs [--proxy %q], got %#v", activeURL, args)
	}

	// 5. Offline loopback proxy falls back cleanly when ProxyFallback=true
	ln.Close()
	effOfflineFallback, err := ResolveEffectiveProxyURL(activeURL, true)
	if err != nil || effOfflineFallback != "" {
		t.Fatalf("expected direct fallback when loopback proxy offline, got %q (err=%v)", effOfflineFallback, err)
	}
	if appliedAfter := ApplyProxySettings(settings); appliedAfter != "" || settings.EffectiveProxyURL != "" {
		t.Fatalf("expected empty EffectiveProxyURL after fallback, got %q / %q", appliedAfter, settings.EffectiveProxyURL)
	}

	// 6. Offline loopback proxy stays active when ProxyFallback=false
	effStrict, err := ResolveEffectiveProxyURL(activeURL, false)
	if err != nil || effStrict != activeURL {
		t.Fatalf("expected strict proxy %q when fallback disabled, got %q (err=%v)", activeURL, effStrict, err)
	}
}

func TestHandleSettingsProxyPersistenceAndPartialUpdate(t *testing.T) {
	tmpDir := t.TempDir()
	db, err := InitDB(tmpDir)
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()
	mockProxy := "socks5h://" + ln.Addr().String()

	settings := &EngineSettings{
		DownloadDir:        tmpDir,
		DefaultConnections: 16,
		MaxConcurrentTasks: 2,
		ProxyFallback:      true,
	}
	defer ApplyProxySettings(&EngineSettings{})

	s := &Server{
		db:       db,
		settings: settings,
	}

	// Update proxy settings
	body, _ := json.Marshal(map[string]interface{}{
		"download_dir":         tmpDir,
		"default_connections":  16,
		"max_concurrent_tasks": 4,
		"proxy_url":            mockProxy,
		"proxy_fallback":       true,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/settings returned %d: %s", rec.Code, rec.Body.String())
	}

	if db.GetSetting("proxy_url", "") != mockProxy {
		t.Fatalf("expected proxy_url persisted as %q, got %q", mockProxy, db.GetSetting("proxy_url", ""))
	}
	if db.GetSetting("max_concurrent_tasks", "") != "4" {
		t.Fatalf("expected max_concurrent_tasks=4, got %q", db.GetSetting("max_concurrent_tasks", ""))
	}

	// Partial update omitting proxy_url must preserve existing proxy_url
	partialBody, _ := json.Marshal(map[string]interface{}{
		"default_connections": 8,
	})
	req2 := httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(partialBody))
	rec2 := httptest.NewRecorder()
	s.handleSettings(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("partial POST /api/settings returned %d", rec2.Code)
	}
	var got EngineSettings
	if err := json.NewDecoder(rec2.Body).Decode(&got); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if got.ProxyURL != mockProxy || got.EffectiveProxyURL != mockProxy || got.DefaultConnections != 8 {
		t.Fatalf("partial update corrupted settings: %+v", got)
	}

	// Explicit invalid proxy returns 400 Bad Request
	badBody, _ := json.Marshal(map[string]interface{}{
		"proxy_url": "ftp://127.0.0.1:21",
	})
	req3 := httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(badBody))
	rec3 := httptest.NewRecorder()
	s.handleSettings(rec3, req3)
	if rec3.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for invalid proxy scheme, got %d", rec3.Code)
	}
}

func TestM3U8FallbackCandidates(t *testing.T) {
	in := "https://hv-h.phncdn.com/hls/c6541/videos/202610/29/67173645/480P_2000K_67173645.mp4.m3u8?h=abc%3D&e=1794687141&f=1"
	got := m3u8FallbackCandidates(in)
	want0 := "https://hv-h.phncdn.com/hls/c6541/videos/202610/29/67173645/480P_2000K_67173645.mp4/index-v1-a1.m3u8?h=abc%3D&e=1794687141&f=1"
	want1 := "https://hv-h.phncdn.com/hls/c6541/videos/202610/29/67173645/480P_2000K_67173645.mp4/index.m3u8?h=abc%3D&e=1794687141&f=1"
	want2 := "https://hv-h.phncdn.com/hls/c6541/videos/202610/29/67173645/480P_2000K_67173645.mp4/master.m3u8?h=abc%3D&e=1794687141&f=1"
	if len(got) != 3 || got[0] != want0 || got[1] != want1 || got[2] != want2 {
		t.Fatalf("unexpected fallback candidates: %#v", got)
	}

	if none := m3u8FallbackCandidates("https://example.com/master.m3u8?foo=1"); len(none) != 0 {
		t.Fatalf("expected no candidates for standard master.m3u8, got %#v", none)
	}
}
