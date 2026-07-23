"use client";

import { useEffect, useRef } from "react";
import { Renderer, Program, Mesh, Triangle } from "ogl";

// Dithered charcoal wave field — the ambient backdrop behind every
// logged-out page (react-bits "Dither", vendored self-contained on ogl so
// there's no external fetch). Monochrome by design: quantized FBM waves
// tinted a single charcoal grey and ordered-dithered, so it reads as a
// subtle animated texture, never a color wash. Reduced-motion-safe (renders
// one still frame) and fails closed to the charcoal fallback behind it.

const vertex = /* glsl */ `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragment = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uWaveColor;
  uniform float uColorNum;
  uniform float uPixelSize;
  uniform float uAmplitude;
  uniform float uFrequency;
  uniform float uSpeed;

  // Recursive Bayer ordered-dither matrix (0..1).
  float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

  float wave(vec2 p) {
    float t = uTime * uSpeed;
    float v = 0.0;
    v += sin(p.x * uFrequency + t);
    v += sin((p.y * uFrequency + t) * 0.9);
    v += sin((p.x + p.y) * uFrequency * 0.6 + t * 1.3);
    v += sin(length(p - 0.5) * uFrequency * 1.4 - t);
    return v / 4.0;
  }

  void main() {
    vec2 frag = gl_FragCoord.xy;
    vec2 blocks = floor(frag / max(uPixelSize, 1.0));
    vec2 uv = (blocks * max(uPixelSize, 1.0)) / uResolution;
    uv.x *= uResolution.x / uResolution.y;
    float w = clamp(wave(uv) * uAmplitude + 0.5, 0.0, 1.0);
    float levels = max(uColorNum, 1.0);
    float d = bayer8(blocks) - 0.5;
    float q = clamp(floor(w * levels + d) / levels, 0.0, 1.0);
    gl_FragColor = vec4(uWaveColor * q, 1.0);
  }
`;

export function Dither({
  waveColor = [0.243, 0.247, 0.259],
  colorNum = 3,
  pixelSize = 1,
  waveAmplitude = 0.25,
  waveFrequency = 6,
  waveSpeed = 0.04,
  disableAnimation = false,
}: {
  waveColor?: [number, number, number];
  colorNum?: number;
  pixelSize?: number;
  waveAmplitude?: number;
  waveFrequency?: number;
  waveSpeed?: number;
  disableAnimation?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
        alpha: false,
        antialias: false,
      });
    } catch {
      return; // no WebGL — the charcoal fallback behind us stands in
    }

    const gl = renderer.gl;
    gl.clearColor(0.039, 0.039, 0.051, 1);
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);

    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [1, 1] },
        uWaveColor: { value: waveColor },
        uColorNum: { value: colorNum },
        uPixelSize: { value: pixelSize },
        uAmplitude: { value: waveAmplitude },
        uFrequency: { value: waveFrequency },
        uSpeed: { value: waveSpeed },
      },
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    const resize = () => {
      renderer.setSize(host.clientWidth || 1, host.clientHeight || 1);
      program.uniforms.uResolution.value = [
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
      ];
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      program.uniforms.uTime.value = (performance.now() - start) / 1000;
      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(loop);
    };
    if (disableAnimation || reduce) {
      renderer.render({ scene: mesh });
    } else {
      loop();
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try {
        host.removeChild(canvas);
      } catch {
        /* already gone */
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [
    waveColor,
    colorNum,
    pixelSize,
    waveAmplitude,
    waveFrequency,
    waveSpeed,
    disableAnimation,
  ]);

  return <div ref={hostRef} aria-hidden className="h-full w-full" />;
}
