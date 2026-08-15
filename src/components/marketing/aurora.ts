// Aurora Glow (vendored) — a WebGL glow that frames a container with a
// slowly spinning four-tint gradient border and sends a radial ripple out
// from a trigger element. The ambient "AI is active" signal, in the style
// of Apple Intelligence. Idle it renders a static near-black frame at zero
// per-frame cost; `setActive(true)` fades the band in and fires a ripple
// from the `[data-aura-origin]` element; reduced-motion snaps between
// static states with no animation loop.
//
// Ported near-verbatim on the founder's instruction. The shader source, the
// OKLCH → linear-sRGB conversion and the timing constants are the effect —
// they are not re-authored, only typed at the edges for a strict TS tree.
// The canvas renders OPAQUE (alpha: false) and paints its container
// near-black: it is for dark UIs only, which the auth shell is.

export type AuraInstance = {
  setActive: (active: boolean) => void;
  pulse: () => void;
  setPalette: (name: string) => void;
  destroy: () => void;
};

type AuraRoot = HTMLElement & { __auraBorder?: AuraInstance };

/** Typed accessor for the instance the init stores on its root element. */
export function auraInstanceOf(el: HTMLElement): AuraInstance | undefined {
  return (el as AuraRoot).__auraBorder;
}

export function auraBorder(scope: Document | Element = document) {
  const selector = "[data-aura-border]";
  const roots: AuraRoot[] = [
    ...(scope instanceof Element && scope.matches(selector) ? [scope] : []),
    ...scope.querySelectorAll(selector),
  ] as AuraRoot[];

  roots.forEach((root) => {
    root.__auraBorder?.destroy();

    const canvas = root.querySelector("[data-aura-canvas]");
    const origin = root.querySelector("[data-aura-origin]");
    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }
    // TS drops instanceof narrowing inside hoisted function declarations
    // (resize/draw below), so re-bind the narrowed value once.
    const surface: HTMLCanvasElement = canvas;

    const abortController = new AbortController();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });

    if (!gl) {
      root.dataset.state = "unsupported";
      return;
    }

    const vertexShaderSource = `
      attribute vec2 aPosition;
      varying vec2 vUv;

      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    // Single-pass frame shader: two rounded-box distance bands trace the
    // viewport edge, a spinning four-tint gradient colors them, and a radial
    // ripple launched from the origin element warps the bands while it
    // travels.
    const fragmentShaderSource = `
      precision highp float;

      uniform sampler2D uDitherTexture;
      uniform vec2 uDitherTexel;
      uniform vec2 uDitherShift;
      uniform vec2 uViewport;
      uniform vec2 uGradientScale;
      uniform vec2 uRippleOrigin;
      uniform float uInset;
      uniform float uTime;
      uniform float uIntensity;
      uniform float uRipple;
      uniform vec3 uBase;
      uniform vec3 uTint0;
      uniform vec3 uTint1;
      uniform vec3 uTint2;
      uniform vec3 uTint3;
      varying vec2 vUv;

      vec3 sampleDither(vec2 coord) {
        return texture2D(
          uDitherTexture,
          coord * uDitherTexel + uDitherShift
        ).rgb;
      }

      float boxDistance(vec2 point, vec2 halfSize) {
        vec2 edge = abs(point) - halfSize;
        return length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0);
      }

      float remap01(float edgeA, float edgeB, float value) {
        return clamp((value - edgeA) / (edgeB - edgeA), 0.0, 1.0);
      }

      void main() {
        vec3 dither = sampleDither(gl_FragCoord.xy);
        vec2 screenAspect = vec2(uViewport.x / uViewport.y, 1.0);

        vec2 gradientUv = (vUv - 0.5) * uGradientScale * 2.0;
        float spin = uTime * -4.9;
        float spinSin = sin(spin);
        float spinCos = cos(spin);
        gradientUv = mat2(spinCos, -spinSin, spinSin, spinCos) * gradientUv;
        gradientUv = clamp(gradientUv * 0.5 + 0.5, vec2(0.0), vec2(1.0));

        vec3 topRow = mix(uTint0, uTint1, gradientUv.x);
        vec3 bottomRow = mix(uTint3, uTint2, gradientUv.x);
        vec3 gradient = mix(bottomRow, topRow, gradientUv.y);
        gradient = 2.0 * gradient * gradient * gradient;

        vec2 rippleVector = (vUv - uRippleOrigin) * screenAspect;
        float rippleDistance = length(rippleVector);
        float screenRadius = length(screenAspect);
        float rippleWidth = 0.5 * screenRadius;
        float ripplePhase = uRipple * 2.0 * screenRadius - rippleDistance;
        float rippleRise = smoothstep(0.0, rippleWidth, ripplePhase);
        float rippleFall = smoothstep(screenRadius, rippleWidth, ripplePhase);
        float ripple = rippleRise * rippleFall * uIntensity;
        vec2 rippleDirection = rippleDistance > 0.00001
          ? rippleVector / rippleDistance
          : vec2(0.0);

        vec2 frameUv = (vUv - 0.5) * uViewport
          + rippleDirection * ripple * 0.01 * uViewport.x;

        float ring = boxDistance(
          frameUv,
          uViewport * 0.5 - uInset * 2.0
        ) - uInset;
        ring = remap01(0.0, uInset * 2.5, ring);
        ring = pow(ring, 3.0);

        float halo = boxDistance(
          frameUv,
          uViewport * 0.5 - uInset * 3.0
        ) - uInset * 1.5;
        halo = remap01(0.0, uInset * 5.5, halo);
        halo = pow(halo, 5.0);

        vec3 color = uBase;
        float glow = (0.001 + ring + halo * 0.5) * 5.0;
        color += uIntensity * gradient * glow;
        color += ripple * (ring * 0.25 + halo * 0.25 + gradient * 0.05);
        color = min(color, vec3(1.0));

        gl_FragColor = vec4(
          pow(color, vec3(1.0 / 2.2)) + dither * 0.004,
          1.0
        );
      }
    `;

    function compileShader(type: number, source: string): WebGLShader {
      // gl is checked non-null above; TS can't see through the closure.
      const shader = gl!.createShader(type)!;
      gl!.shaderSource(shader, source);
      gl!.compileShader(shader);
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        const message = gl!.getShaderInfoLog(shader) || "Unknown shader error";
        gl!.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(
      gl.FRAGMENT_SHADER,
      fragmentShaderSource,
    );
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message =
        gl.getProgramInfoLog(program) || "Unknown program link error";
      gl.deleteProgram(program);
      throw new Error(message);
    }

    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    gl.useProgram(program);
    const positionLocation = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const uniforms = Object.fromEntries(
      [
        "uDitherTexture",
        "uDitherTexel",
        "uDitherShift",
        "uViewport",
        "uGradientScale",
        "uRippleOrigin",
        "uInset",
        "uTime",
        "uIntensity",
        "uRipple",
        "uBase",
        "uTint0",
        "uTint1",
        "uTint2",
        "uTint3",
      ].map((name) => [name, gl.getUniformLocation(program, name)]),
    );

    const ditherTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ditherTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB,
      1,
      1,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      new Uint8Array([127, 127, 127]),
    );

    gl.uniform1i(uniforms.uDitherTexture, 0);
    gl.uniform2f(uniforms.uDitherTexel, 1 / 128, 1 / 128);
    gl.uniform3f(uniforms.uBase, 0.0037, 0.0028, 0.0024);

    function oklchToLinearSrgb(
      lightness: number,
      chroma: number,
      hue: number,
    ): number[] {
      const hueRadians = (hue * Math.PI) / 180;

      function convert(candidateChroma: number) {
        const a = candidateChroma * Math.cos(hueRadians);
        const b = candidateChroma * Math.sin(hueRadians);
        const l = lightness + 0.3963377774 * a + 0.2158037573 * b;
        const m = lightness - 0.1055613458 * a - 0.0638541728 * b;
        const s = lightness - 0.0894841775 * a - 1.291485548 * b;
        const l3 = l * l * l;
        const m3 = m * m * m;
        const s3 = s * s * s;

        return [
          4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
          -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
          -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
        ];
      }

      let fittedChroma = chroma;
      let color = convert(fittedChroma);

      for (
        let attempt = 0;
        attempt < 32 && color.some((channel) => channel < 0 || channel > 1);
        attempt += 1
      ) {
        fittedChroma *= 0.94;
        color = convert(fittedChroma);
      }

      return color.map((channel) => Math.min(1, Math.max(0, channel)));
    }

    const palettes: Record<string, number[][]> = {
      spectrum: [
        [1, 0.334, 1],
        [1, 0.302, 0.041],
        [1, 1, 0.0165],
        [0.0905, 1, 1],
      ],
      ocean: [
        oklchToLinearSrgb(0.85, 0.14, 165),
        oklchToLinearSrgb(0.88, 0.15, 185),
        oklchToLinearSrgb(0.72, 0.15, 235),
        oklchToLinearSrgb(0.78, 0.14, 210),
      ],
      neon: [
        oklchToLinearSrgb(0.8, 0.2, 335),
        oklchToLinearSrgb(0.75, 0.17, 300),
        oklchToLinearSrgb(0.85, 0.14, 195),
        oklchToLinearSrgb(0.7, 0.15, 255),
      ],
    };

    let targetIntensity = 0;
    let intensity = 0;
    let ripple = 1;
    let elapsed = 0;
    let previousTime = 0;
    let frameId = 0;
    let rippleOrigin = [0.5, 0.5];

    function resize() {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const renderWidth = Math.round(width * dpr);
      const renderHeight = Math.round(height * dpr);

      if (surface.width !== renderWidth || surface.height !== renderHeight) {
        surface.width = renderWidth;
        surface.height = renderHeight;
        gl!.viewport(0, 0, renderWidth, renderHeight);
      }

      if (origin) {
        const rootRect = root.getBoundingClientRect();
        const originRect = origin.getBoundingClientRect();
        rippleOrigin = [
          (originRect.left + originRect.width * 0.5 - rootRect.left) /
            rootRect.width,
          1 -
            (originRect.top + originRect.height * 0.5 - rootRect.top) /
              rootRect.height,
        ];
      }
    }

    function draw(now = performance.now()) {
      frameId = 0;
      resize();

      const delta = previousTime
        ? Math.min((now - previousTime) / 1000, 0.1)
        : 0;
      previousTime = now;

      if (reducedMotion.matches) {
        intensity = targetIntensity;
        ripple = 1;
        elapsed = 0;
      } else {
        elapsed += delta;
        const duration = targetIntensity > intensity ? 0.25 : 0.175;
        const direction = Math.sign(targetIntensity - intensity);
        intensity +=
          direction *
          Math.min(Math.abs(targetIntensity - intensity), delta / duration);
        ripple = Math.min(1, ripple + delta * 0.52);
      }

      const easedIntensity = 1 - Math.cos(intensity * Math.PI * 0.5);
      const width = surface.width;
      const height = surface.height;
      const inset = Math.min(
        50 * Math.min(window.devicePixelRatio || 1, 2),
        Math.min(width, height) * 0.08,
      );
      const gradientScale =
        (Math.min(height / width, 1) / Math.hypot(width, height)) *
        Math.max(width, height);

      gl!.useProgram(program);
      gl!.uniform2f(uniforms.uViewport, width, height);
      gl!.uniform2f(
        uniforms.uGradientScale,
        (width / height) * gradientScale,
        gradientScale,
      );
      gl!.uniform2f(uniforms.uRippleOrigin, rippleOrigin[0], rippleOrigin[1]);
      gl!.uniform2f(uniforms.uDitherShift, Math.random(), Math.random());
      gl!.uniform1f(uniforms.uInset, inset);
      gl!.uniform1f(uniforms.uTime, elapsed);
      gl!.uniform1f(uniforms.uIntensity, easedIntensity);
      gl!.uniform1f(uniforms.uRipple, ripple);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);

      if (
        !reducedMotion.matches &&
        (targetIntensity > 0 || intensity > 0 || ripple < 1)
      ) {
        frameId = requestAnimationFrame(draw);
      }
    }

    function requestDraw() {
      if (!frameId) {
        previousTime = 0;
        frameId = requestAnimationFrame(draw);
      }
    }

    function setActive(active: boolean) {
      targetIntensity = active ? 1 : 0;
      if (active) {
        ripple = 0;
      }
      root.dataset.state = active ? "on" : "off";
      requestDraw();
    }

    function pulse() {
      ripple = 0;
      requestDraw();
    }

    function setPalette(name: string | undefined) {
      const paletteName =
        name && Object.hasOwn(palettes, name) ? name : "spectrum";

      palettes[paletteName].forEach((color, index) => {
        gl!.uniform3fv(uniforms[`uTint${index}`], color);
      });

      root.dataset.palette = paletteName;
    }

    const ditherImage = new Image();
    ditherImage.crossOrigin = "anonymous";
    ditherImage.decoding = "async";
    ditherImage.addEventListener(
      "load",
      () => {
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, ditherTexture);
        gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);
        gl!.texImage2D(
          gl!.TEXTURE_2D,
          0,
          gl!.RGB,
          gl!.RGB,
          gl!.UNSIGNED_BYTE,
          ditherImage,
        );
        requestDraw();
      },
      { once: true, signal: abortController.signal },
    );
    ditherImage.src = root.dataset.ditherSrc || "";

    reducedMotion.addEventListener("change", requestDraw, {
      signal: abortController.signal,
    });

    const resizeObserver = new ResizeObserver(requestDraw);
    resizeObserver.observe(root);

    root.__auraBorder = {
      setActive,
      pulse,
      setPalette,
      destroy() {
        abortController.abort();
        resizeObserver.disconnect();
        cancelAnimationFrame(frameId);
        gl!.deleteTexture(ditherTexture);
        gl!.deleteBuffer(vertexBuffer);
        gl!.deleteProgram(program);
        delete root.__auraBorder;
      },
    };

    resize();
    setPalette(root.dataset.palette);
    draw();
  });
}
