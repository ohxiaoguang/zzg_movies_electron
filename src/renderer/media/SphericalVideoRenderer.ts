const MAX_PITCH_RADIANS = (85 * Math.PI) / 180;
const MIN_FOV_DEGREES = 30;
const MAX_FOV_DEGREES = 100;

export function clampSphericalPitch(value: number): number {
  return Math.max(-MAX_PITCH_RADIANS, Math.min(MAX_PITCH_RADIANS, value));
}

export function clampSphericalFov(value: number): number {
  return Math.max(MIN_FOV_DEGREES, Math.min(MAX_FOV_DEGREES, value));
}

export class SphericalVideoRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly resizeObserver: ResizeObserver;
  private readonly uniforms: {
    aspect: WebGLUniformLocation;
    tanHalfFov: WebGLUniformLocation;
    yaw: WebGLUniformLocation;
    pitch: WebGLUniformLocation;
  };
  private frameId = 0;
  private disposed = false;
  private pointerId: number | null = null;
  private pointerStart = { x: 0, y: 0, yaw: 0, pitch: 0 };
  private yaw = 0;
  private pitch = 0;
  private fovDegrees = 75;
  private textureErrorReported = false;

  public constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly onError?: (message: string) => void,
  ) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WEBGL_UNAVAILABLE');
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!buffer || !texture) throw new Error('WEBGL_RESOURCE_CREATION_FAILED');
    this.buffer = buffer;
    this.texture = texture;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1,
    ]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    const sampler = requiredUniform(gl, this.program, 'u_video');
    gl.uniform1i(sampler, 0);
    this.uniforms = {
      aspect: requiredUniform(gl, this.program, 'u_aspect'),
      tanHalfFov: requiredUniform(gl, this.program, 'u_tan_half_fov'),
      yaw: requiredUniform(gl, this.program, 'u_yaw'),
      pitch: requiredUniform(gl, this.program, 'u_pitch'),
    };

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frameId = requestAnimationFrame(this.renderFrame);
  }

  public resetView(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.fovDegrees = 75;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.pointerStart = {
      x: event.clientX,
      y: event.clientY,
      yaw: this.yaw,
      pitch: this.pitch,
    };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add('dragging');
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.yaw = this.pointerStart.yaw - (event.clientX - this.pointerStart.x) * 0.005;
    this.pitch = clampSphericalPitch(
      this.pointerStart.pitch + (event.clientY - this.pointerStart.y) * 0.005,
    );
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.canvas.classList.remove('dragging');
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.fovDegrees = clampSphericalFov(this.fovDegrees + event.deltaY * 0.04);
  };

  private readonly renderFrame = (): void => {
    if (this.disposed) return;
    this.resize();
    const gl = this.gl;
    if (this.video.readyState >= 2 && !this.textureErrorReported) {
      try {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      } catch (error) {
        this.textureErrorReported = true;
        this.onError?.(error instanceof Error ? error.message : 'VR_VIDEO_TEXTURE_FAILED');
      }
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.aspect, this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform1f(this.uniforms.tanHalfFov, Math.tan((this.fovDegrees * Math.PI) / 360));
    gl.uniform1f(this.uniforms.yaw, this.yaw);
    gl.uniform1f(this.uniforms.pitch, this.pitch);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.frameId = requestAnimationFrame(this.renderFrame);
  };

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('WEBGL_PROGRAM_CREATION_FAILED');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WEBGL_PROGRAM_LINK_FAILED';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WEBGL_SHADER_CREATION_FAILED');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WEBGL_SHADER_COMPILE_FAILED';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function requiredUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`WEBGL_UNIFORM_MISSING:${name}`);
  return location;
}

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
