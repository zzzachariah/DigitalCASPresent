"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type StreamStatus = "idle" | "connecting" | "live" | "failed";

// Manages a D-ID real-time (WebRTC) avatar stream: connect once, then speak()
// on demand so the always-visible avatar talks in ~1-2s. All D-ID calls go
// through /api/avatar/stream (key stays server-side).
export function useDidStream(personId: string, enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessRef = useRef<{ streamId: string; sessionId: string } | null>(null);
  const startedRef = useRef(false);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<StreamStatus>("idle");
  const [speaking, setSpeaking] = useState(false);

  const post = (body: unknown) =>
    fetch("/api/avatar/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  const start = useCallback(async () => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    setStatus("connecting");
    try {
      const res = await post({ action: "start", personId });
      if (res.error || !res.offer) {
        setStatus("failed");
        return;
      }
      const { streamId, sessionId, offer, iceServers } = res;
      sessRef.current = { streamId, sessionId };

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      pc.addEventListener("track", (e) => {
        const [stream] = e.streams;
        if (videoRef.current && stream) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
      pc.addEventListener("icecandidate", (e) => {
        if (e.candidate) {
          post({
            action: "ice",
            streamId,
            sessionId,
            candidate: {
              candidate: e.candidate.candidate,
              sdpMid: e.candidate.sdpMid,
              sdpMLineIndex: e.candidate.sdpMLineIndex,
            },
          });
        }
      });
      pc.addEventListener("connectionstatechange", () => {
        const s = pc.connectionState;
        if (s === "connected") setStatus("live");
        else if (s === "failed") setStatus("failed");
      });
      // D-ID streams talk-state over a data channel ("stream/started|done").
      pc.addEventListener("datachannel", (e) => {
        e.channel.onmessage = (msg) => {
          const m = String((msg as MessageEvent).data || "");
          if (/started/i.test(m)) setSpeaking(true);
          else if (/done|ready/i.test(m)) setSpeaking(false);
        };
      });

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await post({ action: "sdp", streamId, sessionId, answer });
    } catch {
      setStatus("failed");
    }
  }, [enabled, personId]);

  const say = useCallback(async (text: string, lang: "en" | "zh"): Promise<boolean> => {
    if (!sessRef.current) return false;
    if (videoRef.current) videoRef.current.muted = false; // unmute (called from a tap)
    setSpeaking(true);
    const r = await post({
      action: "speak",
      streamId: sessRef.current.streamId,
      sessionId: sessRef.current.sessionId,
      text,
      lang,
    }).catch(() => ({ error: "network" }));
    if (r?.error) {
      setSpeaking(false);
      return false;
    }
    // Fallback end-of-speech estimate in case the data-channel event is missed.
    if (endTimer.current) clearTimeout(endTimer.current);
    const estMs = Math.min(90000, 2500 + text.length * 130);
    endTimer.current = setTimeout(() => setSpeaking(false), estMs);
    return true;
  }, []);

  const stop = useCallback(() => {
    if (endTimer.current) clearTimeout(endTimer.current);
    if (sessRef.current) post({ action: "close", ...sessRef.current }).catch(() => {});
    pcRef.current?.close();
    pcRef.current = null;
    sessRef.current = null;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { videoRef, status, speaking, start, say };
}
