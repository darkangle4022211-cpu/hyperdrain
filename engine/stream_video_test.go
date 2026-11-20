package engine

import (
	"testing"
)

func TestIsStreamOrVideoURL(t *testing.T) {
	testCases := []struct {
		url      string
		expected bool
	}{
		{"https://www.youtube.com/watch?v=Sm48oDBbwa4", true},
		{"https://youtu.be/Sm48oDBbwa4", true},
		{"https://vimeo.com/12345678", true},
		{"https://dailymotion.com/video/x7tgad", true},
		{"https://twitch.tv/videos/12345678", true},
		{"https://tiktok.com/@user/video/12345", true},
		{"https://instagram.com/reel/C12345", true},
		{"https://twitter.com/user/status/12345", true},
		{"https://x.com/user/status/12345", true},
		{"https://cdn.example.com/stream/index.m3u8", true},
		{"https://cdn.example.com/hls/master.m3u8?token=xyz", true},
		{"https://cdn.example.com/dash/manifest.mpd", true},
		{"https://cdn.example.com/video?format=m3u8", true},
		{"https://cdn.example.com/files/archive.zip", false},
		{"https://cdn.example.com/ubuntu-24.04.iso", false},
		{"https://example.com/photo.png", false},
	}

	for _, tc := range testCases {
		res := isStreamOrVideoURL(tc.url)
		if res != tc.expected {
			t.Errorf("isStreamOrVideoURL(%q) = %v; expected %v", tc.url, res, tc.expected)
		}
	}
}

func TestRecoverPlaylistURL(t *testing.T) {
	testCases := []struct {
		input    string
		expected string
	}{
		// CMAF/fMP4 with resolution prefix
		{
			"https://video-nss.cdnsolutions.media/x88ytH84vf9N4swQimqykw==,1791590400/media=hls4/multi=256x144:144p:,1280x720:720p:/018/901/152/720p.av1.mp4/init-v1-a1.mp4",
			"https://video-nss.cdnsolutions.media/x88ytH84vf9N4swQimqykw==,1791590400/media=hls4/multi=256x144:144p:,1280x720:720p:/018/901/152/720p.av1.mp4.m3u8",
		},
		// CMAF/fMP4 with index-f2-v1-a1.mp4 fragment
		{
			"https://video-nss.cdnsolutions.media/token123/720p.av1.mp4/index-f2-v1-a1.mp4",
			"https://video-nss.cdnsolutions.media/token123/720p.av1.mp4.m3u8",
		},
		// Standard HLS segment .ts
		{
			"https://stream.example.com/hls/1080p/seg_001.ts",
			"https://stream.example.com/hls/1080p/index.m3u8",
		},
		// HLS segment named index1.ts
		{
			"https://stream.example.com/hls/index1.ts",
			"https://stream.example.com/hls/index.m3u8",
		},
		// Deep path without .mp4 in prefix
		{
			"https://cdn.example.com/stream/v1/init-v1-a1.mp4",
			"https://cdn.example.com/stream/v1/index.m3u8",
		},
		// Normal playlist passes through unchanged
		{
			"https://stream.example.com/hls/master.m3u8",
			"https://stream.example.com/hls/master.m3u8",
		},
	}

	for _, tc := range testCases {
		res := recoverPlaylistURL(tc.input)
		if res != tc.expected {
			t.Errorf("recoverPlaylistURL(%q) = %q; expected %q", tc.input, res, tc.expected)
		}
	}
}
