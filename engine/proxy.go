package engine

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	proxyMu       sync.Mutex
	proxyEnvKeys  = []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"}
	origProxyOnce sync.Once
	origProxyEnv  map[string]envValue
)

type envValue struct {
	val     string
	present bool
}

func captureOriginalProxyEnv() {
	origProxyOnce.Do(func() {
		origProxyEnv = make(map[string]envValue, len(proxyEnvKeys))
		for _, k := range proxyEnvKeys {
			v, ok := os.LookupEnv(k)
			origProxyEnv[k] = envValue{val: v, present: ok}
		}
	})
}

// NormalizeAndValidateProxyURL normalizes a user-supplied proxy address (e.g.
// "127.0.0.1:1080", "socks5://127.0.0.1:1080", "http://127.0.0.1:8080") and
// verifies it uses a supported scheme with a valid host. Empty input disables
// the configured proxy and returns "", nil.
func NormalizeAndValidateProxyURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	if !strings.Contains(trimmed, "://") {
		if strings.HasSuffix(trimmed, ":1080") {
			trimmed = "socks5h://" + trimmed
		} else {
			trimmed = "http://" + trimmed
		}
	}

	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid proxy URL %q: %w", raw, err)
	}

	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "http", "https", "socks5h", "socks4", "socks4a":
	case "socks5":
		// Use socks5h (remote/proxy-side DNS, ATYP=DOMAINNAME) so DPI bypass
		// proxies like ciadpi/ByeDPI and Go/yt-dlp match Chromium's SOCKS5 behavior
		// instead of failing locally with Host unreachable (errno 4).
		scheme = "socks5h"
	default:
		return "", fmt.Errorf("unsupported proxy scheme %q (use socks5h:// or http://)", u.Scheme)
	}

	if u.Host == "" || u.Hostname() == "" {
		return "", fmt.Errorf("proxy URL %q is missing host:port", raw)
	}

	u.Scheme = scheme
	return u.String(), nil
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// ResolveEffectiveProxyURL returns the proxy URL that should actually be used
// right now. When fallbackDirect is true and the configured proxy points to a
// loopback host, it checks whether that explicit host:port is reachable before
// enabling it so direct downloads continue cleanly if the local proxy is off.
func ResolveEffectiveProxyURL(raw string, fallbackDirect bool) (string, error) {
	normalized, err := NormalizeAndValidateProxyURL(raw)
	if err != nil || normalized == "" {
		return "", err
	}

	u, err := url.Parse(normalized)
	if err != nil {
		return "", err
	}

	if fallbackDirect && isLoopbackHost(u.Hostname()) {
		addr := u.Host
		if u.Port() == "" {
			if strings.HasPrefix(u.Scheme, "socks") {
				addr = net.JoinHostPort(u.Hostname(), "1080")
			} else {
				addr = net.JoinHostPort(u.Hostname(), "8080")
			}
		}
		conn, dialErr := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if dialErr != nil {
			return "", nil
		}
		conn.Close()
	}

	return normalized, nil
}

// EnvProxyURL returns a proxy URL compatible with Go's net/http
// ProxyFromEnvironment, translating socks5h:// -> socks5:// and socks4a:// ->
// socks4:// because Go stdlib does not parse the "h"/"a" suffix.
func EnvProxyURL(effective string) string {
	trimmed := strings.TrimSpace(effective)
	if strings.HasPrefix(trimmed, "socks5h://") {
		return "socks5://" + strings.TrimPrefix(trimmed, "socks5h://")
	}
	if strings.HasPrefix(trimmed, "socks4a://") {
		return "socks4://" + strings.TrimPrefix(trimmed, "socks4a://")
	}
	return trimmed
}

// ApplyProxySettings synchronizes the process proxy environment variables
// (read by http.ProxyFromEnvironment and child tools) and updates
// settings.EffectiveProxyURL. Safe for concurrent calls.
func ApplyProxySettings(settings *EngineSettings) string {
	captureOriginalProxyEnv()

	proxyMu.Lock()
	defer proxyMu.Unlock()

	if settings == nil {
		restoreBaselineProxyEnv()
		return ""
	}

	effective, err := ResolveEffectiveProxyURL(settings.ProxyURL, settings.ProxyFallback)
	if err != nil {
		effective = ""
	}
	settings.EffectiveProxyURL = effective

	if envProxy := EnvProxyURL(effective); envProxy != "" {
		for _, k := range proxyEnvKeys {
			_ = os.Setenv(k, envProxy)
		}
	} else {
		restoreBaselineProxyEnv()
	}

	return effective
}

func restoreBaselineProxyEnv() {
	for _, k := range proxyEnvKeys {
		orig, ok := origProxyEnv[k]
		if ok && orig.present {
			_ = os.Setenv(k, orig.val)
		} else {
			_ = os.Unsetenv(k)
		}
	}
}

// YtDlpProxyArgs refreshes the active proxy status and returns CLI flags for
// yt-dlp when a proxy is active.
func YtDlpProxyArgs(settings *EngineSettings) []string {
	effective := ApplyProxySettings(settings)
	if effective == "" {
		return nil
	}
	return []string{"--proxy", effective}
}
