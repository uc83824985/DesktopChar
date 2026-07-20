export interface PixelPoint {
  x: number;
  y: number;
}

export type PixelRgba = readonly [red: number, green: number, blue: number, alpha: number];

export interface PixelCoverageResult {
  sequence: number;
  point: PixelPoint;
  rgba: PixelRgba;
  covered: boolean;
  submittedFrame: number;
  resolvedFrame: number;
  latencyFrames: number;
}

export type PixelReadbackPoll =
  | { status: 'pending' }
  | { status: 'ready'; rgba: PixelRgba }
  | { status: 'failed'; error: Error };

export interface PixelReadbackTicket {
  poll(): PixelReadbackPoll;
  dispose(): void;
}

export interface PixelReadbackBackend {
  issue(point: PixelPoint): PixelReadbackTicket;
}

export interface AsyncPixelCoveragePickerOptions {
  alphaThreshold?: number;
  maximumPendingReads?: number;
  onResult(result: PixelCoverageResult): void;
  onError?(error: Error): void;
}

interface QueuedRead {
  sequence: number;
  point: PixelPoint;
}

interface PendingRead extends QueuedRead {
  submittedFrame: number;
  ticket: PixelReadbackTicket;
}

/**
 * Coalesces cursor samples and only publishes a readback that still belongs to
 * the newest cursor point. GPU completion is polled from later render frames.
 */
export class AsyncPixelCoveragePicker {
  private readonly backend: PixelReadbackBackend;
  private readonly options: Required<Pick<AsyncPixelCoveragePickerOptions, 'alphaThreshold' | 'maximumPendingReads'>>
    & Omit<AsyncPixelCoveragePickerOptions, 'alphaThreshold' | 'maximumPendingReads'>;
  private readonly pending: PendingRead[] = [];
  private queued: QueuedRead | undefined;
  private sequence = 0;
  private frame = 0;
  private disposed = false;

  constructor(backend: PixelReadbackBackend, options: AsyncPixelCoveragePickerOptions) {
    const alphaThreshold = options.alphaThreshold ?? 8 / 255;
    if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 1) {
      throw new RangeError('Pixel alphaThreshold must be between 0 and 1');
    }
    const maximumPendingReads = options.maximumPendingReads ?? 3;
    if (!Number.isInteger(maximumPendingReads) || maximumPendingReads < 1) {
      throw new RangeError('maximumPendingReads must be a positive integer');
    }
    this.backend = backend;
    this.options = { ...options, alphaThreshold, maximumPendingReads };
  }

  request(point: PixelPoint): number {
    this.requireActive();
    validatePoint(point);
    const active = this.queued ?? this.pending.find(read => read.sequence === this.sequence);
    if (active && samePoint(active.point, point)) return active.sequence;
    const sequence = ++this.sequence;
    this.queued = { sequence, point: { ...point } };
    return sequence;
  }

  invalidate(): void {
    if (this.disposed) return;
    ++this.sequence;
    this.queued = undefined;
  }

  afterRender(): void {
    if (this.disposed) return;
    ++this.frame;
    this.pollPending();
    this.issueQueued();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queued = undefined;
    for (const read of this.pending) read.ticket.dispose();
    this.pending.length = 0;
  }

  private pollPending(): void {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const read = this.pending[index]!;
      const result = read.ticket.poll();
      if (result.status === 'pending') continue;
      read.ticket.dispose();
      this.pending.splice(index, 1);
      if (result.status === 'failed') {
        if (read.sequence === this.sequence) this.options.onError?.(result.error);
        continue;
      }
      if (read.sequence !== this.sequence) continue;
      const alpha = result.rgba[3] / 255;
      this.options.onResult({
        sequence: read.sequence,
        point: read.point,
        rgba: result.rgba,
        covered: result.rgba[3] > 0 && alpha >= this.options.alphaThreshold,
        submittedFrame: read.submittedFrame,
        resolvedFrame: this.frame,
        latencyFrames: this.frame - read.submittedFrame,
      });
    }
  }

  private issueQueued(): void {
    const read = this.queued;
    if (!read) return;
    this.queued = undefined;
    try {
      this.pending.push({ ...read, submittedFrame: this.frame, ticket: this.backend.issue(read.point) });
    }
    catch (cause) {
      if (read.sequence === this.sequence) this.options.onError?.(asError(cause));
      return;
    }
    while (this.pending.length > this.options.maximumPendingReads) {
      this.pending.shift()!.ticket.dispose();
    }
  }

  private requireActive(): void {
    if (this.disposed) throw new Error('Pixel picker is disposed');
  }
}

export interface WebGLPixelReadbackBackendOptions {
  /** Restore/bind the final composited framebuffer immediately before sampling. */
  prepareReadback?: () => void;
}

/** Reads exactly one device pixel from the final WebGL framebuffer. */
export class WebGLPixelReadbackBackend implements PixelReadbackBackend {
  readonly readbackMode: 'async-pbo' | 'sync-one-pixel';
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly prepareReadback: (() => void) | undefined;

  constructor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    canvas: HTMLCanvasElement,
    options: WebGLPixelReadbackBackendOptions = {},
  ) {
    this.gl = gl;
    this.canvas = canvas;
    this.prepareReadback = options.prepareReadback;
    this.readbackMode = supportsAsyncPixelReadback(gl) ? 'async-pbo' : 'sync-one-pixel';
  }

  issue(point: PixelPoint): PixelReadbackTicket {
    if (this.gl.isContextLost()) return failedTicket(new Error('WebGL context is lost'));
    const rect = this.canvas.getBoundingClientRect();
    const pixel = toFramebufferPixel(point, rect, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
    if (!pixel) return readyTicket([0, 0, 0, 0]);
    this.prepareReadback?.();
    return this.readbackMode === 'async-pbo' && supportsAsyncPixelReadback(this.gl)
      ? issueAsyncReadback(this.gl, pixel.x, pixel.y)
      : issueSynchronousReadback(this.gl, pixel.x, pixel.y);
  }
}

export function toFramebufferPixel(
  point: PixelPoint,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  drawingBufferWidth: number,
  drawingBufferHeight: number,
): PixelPoint | undefined {
  validatePoint(point);
  if (
    !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0
    || !Number.isInteger(drawingBufferWidth) || !Number.isInteger(drawingBufferHeight)
    || drawingBufferWidth <= 0 || drawingBufferHeight <= 0
  ) {
    throw new RangeError('Framebuffer and canvas dimensions must be positive and finite');
  }
  const normalizedX = (point.x - rect.left) / rect.width;
  const normalizedY = (point.y - rect.top) / rect.height;
  if (normalizedX < 0 || normalizedY < 0 || normalizedX >= 1 || normalizedY >= 1) return undefined;
  return {
    x: Math.min(drawingBufferWidth - 1, Math.floor(normalizedX * drawingBufferWidth)),
    y: Math.min(drawingBufferHeight - 1, drawingBufferHeight - 1 - Math.floor(normalizedY * drawingBufferHeight)),
  };
}

function issueSynchronousReadback(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  x: number,
  y: number,
): PixelReadbackTicket {
  const bytes = new Uint8Array(4);
  try {
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return readyTicket(asRgba(bytes));
  }
  catch (cause) {
    return failedTicket(asError(cause));
  }
}

function issueAsyncReadback(gl: WebGL2RenderingContext, x: number, y: number): PixelReadbackTicket {
  const buffer = gl.createBuffer();
  if (!buffer) return failedTicket(new Error('Unable to allocate pixel pack buffer'));
  const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
  }
  catch (cause) {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    gl.deleteBuffer(buffer);
    return failedTicket(asError(cause));
  }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) {
    gl.deleteBuffer(buffer);
    return failedTicket(new Error('Unable to create pixel readback fence'));
  }
  gl.flush();
  return new WebGL2PixelReadbackTicket(gl, buffer, sync);
}

class WebGL2PixelReadbackTicket implements PixelReadbackTicket {
  private readonly bytes = new Uint8Array(4);
  private disposed = false;
  private readonly gl: WebGL2RenderingContext;
  private readonly buffer: WebGLBuffer;
  private readonly sync: WebGLSync;

  constructor(
    gl: WebGL2RenderingContext,
    buffer: WebGLBuffer,
    sync: WebGLSync,
  ) {
    this.gl = gl;
    this.buffer = buffer;
    this.sync = sync;
  }

  poll(): PixelReadbackPoll {
    if (this.disposed) return { status: 'failed', error: new Error('Pixel readback ticket is disposed') };
    if (this.gl.isContextLost()) return { status: 'failed', error: new Error('WebGL context was lost during pixel readback') };
    const status = this.gl.clientWaitSync(this.sync, 0, 0);
    if (status === this.gl.TIMEOUT_EXPIRED) return { status: 'pending' };
    if (status === this.gl.WAIT_FAILED) return { status: 'failed', error: new Error('Pixel readback fence wait failed') };
    const previous = this.gl.getParameter(this.gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, this.buffer);
      this.gl.getBufferSubData(this.gl.PIXEL_PACK_BUFFER, 0, this.bytes);
      return { status: 'ready', rgba: asRgba(this.bytes) };
    }
    catch (cause) {
      return { status: 'failed', error: asError(cause) };
    }
    finally {
      this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, previous);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteSync(this.sync);
    this.gl.deleteBuffer(this.buffer);
  }
}

function readyTicket(rgba: PixelRgba): PixelReadbackTicket {
  return {
    poll: () => ({ status: 'ready', rgba }),
    dispose: () => undefined,
  };
}

function failedTicket(error: Error): PixelReadbackTicket {
  return {
    poll: () => ({ status: 'failed', error }),
    dispose: () => undefined,
  };
}

function supportsAsyncPixelReadback(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): gl is WebGL2RenderingContext {
  return typeof (gl as WebGL2RenderingContext).fenceSync === 'function'
    && typeof (gl as WebGL2RenderingContext).getBufferSubData === 'function'
    && 'PIXEL_PACK_BUFFER' in gl;
}

function asRgba(bytes: Uint8Array): PixelRgba {
  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
}

function validatePoint(point: PixelPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError('Pixel point must be finite');
}

function samePoint(left: PixelPoint, right: PixelPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
