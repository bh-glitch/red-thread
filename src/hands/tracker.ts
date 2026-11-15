// Webcam + MediaPipe HandLandmarker loop. Everything runs in the browser; the
// WASM runtime and model are served from /public (see scripts/setup_hands.mjs).
import type { HandLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";

export type RawHands = NormalizedLandmark[][];

export type TrackerStats = {
  /** Camera frames actually processed per second. */
  fps: number;
  /** Average time spent inside the hand model per frame (ms). */
  detectMs: number;
  /** Average time from the camera frame to our handler finishing (ms). */
  frameMs: number;
  delegate: "GPU" | "CPU" | "";
};

type VideoFrameCallback = (now: number, meta: { mediaTime: number; expectedDisplayTime?: number }) => void;
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private frame = 0;
  private lastVideoTime = -1;
  // One hand: MediaPipe re-runs its (expensive) palm detector every frame while
  // it is still looking for a missing second hand. Measured: 60 ms → 11 ms/frame.
  private numHands: 1 | 2 = 1;
  private stopped = false;
  readonly video: RvfcVideo;
  readonly stats: TrackerStats = { fps: 0, detectMs: 0, frameMs: 0, delegate: "" };
  private fpsWindow: number[] = [];

  constructor(private onHands: (hands: RawHands, t: number) => void) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async start() {
    const base = "/"; // served from public/ (Vite dev) or dist/ (make serve)
    const [{ FilesetResolver, HandLandmarker }, stream] = await Promise.all([
      import("@mediapipe/tasks-vision"),
      navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60 },
          facingMode: "user",
        },
        audio: false,
      }),
    ]);
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate },
      runningMode: "VIDEO" as const,
      numHands: this.numHands,
      minHandDetectionConfidence: 0.6,
      // Lower presence/tracking thresholds keep the hand during a pinch, when
      // the fingertips overlap and the model is least sure.
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.4,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
      this.stats.delegate = "GPU";
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU"));
      this.stats.delegate = "CPU";
    }
    if (this.stopped) return;
    this.schedule();
  }

  /** Two hands enable two-hand zoom, at ~5× the cost per frame. */
  setNumHands(n: 1 | 2) {
    if (n === this.numHands) return;
    this.numHands = n;
    void this.landmarker?.setOptions({ numHands: n });
  }

  // Run once per *new camera frame* (requestVideoFrameCallback) instead of
  // polling every display frame: no wasted work, and no extra wait between the
  // camera delivering a frame and us reading it.
  private schedule() {
    if (this.stopped) return;
    if (this.video.requestVideoFrameCallback)
      this.frame = this.video.requestVideoFrameCallback(this.tick);
    else this.frame = requestAnimationFrame(() => this.tick(performance.now()));
  }

  private tick = (now: number) => {
    this.schedule();
    const video = this.video;
    if (!this.landmarker || video.readyState < 2) return;
    if (video.currentTime === this.lastVideoTime) return; // no new camera frame
    this.lastVideoTime = video.currentTime;
    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, t0);
    const t1 = performance.now();
    this.onHands(result.landmarks, t1);
    const t2 = performance.now();
    // Rolling averages for the on-screen readout.
    this.stats.detectMs = this.stats.detectMs * 0.9 + (t1 - t0) * 0.1;
    this.stats.frameMs = this.stats.frameMs * 0.9 + (t2 - Math.min(now, t0)) * 0.1;
    this.fpsWindow.push(t2);
    while (this.fpsWindow.length && t2 - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
    this.stats.fps = this.fpsWindow.length;
  };

  stop() {
    this.stopped = true;
    if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frame);
    else cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/**
 * Map normalized camera coordinates to screen pixels within an area. The camera
 * image is mirrored (so moving right moves right), and only the central part of
 * the frame is used, so you never have to reach the edge of the camera's view.
 */
export function toBoard(
  p: { x: number; y: number },
  size: { w: number; h: number },
  margin = { x: 0.18, y: 0.16 },
) {
  // Not clamped here: deltas keep working at the edges. Clamp only for display.
  return {
    x: ((1 - p.x - margin.x) / (1 - 2 * margin.x)) * size.w,
    y: ((p.y - margin.y) / (1 - 2 * margin.y)) * size.h,
  };
}
