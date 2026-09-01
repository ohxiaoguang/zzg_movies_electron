(function exposeFilmVrRenderer() {
  const MAX_PITCH = 85 * Math.PI / 180;
  const VERTEX_SHADER = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  const FRAGMENT_SHADER = `
    precision highp float;
    varying vec2 v_uv;
    uniform sampler2D u_video;
    uniform float u_aspect;
    uniform float u_tan_half_fov;
    uniform float u_yaw;
    uniform float u_pitch;
    const float PI = 3.141592653589793;
    void main() {
      vec2 screen = v_uv * 2.0 - 1.0;
      vec3 direction = normalize(vec3(
        screen.x * u_aspect * u_tan_half_fov,
        screen.y * u_tan_half_fov,
        -1.0
      ));
      float pitchCos = cos(u_pitch);
      float pitchSin = sin(u_pitch);
      direction = vec3(
        direction.x,
        pitchCos * direction.y - pitchSin * direction.z,
        pitchSin * direction.y + pitchCos * direction.z
      );
      float yawCos = cos(u_yaw);
      float yawSin = sin(u_yaw);
      direction = vec3(
        yawCos * direction.x - yawSin * direction.z,
        direction.y,
        yawSin * direction.x + yawCos * direction.z
      );
      vec2 panoramaUv = vec2(
        0.5 + atan(direction.x, -direction.z) / (2.0 * PI),
        0.5 + asin(clamp(direction.y, -1.0, 1.0)) / PI
      );
      gl_FragColor = texture2D(u_video, panoramaUv);
    }
  `;

  class FilmVrRenderer {
    constructor(video, canvas, onError) {
      this.video = video;
      this.canvas = canvas;
      this.onError = onError;
      this.disposed = false;
      this.frameId = 0;
      this.pointerId = null;
      this.yaw = 0;
      this.pitch = 0;
      this.fovDegrees = 75;
      this.textureErrorReported = false;
      this.pointerStart = { x: 0, y: 0, yaw: 0, pitch: 0 };
      const gl = canvas.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WEBGL_UNAVAILABLE');
      this.gl = gl;
      this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
      this.buffer = gl.createBuffer();
      this.texture = gl.createTexture();
      if (!this.buffer || !this.texture) throw new Error('WEBGL_RESOURCE_CREATION_FAILED');
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.uniform1i(requiredUniform(gl, this.program, 'u_video'), 0);
      this.uniforms = {
        aspect: requiredUniform(gl, this.program, 'u_aspect'),
        tanHalfFov: requiredUniform(gl, this.program, 'u_tan_half_fov'),
        yaw: requiredUniform(gl, this.program, 'u_yaw'),
        pitch: requiredUniform(gl, this.program, 'u_pitch'),
      };
      this.onPointerDown = (event) => {
        if (event.button !== 0 || this.pointerId !== null) return;
        this.pointerId = event.pointerId;
        this.pointerStart = { x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('dragging');
      };
      this.onPointerMove = (event) => {
        if (event.pointerId !== this.pointerId) return;
        this.yaw = this.pointerStart.yaw - (event.clientX - this.pointerStart.x) * .005;
        this.pitch = clamp(this.pointerStart.pitch + (event.clientY - this.pointerStart.y) * .005, -MAX_PITCH, MAX_PITCH);
      };
      this.onPointerUp = (event) => {
        if (event.pointerId !== this.pointerId) return;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        this.pointerId = null;
        canvas.classList.remove('dragging');
      };
      this.onWheel = (event) => {
        event.preventDefault();
        this.fovDegrees = clamp(this.fovDegrees + event.deltaY * .04, 30, 100);
      };
      canvas.style.touchAction = 'none';
      canvas.addEventListener('pointerdown', this.onPointerDown);
      canvas.addEventListener('pointermove', this.onPointerMove);
      canvas.addEventListener('pointerup', this.onPointerUp);
      canvas.addEventListener('pointercancel', this.onPointerUp);
      canvas.addEventListener('wheel', this.onWheel, { passive: false });
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
      this.render = () => {
        if (this.disposed) return;
        this.resize();
        if (video.readyState >= 2 && !this.textureErrorReported) {
          try {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          } catch (error) {
            this.textureErrorReported = true;
            onError?.(error instanceof Error ? error.message : 'VR_VIDEO_TEXTURE_FAILED');
          }
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(this.program);
        gl.uniform1f(this.uniforms.aspect, canvas.width / Math.max(1, canvas.height));
        gl.uniform1f(this.uniforms.tanHalfFov, Math.tan(this.fovDegrees * Math.PI / 360));
        gl.uniform1f(this.uniforms.yaw, this.yaw);
        gl.uniform1f(this.uniforms.pitch, this.pitch);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        this.frameId = requestAnimationFrame(this.render);
      };
      this.resize();
      this.frameId = requestAnimationFrame(this.render);
    }

    resetView() {
      this.yaw = 0;
      this.pitch = 0;
      this.fovDegrees = 75;
    }

    setView(view) {
      if (!view) return this.resetView();
      this.yaw = normalizeDegrees(view.yawDegrees) * Math.PI / 180;
      this.pitch = clamp(view.pitchDegrees * Math.PI / 180, -MAX_PITCH, MAX_PITCH);
      this.fovDegrees = clamp(view.fovDegrees, 30, 100);
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      cancelAnimationFrame(this.frameId);
      this.resizeObserver.disconnect();
      this.canvas.removeEventListener('pointerdown', this.onPointerDown);
      this.canvas.removeEventListener('pointermove', this.onPointerMove);
      this.canvas.removeEventListener('pointerup', this.onPointerUp);
      this.canvas.removeEventListener('pointercancel', this.onPointerUp);
      this.canvas.removeEventListener('wheel', this.onWheel);
      this.gl.deleteTexture(this.texture);
      this.gl.deleteBuffer(this.buffer);
      this.gl.deleteProgram(this.program);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
    }
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('WEBGL_PROGRAM_CREATION_FAILED');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WEBGL_PROGRAM_LINK_FAILED');
    return program;
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('WEBGL_SHADER_CREATION_FAILED');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'WEBGL_SHADER_COMPILE_FAILED');
    return shader;
  }

  function requiredUniform(gl, program, name) {
    const location = gl.getUniformLocation(program, name);
    if (!location) throw new Error(`WEBGL_UNIFORM_MISSING:${name}`);
    return location;
  }

  function normalizeDegrees(value) {
    return ((value + 180) % 360 + 360) % 360 - 180;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  window.FilmVrRenderer = FilmVrRenderer;
})();
