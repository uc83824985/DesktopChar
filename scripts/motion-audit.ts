import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createLocalTtsMcpService } from '../local-tts-mcp/service.mjs';
import {
  createImportanceMotionAuditPlan,
  type Live2dMotionSourceSummary,
  type MotionAuditMotionPlan,
  type MotionAuditSampleReason,
} from '../packages/live2d-renderer/src/motion-audit.ts';

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_RECOVERY_MS = 150;
const DEFAULT_MAX_FRAMES = 144;
const DEFAULT_MAX_FRAMES_PER_MOTION = 32;
const DEFAULT_IMPORTANCE_RADIUS_MS = 150;
const DEFAULT_IMPORTANCE_SAMPLES_PER_MOTION = 6;
const HARD_MAX_FRAMES = 160;
const PARAMETER_EPSILON = 1e-4;
const DRAWABLE_EPSILON = 1 / 255;
const MAX_ACCEPTABLE_TIMING_ERROR_MS = 100;
const MAX_SAMPLE_RESTARTS = 2;

interface AuditOptions {
  outputDirectory: string;
  intervalMs: number;
  recoveryMs: number;
  maxFrames: number;
  maxFramesPerMotion: number;
  importanceRadiusMs: number;
  maxImportanceSamplesPerMotion: number;
  groups: Set<string> | undefined;
  motionIds: Set<string> | undefined;
  viewport: { width: number; height: number };
  headed: boolean;
}

interface AuditDescription {
  schemaVersion: 1;
  characterId: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  resources: Array<{
    id: string;
    group: string;
    index: number;
    file: string;
    source: Live2dMotionSourceSummary;
  }>;
  parameters: Array<{
    id: string;
    minimumValue: number;
    maximumValue: number;
    defaultValue: number;
  }>;
  drawables: string[];
}

interface AuditTelemetry {
  capturedAtMs: number;
  resourceId: string | null;
  motionElapsedMs: number | null;
  motionState: string;
  parameterValues: number[];
  drawableOpacities: number[];
  visibleDrawableCount: number;
  modelBounds: { x: number; y: number; width: number; height: number };
}

interface ExportedSample {
  index: number;
  kind: 'motion' | 'recovery';
  reason: MotionAuditSampleReason;
  targetMs: number;
  importance?: MotionAuditMotionPlan['samples'][number]['importance'];
  actualMotionMs: number | null;
  timingErrorMs: number | null;
  image: string;
  motionState: string;
  visibleDrawableCount: number;
  modelBounds: AuditTelemetry['modelBounds'];
  parameterChanges: Array<{
    id: string;
    baseline: number;
    value: number;
    delta: number;
    normalizedDelta: number | null;
  }>;
  drawableOpacityChanges: Array<{
    id: string;
    baseline: number;
    value: number;
    delta: number;
  }>;
}

const root = process.cwd();
const options = parseOptions(process.argv.slice(2));
if (options.maxFrames > HARD_MAX_FRAMES) {
  throw new RangeError(
    `--max-frames cannot exceed the hard safety limit of ${HARD_MAX_FRAMES}`,
  );
}

await createOutputDirectory(options.outputDirectory);
const ttsService = createLocalTtsMcpService({ port: 0, delayMs: 0, chunkDelayMs: 1 });
const ttsAddress = await ttsService.listen();
const previewPort = await reserveLoopbackPort();
const previewUrl = `http://127.0.0.1:${previewPort}`;
const server = startPreviewServer(previewPort);
let browser: Browser | undefined;
let serverOutput = '';
server.stdout?.on('data', chunk => { serverOutput += String(chunk); });
server.stderr?.on('data', chunk => { serverOutput += String(chunk); });

try {
  await waitForServer(previewUrl, server, 15_000);
  browser = await chromium.launch({ channel: 'msedge', headless: !options.headed });
  const page = await browser.newPage({
    viewport: options.viewport,
    deviceScaleFactor: 1,
  });
  const pageErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      pageErrors.push(message.text());
    }
  });
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  const query = new URLSearchParams({
    motionAudit: '1',
    ttsMcpUrl: ttsAddress.mcpUrl,
  });
  await page.goto(`${previewUrl}/?${query}`, { waitUntil: 'networkidle' });
  await page.locator(
    'body[data-ready="true"][data-motion-audit="ready"]',
  ).waitFor({ timeout: 20_000 });

  const description = await callAudit<AuditDescription>(page, 'describe');
  const resources = description.resources.filter(resource => (
    (!options.groups || options.groups.has(resource.group))
    && (!options.motionIds || options.motionIds.has(resource.id))
  ));
  if (!resources.length) throw new Error('Motion audit selection did not match any resources');
  const selectedIds = new Set(resources.map(resource => resource.id));
  if (options.motionIds) {
    const missing = [...options.motionIds].filter(id => !selectedIds.has(id));
    if (missing.length) throw new Error(`Unknown or filtered motion IDs: ${missing.join(', ')}`);
  }

  const plan = createImportanceMotionAuditPlan(
    resources.map(resource => ({
      id: resource.id,
      durationMs: resource.source.durationMs,
      importanceEvents: resource.source.importance.events,
    })),
    {
      intervalMs: options.intervalMs,
      recoveryMs: options.recoveryMs,
      maxFrames: options.maxFrames,
      maxFramesPerMotion: options.maxFramesPerMotion,
      importanceRadiusMs: options.importanceRadiusMs,
      maxImportanceSamplesPerMotion: options.maxImportanceSamplesPerMotion,
    },
  );
  await writeJson(path.join(options.outputDirectory, 'sample-plan.json'), {
    schemaVersion: 1,
    strategy: 'fixed-cadence+curve-importance',
    options: publicOptions(options),
    ...plan,
  });

  const exportedMotions = [];
  for (const motionPlan of plan.motions) {
    const resource = resources.find(candidate => candidate.id === motionPlan.id)!;
    process.stdout.write(
      `[motion-audit] ${resource.id} ${resource.file} · ${motionPlan.samples.length}/${motionPlan.requestedCount} frames\n`,
    );
    const motionDirectoryName = safeName(`${resource.group}-${resource.index}-${fileStem(resource.file)}`);
    const frameDirectory = path.join(options.outputDirectory, 'frames', motionDirectoryName);
    await mkdir(frameDirectory, { recursive: true });
    const baseline = await callAudit<AuditTelemetry>(page, 'prepare');
    await callAudit<AuditTelemetry>(page, 'startMotion', resource.id);
    const samples: ExportedSample[] = [];
    let finished = false;
    for (let sampleIndex = 0; sampleIndex < motionPlan.samples.length; sampleIndex++) {
      const point = motionPlan.samples[sampleIndex]!;
      const telemetry = point.kind === 'motion'
        ? await sampleMotionAtWithRestart(page, resource.id, point.targetMs)
        : await callAudit<AuditTelemetry>(page, 'finish', options.recoveryMs);
      if (point.kind === 'recovery') finished = true;
      const imageName = `${String(sampleIndex).padStart(3, '0')}-${point.kind}-${String(Math.round(point.targetMs)).padStart(6, '0')}ms.png`;
      const imagePath = path.join(frameDirectory, imageName);
      await page.screenshot({ path: imagePath, omitBackground: true });
      samples.push(toExportedSample(
        sampleIndex,
        point,
        imagePath,
        telemetry,
        baseline,
        description,
        options.outputDirectory,
      ));
    }
    if (!finished) await callAudit<AuditTelemetry>(page, 'finish', 0);

    const contactSheetPath = path.join(
      options.outputDirectory,
      'contact-sheets',
      `${motionDirectoryName}.png`,
    );
    await mkdir(path.dirname(contactSheetPath), { recursive: true });
    await createContactSheet(
      browser,
      options.outputDirectory,
      contactSheetPath,
      resource,
      samples,
    );
    exportedMotions.push({
      resource: {
        id: resource.id,
        group: resource.group,
        index: resource.index,
        file: resource.file,
      },
      source: {
        ...resource.source,
        curves: resource.source.curves.filter(curve => curve.valueSpan > PARAMETER_EPSILON),
      },
      sampling: {
        requestedCount: motionPlan.requestedCount,
        exportedCount: samples.length,
        omittedCount: motionPlan.omittedCount,
        omittedSamples: motionPlan.omittedSamples,
      },
      contactSheet: relativeArtifact(options.outputDirectory, contactSheetPath),
      observedParameterRanges: observedParameterRanges(samples),
      samples,
    });
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strategy: 'fixed-cadence+curve-importance',
    character: {
      id: description.characterId,
      viewport: description.viewport,
    },
    configuration: publicOptions(options),
    budget: {
      hardMaximumFrames: HARD_MAX_FRAMES,
      requestedFrames: plan.requestedFrames,
      exportedFrames: plan.exportedFrames,
      omittedFrames: plan.omittedFrames,
    },
    parameterDefinitions: description.parameters,
    drawableIds: description.drawables,
    motions: exportedMotions,
  };
  await writeJson(path.join(options.outputDirectory, 'manifest.json'), manifest);
  await writeFile(
    path.join(options.outputDirectory, 'agent-brief.md'),
    agentBrief(manifest),
    'utf8',
  );
  if (pageErrors.length) {
    await writeJson(path.join(options.outputDirectory, 'browser-errors.json'), pageErrors);
    throw new Error(`Motion audit browser reported errors:\n${pageErrors.join('\n')}`);
  }
  process.stdout.write(
    `[motion-audit] exported ${plan.exportedFrames} frames for ${exportedMotions.length} motions\n`
      + `[motion-audit] ${path.join(options.outputDirectory, 'agent-brief.md')}\n`,
  );
}
catch (error) {
  if (serverOutput.trim()) process.stderr.write(`${serverOutput.trim()}\n`);
  throw error;
}
finally {
  await browser?.close();
  server.kill();
  await ttsService.close();
}

function parseOptions(args: string[]): AuditOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--help') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--headed') {
      flags.add(argument);
      continue;
    }
    if (!argument.startsWith('--')) throw new TypeError(`Unexpected argument: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${argument} requires a value`);
    values.set(argument, value);
  }
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z');
  const output = values.get('--output')
    ?? path.join('artifacts', 'motion-audit', `audit-${timestamp}`);
  return {
    outputDirectory: path.resolve(root, output),
    intervalMs: integerOption(values, '--interval-ms', DEFAULT_INTERVAL_MS, 50, 10_000),
    recoveryMs: integerOption(values, '--recovery-ms', DEFAULT_RECOVERY_MS, 0, 5_000),
    maxFrames: integerOption(values, '--max-frames', DEFAULT_MAX_FRAMES, 1, HARD_MAX_FRAMES),
    maxFramesPerMotion: integerOption(
      values,
      '--max-frames-per-motion',
      DEFAULT_MAX_FRAMES_PER_MOTION,
      1,
      64,
    ),
    importanceRadiusMs: integerOption(
      values,
      '--importance-radius-ms',
      DEFAULT_IMPORTANCE_RADIUS_MS,
      0,
      250,
    ),
    maxImportanceSamplesPerMotion: integerOption(
      values,
      '--importance-samples-per-motion',
      DEFAULT_IMPORTANCE_SAMPLES_PER_MOTION,
      0,
      12,
    ),
    groups: commaSet(values.get('--groups')),
    motionIds: commaSet(values.get('--motions')),
    viewport: viewportOption(values.get('--viewport') ?? '720x900'),
    headed: flags.has('--headed'),
  };
}

function printHelp(): void {
  process.stdout.write(`DesktopChar bounded Live2D motion audit

Usage:
  npm run motion:audit -- [options]

Options:
  --output PATH                  Output directory (must not already exist)
  --interval-ms N                Requested motion cadence, default 500
  --recovery-ms N                Baseline recovery delay, default 150
  --max-frames N                 Global budget, default 144, hard max ${HARD_MAX_FRAMES}
  --max-frames-per-motion N      Per-motion budget, default 32
  --importance-radius-ms N       Before/after radius for curve events, default 150
  --importance-samples-per-motion N
                                 Maximum supplemental frames per motion, default 6; 0 disables
  --groups Idle,TapBody          Include only these model3 motion groups
  --motions TapBody:0,TapBody:1  Include only these resource IDs
  --viewport WIDTHxHEIGHT         Capture viewport, default 720x900
  --headed                       Show Edge while capturing
`);
}

function publicOptions(value: AuditOptions) {
  return {
    intervalMs: value.intervalMs,
    recoveryMs: value.recoveryMs,
    maxFrames: value.maxFrames,
    maxFramesPerMotion: value.maxFramesPerMotion,
    importanceRadiusMs: value.importanceRadiusMs,
    maxImportanceSamplesPerMotion: value.maxImportanceSamplesPerMotion,
    groups: value.groups ? [...value.groups] : null,
    motionIds: value.motionIds ? [...value.motionIds] : null,
    viewport: value.viewport,
  };
}

async function createOutputDirectory(directory: string): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
}

async function callAudit<T>(
  page: Page,
  method: 'describe' | 'prepare' | 'startMotion' | 'sampleAt' | 'finish',
  argument?: string | number,
): Promise<T> {
  return page.evaluate(async ({ method, argument }) => {
    const api = (window as Window & {
      desktopCharMotionAudit?: Record<string, (...args: never[]) => Promise<unknown>>;
    }).desktopCharMotionAudit;
    if (!api) throw new Error('DesktopChar motion audit API is unavailable');
    const target = api[method];
    if (typeof target !== 'function') throw new Error(`Motion audit method is unavailable: ${method}`);
    return argument === undefined ? target() : target(argument as never);
  }, { method, argument }) as Promise<T>;
}

async function sampleMotionAtWithRestart(
  page: Page,
  resourceId: string,
  targetMs: number,
): Promise<AuditTelemetry> {
  for (let restartCount = 0; restartCount <= MAX_SAMPLE_RESTARTS; restartCount++) {
    const telemetry = await callAudit<AuditTelemetry>(page, 'sampleAt', targetMs);
    const timingErrorMs = telemetry.motionElapsedMs === null
      ? Number.POSITIVE_INFINITY
      : telemetry.motionElapsedMs - targetMs;
    if (timingErrorMs <= MAX_ACCEPTABLE_TIMING_ERROR_MS) return telemetry;
    if (restartCount >= MAX_SAMPLE_RESTARTS) {
      throw new Error(
        `Motion audit ${resourceId} missed ${targetMs}ms by ${timingErrorMs.toFixed(1)}ms after ${MAX_SAMPLE_RESTARTS} restarts`,
      );
    }
    process.stdout.write(
      `[motion-audit] ${resourceId} timing miss ${timingErrorMs.toFixed(1)}ms at ${targetMs}ms; restarting playback (${restartCount + 1}/${MAX_SAMPLE_RESTARTS})\n`,
    );
    await callAudit<AuditTelemetry>(page, 'finish', 0);
    await callAudit<AuditTelemetry>(page, 'prepare');
    await callAudit<AuditTelemetry>(page, 'startMotion', resourceId);
  }
  throw new Error(`Motion audit ${resourceId} could not sample ${targetMs}ms`);
}

function toExportedSample(
  index: number,
  point: MotionAuditMotionPlan['samples'][number],
  imagePath: string,
  telemetry: AuditTelemetry,
  baseline: AuditTelemetry,
  description: AuditDescription,
  outputDirectory: string,
): ExportedSample {
  const parameterChanges = telemetry.parameterValues.flatMap((value, parameterIndex) => {
    const baselineValue = baseline.parameterValues[parameterIndex]!;
    const delta = value - baselineValue;
    if (Math.abs(delta) <= PARAMETER_EPSILON) return [];
    const definition = description.parameters[parameterIndex]!;
    const range = definition.maximumValue - definition.minimumValue;
    return [{
      id: definition.id,
      baseline: baselineValue,
      value,
      delta,
      normalizedDelta: range > PARAMETER_EPSILON ? delta / range : null,
    }];
  });
  const drawableOpacityChanges = telemetry.drawableOpacities.flatMap((value, drawableIndex) => {
    const baselineValue = baseline.drawableOpacities[drawableIndex]!;
    const delta = value - baselineValue;
    if (Math.abs(delta) <= DRAWABLE_EPSILON) return [];
    return [{
      id: description.drawables[drawableIndex]!,
      baseline: baselineValue,
      value,
      delta,
    }];
  });
  return {
    index,
    kind: point.kind,
    reason: point.reason,
    targetMs: point.targetMs,
    ...(point.importance ? { importance: point.importance } : {}),
    actualMotionMs: telemetry.motionElapsedMs,
    timingErrorMs: point.kind === 'motion' && telemetry.motionElapsedMs !== null
      ? telemetry.motionElapsedMs - point.targetMs
      : null,
    image: relativeArtifact(outputDirectory, imagePath),
    motionState: telemetry.motionState,
    visibleDrawableCount: telemetry.visibleDrawableCount,
    modelBounds: telemetry.modelBounds,
    parameterChanges,
    drawableOpacityChanges,
  };
}

function observedParameterRanges(samples: ExportedSample[]) {
  const ranges = new Map<string, {
    id: string;
    minimumValue: number;
    maximumValue: number;
    maximumAbsoluteDelta: number;
    activeSampleCount: number;
  }>();
  for (const sample of samples) {
    for (const change of sample.parameterChanges) {
      const current = ranges.get(change.id) ?? {
        id: change.id,
        minimumValue: change.value,
        maximumValue: change.value,
        maximumAbsoluteDelta: 0,
        activeSampleCount: 0,
      };
      current.minimumValue = Math.min(current.minimumValue, change.value);
      current.maximumValue = Math.max(current.maximumValue, change.value);
      current.maximumAbsoluteDelta = Math.max(current.maximumAbsoluteDelta, Math.abs(change.delta));
      current.activeSampleCount++;
      ranges.set(change.id, current);
    }
  }
  return [...ranges.values()].sort((left, right) =>
    right.maximumAbsoluteDelta - left.maximumAbsoluteDelta);
}

async function createContactSheet(
  browser: Browser,
  outputDirectory: string,
  outputPath: string,
  resource: AuditDescription['resources'][number],
  samples: ExportedSample[],
): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1_180, height: 800 } });
  try {
    const cards = await Promise.all(samples.map(async sample => {
      const bytes = await readFile(path.join(outputDirectory, sample.image));
      const actual = sample.actualMotionMs === null
        ? 'baseline recovery'
        : `${(sample.actualMotionMs / 1_000).toFixed(2)}s actual`;
      const importance = sample.importance
        ? `<br />importance ${sample.importance.score.toFixed(0)}
          · event ${(sample.importance.sourceEventMs / 1_000).toFixed(2)}s`
        : '';
      return `<figure${sample.importance ? ' class="importance"' : ''}>
        <img src="data:image/png;base64,${bytes.toString('base64')}" />
        <figcaption>#${String(sample.index).padStart(2, '0')} · ${sample.reason}<br />
          target ${(sample.targetMs / 1_000).toFixed(2)}s · ${actual}${importance}</figcaption>
      </figure>`;
    }));
    await page.setContent(`<!doctype html>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 24px; color: #f4f1ff; background: #17151f;
          font-family: Inter, "Microsoft YaHei", sans-serif; }
        h1 { margin: 0 0 5px; font-size: 24px; }
        p { margin: 0 0 18px; color: #bdb5d1; font-size: 13px; }
        main { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
        figure { margin: 0; overflow: hidden; border: 1px solid #ffffff1f;
          border-radius: 10px; background: #24212d; }
        figure.importance { border-color: #a98af0; }
        img { display: block; width: 100%; aspect-ratio: 4 / 5; object-fit: contain;
          background: repeating-conic-gradient(#302d38 0 25%, #292630 0 50%) 50% / 18px 18px; }
        figcaption { min-height: 48px; padding: 7px 9px; color: #d8d2e4;
          font-size: 10px; line-height: 1.45; font-variant-numeric: tabular-nums; }
      </style>
      <h1>${escapeHtml(resource.id)} · ${escapeHtml(fileStem(resource.file))}</h1>
      <p>${(resource.source.durationMs / 1_000).toFixed(2)}s · ${resource.source.fps}fps authored
        · ${samples.length} exported frames</p>
      <main>${cards.join('')}</main>`);
    await page.screenshot({ path: outputPath, fullPage: true });
  }
  finally {
    await page.close();
  }
}

function agentBrief(manifest: {
  generatedAt: string;
  strategy: string;
  character: { id: string };
  budget: {
    requestedFrames: number;
    exportedFrames: number;
    omittedFrames: number;
    hardMaximumFrames: number;
  };
  motions: Array<{
    resource: { id: string; file: string };
    source: {
      durationMs: number;
      dynamicCurveCount: number;
      importance: { events: unknown[] };
    };
    sampling: { exportedCount: number; omittedCount: number };
    contactSheet: string;
    observedParameterRanges: Array<{ id: string }>;
    samples: Array<{ importance?: unknown }>;
  }>;
}): string {
  const rows = manifest.motions.map(motion =>
    `| \`${motion.resource.id}\` | \`${motion.resource.file}\` | ${(motion.source.durationMs / 1_000).toFixed(2)}s | ${motion.source.importance.events.length} | ${motion.samples.filter(sample => sample.importance).length} | ${motion.sampling.exportedCount} | ${motion.sampling.omittedCount} | [contact sheet](${motion.contactSheet.replaceAll('\\', '/')}) |`,
  ).join('\n');
  return `# Motion audit agent brief

- Character: \`${manifest.character.id}\`
- Generated: ${manifest.generatedAt}
- Strategy: \`${manifest.strategy}\`
- Frame budget: ${manifest.budget.exportedFrames}/${manifest.budget.requestedFrames} exported,
  ${manifest.budget.omittedFrames} omitted, hard maximum ${manifest.budget.hardMaximumFrames}

## Token-conscious review order

1. Inspect one contact sheet per motion first.
2. Purple-bordered cards are deterministic supplemental samples generated before Agent review.
3. Read \`manifest.json\` for each supplemental sample's score, signals, source event and curves.
4. Inspect omitted importance samples before concluding that a fast event does not exist.
5. Open an individual full-resolution frame only when a contact-sheet thumbnail is ambiguous.
6. Treat semantic labels and phase boundaries inferred from images as proposals requiring review.

| Resource | File | Duration | Curve events | Supplemental | Frames | Omitted | Primary visual artifact |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
${rows}
`;
}

function startPreviewServer(port: number): ChildProcess {
  return spawn(process.execPath, [
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    'apps/desktop',
    '--config',
    'apps/desktop/vite.config.ts',
    '--port',
    String(port),
    '--strictPort',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback port'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url: string, server: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited with code ${server.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview did not start within ${timeoutMs}ms`);
}

function integerOption(
  values: Map<string, string>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function commaSet(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!entries.length) throw new TypeError('Comma-separated filters must not be empty');
  return new Set(entries);
}

function viewportOption(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/u.exec(value);
  if (!match) throw new TypeError('--viewport must use WIDTHxHEIGHT');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || width > 2_048 || height < 320 || height > 2_048) {
    throw new RangeError('--viewport dimensions must be from 320 to 2048');
  }
  return { width, height };
}

function safeName(value: string): string {
  return value.replaceAll(':', '-').replace(/[^a-zA-Z0-9._-]+/gu, '-');
}

function fileStem(file: string): string {
  return path.basename(file).replace(/\.motion3\.json$/u, '');
}

function relativeArtifact(rootDirectory: string, target: string): string {
  return path.relative(rootDirectory, target).split(path.sep).join('/');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
